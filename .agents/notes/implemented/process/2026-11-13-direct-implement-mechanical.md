# Agent Note: 直接 implement 自动 mechanical

Status: implemented

工作项：本次会话“机械小改直接 implement，不要求 task 前缀”。本 Note 承接 mechanical 的入口语义；Note lifecycle 的既有行为由 [2026-11-10 builtin lifecycle](../../implemented/process/2026-11-10-gate-notes-builtin-lifecycle.md) 承接。

## Problem

用户确认：机械小改本来可以直接走 `/gate-enter-implement [简单说明]`，不需要把 task 写成 `mechanical:<说明>`。

当前实现不一致：

- 直接 implement 入口把 `state.noteDecision` 设为 `null`；
- `gate_record({node:'implement'})` 只有显式传 `noteDecision:'mechanical'` 才跳过 Note；
- 不传就会进入 note-lifecycle，但直接 implement 没有 Note，`noteVerified` 为 false，最终失败；
- plan/plan-revise 仍强制 `task` 以 `mechanical:` 开头，和“直接 implement 不需要前缀”的语义冲突。

## Decision

### Decision

- `/gate-enter-implement [简述]` 和 `gate_start_phase({node:'implement', brief})` 的直接 implement 路径自动设置：
  - `noteDecision = 'mechanical'`
  - `notePaths = []`
  - `noteVerified = false`（由 verify PASS 置 true）
- 删除 `isMechanical` 和 plan/plan-revise 的 `mechanical:` 前缀校验。
- `mechanical` 只作为内部 `noteDecision`：直接 implement 自动产生；plan/plan-revise 也可显式选择，但只需 `notePaths: []`，不要求 task 前缀。
- 保留 mechanical 的既有生命周期行为：verify PASS 直接回 discuss，不进 note-lifecycle，给提交建议。
- plan 的 mechanical 仍走 plan-review；本 Note 不改变规划/评审流程。

## Implementation evidence

- `commands.ts` 的直接 implement 分支设置 `noteDecision='mechanical'`、`notePaths=[]`；`gate_start_phase` 直接路径同样设置。
- 删除 `isMechanical` 与 plan/plan-revise 的 task 前缀校验；mechanical 仍要求空 notePaths。
- 直接 implement → code-review → verify 的完整测试通过；verify PASS 跳过 note-lifecycle。
- 测试覆盖直接 implement 自动 mechanical、record、review、verify、plan 无前缀 mechanical。
- 旧 lifecycle Note 的 task 前缀描述已加本 Note 指针；README 说明直接 implement 自动 mechanical。

## Alternatives considered

1. **保留 task 前缀，只修直接 implement**：直接 implement 可用，但 plan 仍要求无意义前缀；用户明确说不需要。否决。
2. **让 root 手动在 implement 记录时传 `noteDecision:'mechanical'`**：能工作，但容易漏；直接 implement 的语义应自动成立。否决。
3. **直接 implement 也创建 Note**：违背“机械小改不写规划产物”的初衷。否决。

## Consequences

### Acceptance criteria

1. 直接 implement 入口后 `noteDecision='mechanical'`、`notePaths=[]`。
2. `gate_record({node:'implement'})` 不传 `noteDecision` 也能保持 mechanical，并进入 code-review。
3. plan/plan-revise 选择 mechanical 不要求 `mechanical:` 前缀，只要求 `notePaths=[]`。
4. mechanical verify PASS 仍跳过 note-lifecycle 并给提交建议。
5. 测试覆盖直接 implement 自动 mechanical、直接 implement record、plan 无前缀 mechanical。
6. `pnpm typecheck`、`pnpm build`、`pnpm test`、`pnpm -C packages/gate test`、`pnpm verify-notes` 通过。
7. 旧 lifecycle Note 的“task 前缀”描述加本 Note 指针；README 说明直接 implement 自动 mechanical。

### Risks

- 直接 implement 默认无 Note；如果用户后来希望留 Note，需要改用 plan 或另行补 Note。
- plan 的 mechanical 不再靠前缀识别，root 必须显式传 `noteDecision`；schema 会校验。
- 旧状态中已有 `mechanical:` task 仍兼容，不影响现有 session。
