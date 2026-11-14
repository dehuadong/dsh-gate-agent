# Agent Note: 取消 /gate-fix-bug 与 fix-bug 节点

Status: implemented

工作项：取消 `/gate-fix-bug` 及其关联的 fix-bug 流程。缺陷修复回到普通 `plan` / `implement` / `code-review` / `verify` 流程。

## Problem

`/gate-fix-bug` 与普通 implement/review 重复：

- 需要单独的命令、节点、skill、worker brief 和 procedure；
- 与 `implement` 一样需要实现、独立 review、测试；
- 用户已要求取消该命令及其关联内容，避免维护两套修复流程。

## Decision

### 决策

- 删除 `/gate-fix-bug` 用户命令；
- 删除 `fix-bug` 节点、`GATE_RECORD_NODES` 条目、`NODE_INFO`、`NODE_PROCEDURES`、`METHODOLOGY_KEYS`；
- 删除 `fix-bug` 的 access、workerProtocol、record 分支、projection command 分支；
- 删除 `packages/gate/skills/gate-fix-bug/`；
- 从 README、registry、测试中移除引用；
- 缺陷修复使用现有 `implement` / `code-review` / `verify` 流程；
- 命令数 17 → 16，工具数不变。

### 非目标

- 不删除 `gate-implement` 或 `gate-code-review`；
- 不改变普通 implement/review/verify 语义；
- 不保留不可达的 `fix-bug` 节点。

### 验收

1. `gate_help`、命令目录、README 不再出现 `/gate-fix-bug`。
2. `GATE_RECORD_NODES`、`NODE_INFO`、`NODE_PROCEDURES`、`METHODOLOGY_KEYS`、`WORKER_NODES` 不再包含 `fix-bug`。
3. `fix-bug` 的 access、worker brief、record/projection 分支删除。
4. `packages/gate/skills/gate-fix-bug/` 删除。
5. 命令数 16，工具数 10；registry/help/README/tests 同步。
6. `pnpm typecheck`、`pnpm build`、`pnpm test`、`pnpm verify-notes` 通过。

## Implementation evidence

- 删除命令、节点、skill、worker brief、access/worker/record/projection 分支。
- README、registry、测试同步；`gate-fix-bug` 不再出现在插件包。
- `pnpm typecheck`、`pnpm build`、`pnpm test`、`pnpm verify-notes` 通过。

## Alternatives considered

1. **只删除命令，保留 fix-bug 节点**：会留下不可达状态，维护两套流程。否决。
2. **保留 fix-bug 但默认隐藏命令**：仍需要独立技能、worker 和测试，收益不足。否决。

## Consequences

- `/gate-fix-bug` 和 `fix-bug` 节点不再可用；缺陷修复统一走 implement/review/verify。
- 命令数 16，工具数 10；插件包不再包含 `gate-fix-bug` skill。
- 验证：`pnpm typecheck`、`pnpm build`、`pnpm test`、`pnpm verify-notes` 通过。

## Risks

- 历史会话中的 `fix-bug` 状态不再有对应节点；已完成的修复流程由历史记录保留，新的修复使用 implement。
- 旧文档若仍引用 `/gate-fix-bug` 会失效；本仓库内引用已清理。
