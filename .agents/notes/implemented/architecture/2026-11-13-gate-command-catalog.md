# Agent Note: Gate 命令目录、nextCommands 与 gate_help

Status: implemented

工作项：本次会话“让模型知道 gate 工具、命令与下一步推荐”。本 Note 承接命令/工具目录和状态提示；不改 gate 权限矩阵或阶段转换规则。

## Problem

模型能看到 DSH tool catalog 里的 `gate_*` 工具及 description/schema，但 `/gate-*` 是 command，不是 tool，不会完整进入模型上下文。

当前命令名只零散出现在：

- `procedureFor` 的部分 procedure；
- `GATE_METHODOLOGY`；
- skills；
- README。

因此模型可能：

- 不知道某个 `/gate-*` 命令是否存在；
- 把 command 当 tool 直接调用；
- 猜命令名，用户执行失败后返工；
- 为确认命令去读 `commands.ts`/README/插件源码。

`gate_status` 目前返回 procedure 和 access，但没有命令目录，也没有“当前下一步可建议用户执行什么命令”的字段。

## Decision

### Decision

#### 1. 命令元数据单一来源

新增顶层 `src/command-catalog.ts`（不建 `commands/` 目录，避免 check-split 的 `commands.ts` 特判漏掉新目录）：

```ts
export interface GateCommandSpec {
  name: string // 不含斜杠，与 commands.register 的 name 一致
  description: string
  hint: string | null
  when: string
}

export const GATE_COMMANDS: readonly GateCommandSpec[]
```

- 16 个现有命令全部登记，name、description、hint、when 只在这里维护。
- `registerCommands` 按 spec 注册；handler 用 name 查找，避免注册与 help 两套描述。
- 用户可见的 slash 形式由 `/${name}` 派生，不在 metadata 里写两次。
- `when` 是人可读的适用阶段，例如 `discuss/complete`、`blocked`、`any`；不是权限判断。
- 不把 command 暴露成 tool；模型只能建议用户执行，或调用对应 `gate_*` tool。

#### 2. 工具摘要单一来源

新增 `src/tools/catalog.ts`：

```ts
export interface GateToolSpec {
  name: string
  summary: string
}

export const GATE_TOOLS: readonly GateToolSpec[]
```

- 覆盖现有 6 个工具（`gate_status`、`gate_record`、`gate_start_phase`、`gate_note_write`、`gate_note_verify`、`gate_note_finalize`）以及新增的 `gate_help`，共 7 个；`gate_help` 也列在 help 中，形成完整工具目录。
- 只写一句话用途，不复制完整 schema/description。
- 工具注册名与 `GATE_TOOLS` 的一致性由测试锁住。

#### 3. `gate_help` 只读工具

新增 root-only 只读工具：

```text
gate_help()
```

返回：

```ts
{
  commands: GateCommandSpec[],
  tools: GateToolSpec[],
  current: { phase, node },
  note: string
}
```

- 列出全部命令、hint、适用阶段和全部工具用途。
- `note` 明确“命令由用户执行；工具由模型调用”。
- 不读文件、不改 state、不返回内部实现。
- worker 调用返回 `root-only`，与 `gate_record` 一致；worker 继续使用 procedure。

#### 4. `gate_status` 增加 nextCommands

在 `gate_status` 结果中增加：

```ts
nextCommands: Array<{
  command: `/${string}`
  reason: string
}>
```

只在需要用户动作时非空：

| 当前状态 | nextCommands |
|---|---|
| `discuss` / `complete` | `/gate-enter-plan`、`/gate-enter-implement`；reason 说明需要用户授权 |
| `blocked` | 仅 `/gate-resume`（`/gate-return-discuss` 在 blocked 下会报错） |
| 其他 orchestrating/reviewing/docs | `[]`（procedure 已给工具动作） |

- `nextCommands` 是**建议**，不是授权；不改变任何 guard/transition。
- root 返回；worker 的 `gate_status` 仍返回 root 状态，但 `nextCommands` 为空，因为 worker 不应建议用户命令。
- 不新增 `availableCommands` 大列表；用户需要完整目录时调用 `gate_help`。

#### 5. 静态 prompt 索引

在 `GATE_METHODOLOGY` 末尾增加一句：

> 不确定有哪些 `/gate-*` 命令或工具用途时，调用只读 `gate_help`；没有命令提示时按当前 procedure 调工具。

不把 16 条命令全文塞进静态 prompt，避免每会话固定 token 膨胀。

### 非目标

- 不新增命令，不改变 16 个命令的行为、参数或权限。
- 不改变 `gate_status`/`gate_record` 的 phase/node 转换。
- 不让模型直接执行 slash command。
- 不把 `gate_help` 做成权限绕过；它只读目录。
- 不从 `index.ts` 导出 `GATE_COMMANDS`/`GATE_TOOLS`，避免 registry export 快照变化。

### 命令/工具边界

- command：用户输入，gate 命令处理器执行；模型只能建议。
- tool：模型调用，受 `ctx.tools.guard`/restriction 约束。
- `gate_help` 的结果必须显式写出这个区别，防止模型把 `/gate-enter-implement` 当 tool 调用。

### 数据流

```text
commands.ts handlers + catalog specs
        ↓
registerCommands (same specs)
        ↓
gate_help / README / tests

state (phase/node)
        ↓
gate_status.nextCommands
        ↓
model recommends user command or follows procedure tool
```

## Implementation evidence

- 新增 `src/command-catalog.ts`（16 条命令）、`src/tools/catalog.ts`（7 个工具）和 `src/command-next.ts`。
- `commands.ts` 的注册改为按 spec 查 handler；registry snapshot 的命令描述/hint 不变。
- 新增 root-only `gate_help`，返回 commands/tools/current/note；worker 返回 root-only。
- `gate_status` 和 `/gate-status` 的 root 文本显示 nextCommands；worker 为空。
- blocked procedure、GATE_METHODOLOGY、README 和 GATE_FROZEN_REASON 只引导 /gate-resume。
- 测试覆盖 16/7 目录、help 只读/root-only、when/tools parity、nextCommands 矩阵、README 命令表、blocked denial、worker nextCommands。
- `pnpm typecheck`、`pnpm build`、`pnpm test`、`pnpm verify-notes` 通过。

## Alternatives considered

1. **把 16 个命令全文放进静态 `GATE_METHODOLOGY`**：模型一开始就知道全部命令，但固定 token 增加，且命令变化会改变 root prompt。否决；用 `gate_help` 按需读取 + `nextCommands` 常用路径。
2. **只加 `gate_status.nextCommands`，不做 `gate_help`**：覆盖下一步，但模型查任意命令语义仍需读源码。否决。
3. **把 command 注册成 tool**：模型可直接调用，但绕过用户授权语义，且 command handler 依赖 invocation/agent；否决。
4. **让 `gate_status` 返回全部 availableCommands**：信息最全，但每次状态返回膨胀，且 phase 过滤易与真实 handler 条件漂移。否决；完整目录只在 `gate_help`。
5. **从 README 解析命令表**：无需新 metadata，但运行时依赖文档格式，插件运行时不能读仓库 docs；否决。

## Consequences

### Acceptance criteria

1. `GATE_COMMANDS` 覆盖现有 16 个命令，name/description/hint/when 与注册结果一致；测试通过 `gate_help` 输出锁住，包含 `when` 的可适用性。
2. `GATE_TOOLS` 覆盖现有 6 个工具 + `gate_help`，共 7 个，名称与注册结果一致；测试通过 `gate_help` 输出锁住。
3. `gate_help` 为 root-only 只读工具，返回全部命令/工具/当前 phase/node，并明确 command 与 tool 的区别。
4. worker 调 `gate_help` 返回 `root-only`；worker 的 `gate_status.nextCommands` 为空。
5. `gate_status` root 在 discuss/complete 返回 `/gate-enter-plan`、`/gate-enter-implement`；blocked 只返回 `/gate-resume`；其他 phase（含 docs）为空。blocked procedure / `GATE_METHODOLOGY` / README 同步只提 `/gate-resume`，不再把 `/gate-return-discuss` 当作 blocked 恢复路径。`nextCommands` 必须同时出现在 `gate_status.text` 和 `/gate-status` 的 root 文本中，不能只做不可见的 JSON 字段。
6. `gate_status.nextCommands` 不改变 state；`gate_help` 不改变 state。
7. 静态 `GATE_METHODOLOGY` 只增加 `gate_help` 索引句，不写 `nextCommands` 字段或调用步骤；前后 root prompt 仍 byte-stable（不随 phase 变化）。
8. registry snapshot 更新：新增 `gate_help` 工具、命令注册结果不变；export 快照不变；metadata 不从 `index.ts` 导出。
9. `pnpm typecheck`、`pnpm build`、`pnpm test`、`pnpm -C packages/gate test`、`pnpm verify-notes` 通过。
10. README 命令表与 `GATE_COMMANDS` 做一致性测试或由同一 metadata 生成；不扩大用户流程说明。

### Risks

- 现有 blocked 文案与 handler 矛盾：`/gate-return-discuss` 在 blocked 下报错；目录/nextCommands 必须和修正后的 blocked 文案一起落地。

- `gate_status.nextCommands` 需要在 text 中可见；只加字段不会到模型，因为 `tools/status.ts` 的 render 只输出 `text`。
- `nextCommands` 的 state→command 映射放在独立 `src/command-next.ts`，由 `tools/status.ts` 和 `/gate-status` 共用；不要放进 `protocol.ts`，避免 protocol→commands 依赖。
- `commands.ts` 的注册重构必须保持 16 个命令的 name/description 原样；registry snapshot 是硬证据。

- `gate_help` 增加一个工具，模型可能频繁调用；description 要写明“只在不确定命令/工具时使用”。
- `nextCommands` 与 procedure 可能漂移；汇总函数只负责用户命令，不复制工具步骤。
- 命令目录与注册重构会动 `commands.ts`；必须用测试和 registry snapshot 锁住行为。
- `GATE_COMMANDS` 的 `when` 是描述而非权限判断；不要用它替代 handler 的 phase 校验。
- 静态 prompt 加一句会改变 root prompt 字节；这是新 Note 的预期变更，需在实施时更新 snapshot/测试。
