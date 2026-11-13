# Agent Note: NoteDecision 常量与 mechanical 判断集中化

Status: implemented

工作项：本次会话“把 `['new','update','in-place','mechanical']` 与 mechanical 判断集中成常量/helper”。本 Note 承接内部表示与校验，不改变 direct implement / plan mechanical 的用户行为。

## Problem

`NoteDecision` 目前是隐式字符串：

- `record.ts` 的 schema、plan 校验、plan-revise 校验各自重复数组；
- `note-files.ts` 的 `notePathsForDecision`/`validateNotePaths` 接受 `string`；
- `notes.ts`、`protocol.ts`、`record.ts` 反复写 `=== 'mechanical'`；
- `state.ts` 的 `noteDecision` 类型是 `string | null`，非法值会进入状态。

这不是功能问题，但机械条件散落后容易出现：

- schema 与实际校验枚举不一致；
- 新增 decision 时漏改某个分支；
- `noteDecision` 的非法旧值被当作普通字符串保留。

## Decision

### Decision

新增纯模块 `src/note-decisions.ts`：

```ts
export const NOTE_DECISIONS = ['new', 'update', 'in-place', 'mechanical'] as const
export type NoteDecision = (typeof NOTE_DECISIONS)[number]

export function isNoteDecision(value: unknown): value is NoteDecision
export function isMechanicalDecision(value: unknown): boolean

export const NOTE_DECISION_LIFECYCLE: Record<NoteDecision, 'proposed' | 'implemented' | null>
```

`NOTE_DECISION_LIFECYCLE` 集中 `new/update → proposed`、`in-place → implemented`、`mechanical → null` 的映射。

职责：

- `NOTE_DECISIONS` 是唯一枚举来源；schema 用 `[...NOTE_DECISIONS]`，保持原顺序。
- `isNoteDecision` 统一运行时校验。
- `isMechanicalDecision` 统一 mechanical 判断，替换手写字符串比较。
- 模块不依赖 state/notes/runtime，避免循环。

`state.ts`：

```ts
noteDecision: NoteDecision | null
```

`normalizeState` 使用 `isNoteDecision`；非法旧值归一为 `null`，不保留未知 decision。

`record.ts`：

- schema enum 改为 `[...NOTE_DECISIONS]`；
- plan/plan-revise 用 `isNoteDecision(decision)`；
- implement 分支在写入前用 `isNoteDecision(args.noteDecision)` 校验显式传入的 decision；非法值返回 `note-decision-required`，不进入 `validateNotePaths`；显式 `mechanical` 才把 `noteVerified` 置 true；直接 implement 已存在的 mechanical 状态保持 `noteVerified=false`，等 verify PASS；非 mechanical 赋值用 `isNoteDecision(args.noteDecision) && !isMechanicalDecision(args.noteDecision)`；
- 所有 `notePathsForDecision`/`validateNotePaths` 调用前都已由 `isNoteDecision` 收窄；`execute(args:any)` 不会替我们检查这个边界；
- mechanical 生命周期判断用 `isMechanicalDecision(state.noteDecision)`。

`note-files.ts`：

```ts
notePathsForDecision(value: unknown, decision: NoteDecision): NotePath[]
validateNotePaths(root: string, value: NotePath[], decision: NoteDecision)
```

mechanical 空路径校验留在 `validateNotePaths`；内部用 `isMechanicalDecision`，不再写字符串比较；不把状态赋值抽成 helper。

`notes.ts` / `protocol.ts`：

- `noteDecision === 'mechanical'` 替换为 `isMechanicalDecision(...)`。

### 非目标

- 不改变 direct implement 自动 mechanical；
- 不改变 plan/plan-revise 的 mechanical 空路径要求；
- 不改变 verify 跳过 lifecycle 的时机；
- 不集中 `state.noteDecision/notePaths/noteVerified` 的赋值，因为 direct/plan/implement 的 `noteVerified` 语义不同；
- 不新增用户命令、配置或对外导出；不把 helper 加到 `index.ts`，避免改动 registry 的 export 快照。

### 状态赋值保留

三个位置保持原样语义：

- direct implement：`noteVerified=false`，等 verify 置 true；
- plan mechanical：`noteVerified=true`；
- implement mechanical：`noteVerified=true`。

只替换判断，不抽“统一 setter”，避免把差异藏进参数。

## Implementation evidence

- 新增 `src/note-decisions.ts`：`NOTE_DECISIONS`、`MECHANICAL_DECISION`、`NoteDecision`、`isNoteDecision`、`isMechanicalDecision`、`NOTE_DECISION_LIFECYCLE`。
- `state.noteDecision` 收紧为 `NoteDecision | null`；非法旧值 normalize 为 null。
- `record.ts` schema 使用 `[...NOTE_DECISIONS]`；plan/plan-revise/implement 显式校验非法 decision；所有 mechanical 判断使用 helper。
- `note-files.ts` 使用 `NOTE_DECISION_LIFECYCLE` 校验 new/update/in-place 与 lifecycle 的关系；mechanical 空路径校验保持。
- 直接 implement 的 `noteVerified` 在 verify 前保持 false；显式 implement mechanical 仍置 true。
- 测试覆盖非法 plan/plan-revise/implement decision、normalize null、直接 implement verified 时机；registry snapshot 不变。

## Alternatives considered

1. **把所有 mechanical 状态赋值抽成 `applyNoteDecision`**：能减少几行，但 direct/plan/implement 的 verified 语义不同，参数化后更难读，且容易改变行为。否决。
2. **把常量放进 `state.ts`**：state 是状态类型属主，但会让 notes/record 为拿常量依赖 state；纯模块更中立。否决。
3. **只在 record.ts 建局部常量**：只能消掉 record 内重复，note-files/notes/protocol 仍会漂移。否决。
4. **用 TypeScript `const enum`**：运行时 schema 需要数组，且 NodeNext/esbuild 对 const enum 支持不直观；用 `as const` 元组。否决。

## Compatibility

- 现有合法 state 的 decision 全部在枚举内，行为不变。
- 非法旧值（例如手工修改或旧版本残留）在加载时归一为 `null`；之后按“无 decision”处理，不再被 mechanical 判断误命中。
- registry snapshot 的 enum 顺序不变，应保持字节一致；若变化，说明顺序被改动。
- 旧 Note 的 mechanical/direct implement 行为由 [直接 implement 自动 mechanical](../../implemented/process/2026-11-13-direct-implement-mechanical.md) 承接；本 Note 只改内部表示。

## Consequences

### Acceptance criteria

1. 新增 `src/note-decisions.ts`；`NoteDecision`/`NOTE_DECISIONS`/`isNoteDecision`/`isMechanicalDecision` 只有一个来源。
2. `state.noteDecision` 类型为 `NoteDecision | null`；非法值 normalize 为 `null`。
3. `record.ts` schema 与 plan/plan-revise 校验不再出现字面量枚举数组。
4. `note-files.ts` 的两个 decision 参数类型为 `NoteDecision`，mechanical 空路径校验保持。
5. 所有 mechanical 条件判断通过 `isMechanicalDecision`，包括 `note-files.ts`；所有枚举校验通过 `isNoteDecision`/`NOTE_DECISIONS`。字面量只允许存在于 `note-decisions.ts` 的 helper 内部和 schema 的 `[...NOTE_DECISIONS]`。
6. registry snapshot 不变（enum 顺序不变）。
7. 新增 execute 级测试（绕过 schema，直接调用 `gate_record.execute`）：plan、plan-revise 和 implement 的非法 `noteDecision` 都返回 `note-decision-required`；非法 state 值经 `normalizeState` 归一为 `null`；直接 implement 的 `noteVerified` 在 verify 前保持 false；现有 mechanical/direct 测试全绿。
8. `pnpm typecheck`、`pnpm build`、`pnpm test`、`pnpm -C packages/gate test`、`pnpm verify-notes` 通过。
9. 合法 state 的用户可见行为不变；非法旧 decision 在 normalize 时归一为 `null`，状态行不再显示未知 decision；README 仅在需要时补一句内部校验，不新增流程说明。

### Risks

- `normalizeState` 从“保留任意字符串”改为“非法值 null”会影响被手工改坏的 state；这是有意的收紧。
- `NoteDecision` 类型收紧不会自动覆盖 `execute(args:any)`；实施时必须逐个检查 `notePathsForDecision`/`validateNotePaths` 调用点，显式加 `isNoteDecision` 收窄。
- 新增模块会增加一个 check-split 节点；模块必须保持无 runtime 依赖。
- `NOTE_DECISIONS` 顺序必须保持 `new/update/in-place/mechanical`，否则 registry snapshot 变化。
