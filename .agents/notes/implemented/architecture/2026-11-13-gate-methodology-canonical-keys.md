# Agent Note: Gate 方法论的 canonical phase/node 键

Status: implemented

工作项：让 `GATE_METHODOLOGY` 的段名与真实 phase/node 对齐，并让当前 procedure 明确给出 `methodologyKey`。本 Note 不改变阶段转换、procedure 步骤或权限。

## Problem

`GATE_METHODOLOGY` 目前是“方法分组名”，不是 phase/node 的 canonical name：

- `## plan` 实际覆盖 `orchestrating/plan`、`plan-review`、`plan-revise`；
- `## implement` 覆盖 `implement`、`implement-revise`；
- `## code-review` 是 `orchestrating/code-review`；
- `## reviewing-code` 对应 `reviewing/code-review-standalone`；
- `## reviewing-proposal` 对应 `reviewing/proposal-review`；
- `## reviewing-verify` 对应 `reviewing/verify-standalone`；
- `## blocked / complete` 合并两个 phase。

模型虽然能从 procedure 看到当前 `phase/node`，但必须自己猜标题对应关系。`reviewing-code` 这类名字不是 `GATE_RECORD_NODES` 的值，容易被误认为独立 node；`plan`/`implement` 的覆盖范围也不明确。

结果是：模型可能套错方法论段，或为了确认去读源码。

## Decision

### Decision

#### 1. 定义 canonical 方法论键

新增：

```ts
export const METHODOLOGY_KEYS = [
  'discuss',
  'orchestrating/plan',
  'orchestrating/plan-review',
  'orchestrating/plan-revise',
  'orchestrating/implement',
  'orchestrating/code-review',
  'orchestrating/implement-revise',
  'orchestrating/verify',
  'orchestrating/note-lifecycle',
  'orchestrating/fix-bug',
  'docs',
  'reviewing/code-review-standalone',
  'reviewing/proposal-review',
  'reviewing/verify-standalone',
  'blocked',
  'complete',
  'orchestrating',
  'reviewing',
] as const
```

```ts
export function methodologyKeyFor(state: GateState): string
```

规则：

- `discuss` / `docs` / `blocked` / `complete` 使用 phase 名；
- `orchestrating` / `reviewing` 且有 node 时使用 `${phase}/${node}`；
- 没有 node 或 node 未知时回退到 phase 名；`orchestrating`/`reviewing` 也在 `METHODOLOGY_KEYS` 和静态方法论中有 generic 标题，避免 fallback 指向不存在的段；
- `METHODOLOGY_KEYS` 同时用作 key 的校验集合：计算出的 key 不在集合内时回退到 phase。

不新增 phase/node，不改 `PHASES` / `GATE_RECORD_NODES`。

#### 2. 方法论标题使用 canonical 键

按共享文本分组，但标题包含完整 key：

```text
## discuss
## orchestrating/plan · orchestrating/plan-review · orchestrating/plan-revise
## orchestrating/implement · orchestrating/implement-revise
## orchestrating/code-review
## orchestrating/verify
## orchestrating/note-lifecycle
## orchestrating/fix-bug
## docs
## reviewing/code-review-standalone
## reviewing/proposal-review
## reviewing/verify-standalone
## blocked
## complete
## orchestrating
## reviewing
```

- 不再使用 `## reviewing-code`、`## reviewing-proposal`、`## reviewing-verify`、`## blocked / complete`。
- plan/plan-review/plan-revise 共享方法文本，但三个 key 都出现在标题里；implement/implement-revise 同理。
- `blocked` 与 `complete` 拆成两个短段；`orchestrating`/`reviewing` 作为无 node 的 generic fallback 段，提示调用 `gate_status` 修复状态。
- `DISCUSS_ORCHESTRATION` 的 `## discuss` 保持。

#### 3. 当前 procedure 带 methodologyKey

`Procedure` 增加：

```ts
methodologyKey: string
```

- `procedureFor` 返回 `methodologyKeyFor(state)`。
- `procedureBlock` 显示：
  ```text
  当前 phase/node：orchestrating / plan
  方法论：orchestrating/plan
  方法：...
  ```
- `gate_status`、`gate_record`、`gate_start_phase`、命令 follow-up 继续使用同一 procedure 结果，因此自动携带。

模型不需要从 `phase/node` 猜段名，直接按 `methodologyKey` 找静态段。

#### 4. 覆盖测试

- `METHODOLOGY_KEYS` 每一项都作为 `GATE_METHODOLOGY` 的某个标题行按 ` · ` 拆分后的 token 出现，且恰好一次；
- `GATE_RECORD_NODES` 的每一项都有对应 `methodologyKeyFor`；
- phase `discuss/docs/blocked/complete` 的 key 正确；
- 旧别名 `reviewing-code`/`reviewing-proposal`/`reviewing-verify`/`blocked / complete` 不再出现在标题；
- `procedureFor` 的 `methodologyKey` 与 state 一致；
- static prompt 的所有标题唯一、无重复段。

### 非目标

- 不改变 `protocolVariant`/`NODE_INFO`/procedure 文本；
- 不改变 `GATE_METHODOLOGY` 的方法语义，只改标题与定位；
- 不把完整方法论复制进 `gate_status`；
- 不修改命令目录、权限或 nextCommands；
- 不新增 phase/node。

### 兼容

- `procedure` 新增字段，旧消费者忽略即可。
- `procedureBlock` 多一行，text 的内容变化是预期的。
- 静态 prompt 标题变化会改变 root prompt；这是本次合同变更，测试和旧 Note 需同步。
- `gate_methodology` 是静态文本，不随 phase 变化；`methodologyKey` 才随当前状态变化。

## 已有 Note 审计

- [Gate 方法论与 procedure](../../implemented/architecture/2026-11-12-gate-methodology-procedure.md)：其“方法论不写 phase/node 标识”规则被本 Note 部分修订为“标题可使用 canonical phase/node key，但不写当前状态”；其 phase-heading 表需同步。加指针，不改写旧 Decision。
- [Discuss orchestration](../../implemented/architecture/2026-11-13-discuss-orchestration-wiring.md)：`## discuss` 不变。
- [Command catalog](../../implemented/architecture/2026-11-13-gate-command-catalog.md)：`gate_help` 不涉及 methodologyKey；无合同冲突。
## Implementation evidence

- 新增 `METHODOLOGY_KEYS`、`methodologyKeyFor`；`Procedure` 增加 `methodologyKey`，`procedureBlock` 显示“方法论：”。
- GATE_METHODOLOGY 标题改为 canonical 分组；新增 blocked/complete 拆分和 orchestrating/reviewing fallback。
- gate_status、gate_record、gate_start_phase、命令 follow-up 自动携带 methodologyKey。
- 测试通过 procedure 的 methodologyKey 与 static prompt 覆盖全部 key、fallback、旧别名消失；不再硬编码独立 key 列表。
- 旧 methodology Note 的 phase-heading 表已同步，并声明原“不写 phase/node 标识”规则被部分修订。
- `pnpm typecheck`、`pnpm build`、`pnpm test`、`pnpm verify-notes` 通过。

## Alternatives considered

1. **只加 methodologyKey，不改标题**：模型知道 key，但静态段名仍不匹配，无法直接定位。否决。
2. **把方法论全部动态放进 procedure**：标题问题消失，但每次 status/record 重复全文，token 成本高。否决。
3. **保留别名并加索引表**：能映射，但多一层解释，模型仍可能把 `reviewing-code` 当 node。否决。
4. **按 phase 粗分，不列 node**：文本少，但 `plan-review`/`plan-revise`/`verify-standalone` 仍无法精确定位。否决。

## Consequences

### Acceptance criteria

1. `METHODOLOGY_KEYS` 覆盖全部 phase、`GATE_RECORD_NODES` 对应 key，以及 `orchestrating`/`reviewing` fallback；用于 `methodologyKeyFor` 的校验集合。
2. `GATE_METHODOLOGY` 标题使用 canonical key，不再出现 `reviewing-code`、`reviewing-proposal`、`reviewing-verify`、`blocked / complete`。
3. `methodologyKeyFor` 对 discuss/docs/blocked/complete 与 orchestrating/reviewing 节点返回正确 key；`orchestrating`/`reviewing` 且 node 为 null 时分别回退到 `orchestrating`/`reviewing`，并有对应静态标题。
4. `procedureFor` 返回 `methodologyKey`；`procedureBlock` 显示该行。
5. `gate_status`/`gate_record`/`gate_start_phase` 的 procedure 结果包含该字段。
6. `GATE_METHODOLOGY` 中每个 canonical key 在标题行按 ` · ` 拆分后的 token 中恰好出现一次；测试用 token 匹配，不用 `includes` 子串匹配。
7. 测试通过 `procedure.methodologyKey` 与 static prompt 覆盖 key 覆盖/旧别名消失/procedure methodologyKey；不从 `index.ts` 导出 `METHODOLOGY_KEYS`，registry export 快照不变。
8. `pnpm typecheck`、`pnpm build`、`pnpm test`、`pnpm -C packages/gate test`、`pnpm verify-notes` 通过。
9. 旧 methodology Note 加本 Note 指针，更新其“按 phase 分节”描述和 phase-heading 表，并明确其“方法论不写 phase/node 标识”规则被本 Note 部分修订：标题可以写 canonical phase/node key，但不写“当前”状态。

### Risks

- 标题从 12 个变为 15 个（新增 `blocked`/`complete` 拆分与两个 fallback），静态 prompt 增长；只改标题，方法文本不增。
- 分组标题包含多个 key，测试必须按 ` · ` 拆分 token 精确匹配，不能用 substring/includes。
- `methodologyKeyFor` 对未知 node 回退 phase；可能掩盖异常 state，但不会抛错。
- 旧 procedure 消费者若做严格对象比较会看到新字段；本仓库测试需更新。
