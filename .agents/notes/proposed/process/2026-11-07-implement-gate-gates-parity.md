# Agent Note: Gate 对 GATES.md 的剩余能力

Status: proposed

工作项：在 `packages/gate` 中补齐 Entry gate、review-only、block/resume、verify evidence，使 Gate 不只承接 phase 和写权限。

## Problem

当前 Gate 已承接：

- phase 与写权限；
- 主代理派发协议；
- 5 轮 review 与 `requiresDiscussion`；
- proposed/mechanical 工作项检查。

未承接：

- `/gate-enter-implement` 不检查 Plan Review 是否通过、是否有批准证据；
- 没有 review-only 路径；
- 只有 5 轮耗尽 blocked，没有手动 block/resume；
- verify 只信 `gate_record({ok:true})`，没有命令与证据。

## 源工程证据

| 源工程证据 | 源工程行为 | 复刻落点与裁决 |
|---|---|---|
| `.agents/GATES.md` Step 3 | 进入 implement 前检查范围、合同、设计、无 blocker、有授权 | Gate 增加 `planReady` 与 entry check |
| `GATES.md` 限定/仅审查请求 | review-only 不进入 implementation | 新增 `/gate-code-review`，只输出 findings |
| `GATES.md` 返回与持续授权 | 合同变化回 discuss；block 冻结 | 新增手动 `/gate-block`、`/gate-resume` |
| `GATES.md` Step 5 | Verify 需要验收证据 | `gate_record` verify 要求 commands/evidence |
| `GATES.md` 审查收敛 | 5 轮后停止，不通过 | 保留 rounds；与手动 block 区分 |

## Proposal

### 1. Entry gate

State 增加：

```json
{ "planReady": false, "planApprovedAt": null }
```

- `gate_record({node:'plan-review', findings:[]})` 成功时 `planReady=true`；
- `/gate-enter-implement`：
  - 有 proposal Note 或 mechanical；
  - 非 mechanical 时 `planReady=true`；
  - `work !== 'blocked'`；
  - 无 `blockReason`；
  - 否则拒绝并说明缺哪项。

不把批准证据做成第二套状态表；`planReady` 只表示 Gate 观察到的 plan review 结果。

### 2. 单独 code review

用户命令：

```text
/gate-code-review <范围>
```

State：

```text
phase=reviewing
node=review
task=<范围>
```

- 用户要求单独审查已有改动，不进入 planning/implement；
- 不要求 proposed Note；
- 不写代码/文档、不修复、不 verify、不推进实现；
- 主代理加载 `code-review` 技能；
- 主代理派 `gate-code-review-standards` / `gate-code-review-spec`；
- `gate_record({node:'review', findings, requiresDiscussion})`：
  - findings 空：结束，回 discuss；
  - findings 非空：输出报告后结束，不进入 implement；
  - requiresDiscussion：回 discuss。

不新增 `gate_review` 工具；命令只负责进入只读审查状态。

### 3. block / resume

新增命令：

```text
/gate-block <原因>
/gate-resume
```

State 增加：

```json
{
  "phase": "blocked",
  "blockedFrom": { "phase": "orchestrating", "node": "implement" },
  "blockReason": "...",
  "work": "blocked"
}
```

- block：保存原 phase/node，进入 blocked，所有写拒绝；
- resume：恢复 `blockedFrom`，清 blockReason；
- 与 5 轮耗尽区分：
  - `blockReason='user-blocked'`
  - `blockReason='*-review-rounds-exhausted'`

### 4. Verify evidence

`gate_record` verify 参数：

```json
{
  "node": "verify",
  "verification": {
    "commands": ["node packages/gate/test/unit.mjs"],
    "evidence": ["artifacts/..."],
    "passed": true
  }
}
```

Gate 校验：

- `commands` 至少一条；
- `evidence` 至少一条；
- evidence 路径存在；
- `passed` 必须明确；
- 不满足返回 `verification-required`，不进 complete。

### 非目标

- 不把批准证据建成第二套状态表；
- 不修改 `.agents/skills`；
- 不修改旧 `implement-gate`；
- 不实现真实模型执行。

## Alternatives considered

**Entry gate 只检查 proposed Note。** 最强理由是简单；没有检查 plan review/blocker，故不采用。

**review-only 复用 `/gate-enter-implement`。** 最强理由是少命令；会要求 implementation 授权和 verify，故独立。

**block 复用 work=blocked。** 最强理由是已有字段；无法区分用户 block 与轮次耗尽，故加 phase/blockedFrom。

**verify 继续只信 ok。** 最强理由是简单；没有证据就无法验收，故要求 commands/evidence。

## Acceptance criteria

1. 未通过 plan review 的 `/gate-enter-implement` 被拒绝；
2. mechanical 可跳过 planReady；
3. `/gate-code-review` 不进入 implement、不写代码、不修复；
4. `/gate-block` 冻结写入，`/gate-resume` 恢复；
5. block 与轮次耗尽可区分；
6. verify 无 commands/evidence 被拒绝；
7. verify PASS 才 complete；
8. 测试覆盖以上路径。

## Plan Review

- Standards：补齐 GATES 的运行时可观察项，不建第二套状态表。
- Spec：entry/review-only/block/verify 都可观察。
- Architecture：state 扩展最小，命令与 gate_record 分担。
- 结论：通过，进入实施需 implement 授权。

## Risks

- Entry gate 可能误伤 mechanical/紧急实现，需要明确 mechanical 例外；
- review-only 的结束语义与 planning/implement 的 complete 区分；
- block/resume 需要持久化 blockedFrom；
- verify evidence 路径校验要考虑生成物尚未落盘。
