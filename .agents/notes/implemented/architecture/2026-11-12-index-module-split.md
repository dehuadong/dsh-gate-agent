# Agent Note: 拆分 2,000 行 index.ts

Status: implemented

工作项：本次会话“拆分包入口 `packages/gate/src/index.ts`”。本 Note 承接源码模块边界与迁移顺序；TypeScript/pnpm 构建契约由 [TypeScript + pnpm 构建迁移](../../implemented/process/2026-11-12-typescript-pnpm-build.md) 承接，gate 行为合同不变。

## Problem

TypeScript 迁移后，`packages/gate/src/index.ts` 约 1,999 行，同时承担：

- 插件公开导出与 `apply` 组装；
- 静态方法论、node metadata、procedure 渲染；
- Note 路径校验、format/finalize、AGENTS/CI/git provisioning；
- session projection、命令/投影事件、state runtime；
- worker 协议、review axes、worker evidence；
- 权限守卫与 shell/write 拒绝；
- 所有 `/gate-*` 命令；
- `gate_start_phase`、`gate_record`、`gate_status`、`gate_note_*` 工具。

结果是：

- 一次小改要在大文件里定位多个职责，diff 噪声大；
- 工具/命令依赖的 helper 与入口 closure 混在一起，边界不可见；
- 公开导出、注册顺序、闭包依赖交织，直接按行拆容易产生循环 import 或行为漂移。

目标不是“按行数切块”，而是把职责边界固定下来，让 `index.ts` 回到 composition root。

## Decision

### 范围与非目标

本次调整：

- 只移动/重组源码；行为、procedure 文本、工具 schema、命令行为、package 入口、bundle 产物均不变；
- “package/patch 不变”是相对已落地的 TS/pnpm 迁移基线；`package.json`/`cordis.patch.yml` 的构建入口变更属于前一工作项，不是本次拆分引入；
- 保持 `lib/index.js` 单入口；不改变 `package.json` 的运行字段（name/type/exports/files/dsh）或 `cordis.patch.yml`；只允许为 registry/check-split 增加测试脚本（`scripts.test` / root `test`），不改运行入口；
- 保持现有公共导出：`apply`、`inject`、`Config`、六个 orchestration 常量、`GATE_RECORD_NODES`、`NODE_METHODS`、`WORKER_NODES`、`transformImplemented`、`PHASES`、`defaultState`、`normalizeState`、`loadState`、`saveState`；
- 新增模块不得反向 import `index.ts`；依赖方向单向。

非目标：

- 不改 gate 行为/协议/权限；
- 不重写测试（只新增拆分校验）；
- 不按功能拆成多个 npm 包；
- 不改变 esbuild 单文件产物；
- 不顺手改 TypeScript 类型策略。

### 目标结构

```text
src/
  index.ts                 # 公开导出 + apply 组装；目标 < 250 行
  config.ts                # Config、DEFAULT_REVIEW_LIMIT
  paths.ts                 # PACKAGE_ROOT、SKILLS、launchers
  protocol.ts              # 方法论/procedure/node metadata/status 渲染
  state.ts                 # 既有 GateState/default/normalize/load/save
  classify.ts              # 既有 path/shell classification
  notes/
    fs.ts                  # isInside/pathHasSymlink/resolveNodeBinary/resolveNotesSkill
    scripts.ts             # runNotesScripts/runFormatOnNote
    note-files.ts          # note path/format/finalize/transformImplemented
    provision.ts           # notes/AGENTS/CI/verify-notes/git init
  runtime/
    deps.ts                # GateDeps 共享实例类型
    store.ts               # StateRuntime、projection/command reducer
    session.ts             # workspaceBoundary/resolveGate/rootAgentOf/sessionCwd/effectiveState
    gate.ts                # enterPhase/makeWake
    guards.ts              # restriction/worker roles/gateDenyReason/pre-step
    workers.ts             # REVIEW_NODES/workerProtocol/review axes/evidence
    prompt.ts              # installSystemPrompt
  tools/
    index.ts               # registerTools 聚合；按原顺序调用各工具
    start-phase.ts         # gate_start_phase
    record.ts              # gate_record
    status.ts              # gate_status
    notes.ts               # gate_note_write/verify/finalize
  commands.ts              # 所有 /gate-* 命令
```

### 职责与依赖

| 模块 | 职责 | 允许依赖 |
|---|---|---|
| `config.ts` | `Config`、默认 review limit | 无（仅常量） |
| `paths.ts` | 包根、skills、launchers | `node:path/url` |
| `protocol.ts` | 方法论、node metadata、`procedureFor`/`statusText`/procedure 渲染 | `config`、`state` 类型 |
| `state.ts` | 既有状态数据/default/normalize/load/save | 无 |
| `classify.ts` | 既有 path/shell 分类 | 无 |
| `notes/fs.ts` | path 安全、node 解析、notes skill 查找 | `paths`、`node:fs/path` |
| `notes/scripts.ts` | notes 校验脚本、note format、`runNotesScript`（archive/board/seal） | `notes/fs`、`paths`、`node:*` |
| `notes/note-files.ts` | note path 归一/校验、finalize、`transformImplemented` | `notes/fs`、`notes/scripts`、`state` 类型 |
| `notes/provision.ts` | `provisionNotes`、AGENTS、CI、verify-notes、git init | `paths`、`notes/fs` |
| `runtime/deps.ts` | `GateDeps`（ctx/store/reviewLimit/wake） | `state`、`runtime/store` 类型 |
| `runtime/store.ts` | `StateRuntime`、projection/command reducer | `config`、`state` |
| `runtime/session.ts` | `workspaceBoundary`/`resolveGate`/`rootAgentOf`/`sessionCwd`/`effectiveState` | `runtime/store`、`state` |
| `runtime/gate.ts` | `enterPhase`、`makeWake`、`isMechanical` | `config`、`state`、`protocol`、`runtime/store`、`runtime/session`、`notes/fs` |
| `runtime/guards.ts` | restriction state/filter、worker roles、`gateDenyReason`、`applyRestrictions`/pre-step | `state`、`classify`、`runtime/store`、`runtime/session` |
| `runtime/workers.ts` | `REVIEW_NODES`、worker protocol、review axes、evidence | `state`、`protocol`、host 边界 |
| `runtime/prompt.ts` | `installSystemPrompt`、GATE_METHODOLOGY/worker 组合 | `runtime/session`、`runtime/workers`、`protocol` |
| `tools/index.ts` | `registerTools` 聚合，保持注册顺序 | 各 `tools/*` |
| `tools/*.ts` | 单个工具 schema + handler；共享实例由 `GateDeps` 注入；证据哈希可用 `classify`+`node:*` | runtime/notes/protocol、`state`、`classify`、`node:*` |
| `commands.ts` | 命令注册；共享实例由 `GateDeps` 注入；脚本调用经 `notes/scripts` | runtime/notes/protocol、`state`、`paths`、`notes/scripts` |
| `index.ts` | 公开 re-export、`apply` 组装 | 所有装配模块 |

依赖方向：

```text
index -> tools/index, commands, runtime/prompt, runtime/guards, runtime/gate, runtime/store
tools/commands -> runtime/*, notes/*, protocol, state
runtime/prompt -> runtime/session, runtime/workers, protocol
runtime/guards -> runtime/session, runtime/store, classify, state
runtime/gate -> runtime/session, runtime/store, protocol, notes/fs
runtime/session -> runtime/store, state
runtime/store -> state, config
notes/note-files -> notes/fs, notes/scripts, state
protocol -> config, state
```

`tools`/`commands` 不得 import `index`；`runtime` 不得 import `tools`/`commands`；`protocol` 不得 import runtime；`notes` 不得 import runtime。

### 共享注入

`GateDeps` 只承载共享实例：

```ts
interface GateDeps {
  ctx: any
  store: StateRuntime
  reviewLimit: number
  wake: (invocation: any, state: GateState, text: string, command: string) => void
}
```

- `apply` 创建 `store`、`reviewLimit`、`makeWake(reviewLimit)`，构造 `deps`；
- `installSystemPrompt(ctx, deps)`、`installGuard(ctx, deps)`、`installRestrictions(ctx, deps)`、`registerCommands(scope, deps)`、`registerTools(ctx, deps)` 接收 deps；
- 工具/命令可以直接 import 下层纯函数（`protocol`、`notes`、`runtime/session`/`gate` 的导出），但不能 import `index`；
- `createStateRuntime` 只在 `apply` 调用一次，projection key `gate` 只注册一次；所有消费者使用 `deps.store`；
- `makeWake` 只由 `runtime/gate.ts` 提供，`apply` 只调用一次，避免实现重复。

### 迁移顺序

1. **低风险纯模块**：`config.ts`、`paths.ts`、`protocol.ts`；index 改为 re-export；跑 typecheck/test。
2. **Note 模块**：`notes/fs.ts`、`notes/scripts.ts`、`notes/note-files.ts`、`notes/provision.ts`；保持 `transformImplemented` 从 index re-export；跑测试。
3. **runtime**：`runtime/store.ts`、`session.ts`、`gate.ts`、`guards.ts`、`workers.ts`、`prompt.ts`；按依赖顺序移动；跑测试。
4. **tools/commands**：`tools/index.ts` + 各工具 + `commands.ts`；index 只保留注册顺序和注入。
5. **收尾**：删除死 import/helper；跑 `pnpm typecheck`、`pnpm test`、`pnpm -C packages/gate test`、`pnpm build`、`pnpm verify-notes`。

每一步都保持可运行，不把“大爆炸式移动”留到最后。

### 目标行数

- `index.ts`：目标 80–150 行，硬上限 250 行；
- `protocol.ts`：约 350 行；
- `runtime/store.ts`：约 220 行；
- `tools/record.ts`：约 300–350 行；
- `commands.ts`：约 300–350 行；
- 其他模块目标 ≤ 300 行。

## Implementation evidence

- `src/index.ts` 25 行；新增 22 个源码模块；esbuild 产物仍是单入口 `lib/index.js`（内联 22 个模块）。
- `pnpm typecheck`、`pnpm build`、`pnpm test`、`pnpm -C packages/gate test`、`pnpm verify-notes` 全部通过。
- `scripts/check-split.mjs`：import 图 23 个模块、无环/无反向依赖、index 26 行（含末尾换行）≤250。
- `test/registry.mjs`：精确比较 18 个公共导出键，以及工具/命令/系统 prompt/guard/pre-step 快照。
- 行为不变：unit/composition/registry 全绿；`apply` 仍只创建一次 state store 与 wake。

## Alternatives considered

1. **保持单文件，只加分区注释**：零迁移风险，但无法减少 review 噪声和依赖耦合。否决：用户明确要拆分，注释不解决职责边界。
2. **只抽 tools/commands**：入口会降到约 500 行，但 protocol/notes/runtime 仍混在一起。否决：`index.ts` 仍承担多种变更原因。
3. **按行数平均切块**：机械、快；但会切断同一职责并制造跨模块循环。否决：边界应来自职责，不是行数。
4. **拆成多个 npm 包**：边界最强，但引入发布/依赖/版本成本，DSH 仍只需一个 bundle。否决：当前单插件无独立发布需求。
5. **先拆纯模块，再按需停止**：低风险，可能停在 600 行入口。可作为退路；但目标结构已明确，建议一次做到 composition root。

## 已有 Note 审计

- [TypeScript + pnpm 构建迁移](../../implemented/process/2026-11-12-typescript-pnpm-build.md)：拥有构建/入口契约；本 Note 只拆源码，不改 package/exports/lib。
- [Gate 方法论与 procedure 拆分](../../implemented/architecture/2026-11-12-gate-methodology-procedure.md)：拥有 GATE_METHODOLOGY/procedureFor/状态文本；抽到 `protocol.ts` 时保持其合同。
- [Planning 资源与 Note/verify 契约](../../implemented/process/2026-11-12-gate-planning-resources-and-note-contracts.md)：拥有 notePaths/format/finalize；抽到 `notes/` 时保持其合同。
- [Gate DSH 原生](../../implemented/architecture/2026-11-10-gate-dsh-native.md) 与 [Gate root 写权限](../../implemented/architecture/2026-11-12-gate-root-write-policy.md)：拥有 projection/guard 行为；抽到 runtime/store、runtime/guards 时保持。
- 没有既有 Note 承接 `index.ts` 模块拆分；本 Note 是唯一属主。

## Consequences

### Acceptance criteria

1. `src/index.ts` ≤ 250 行，只保留公开导出与 `apply` 组装；不再定义 protocol/note/runtime/guard/tool handler 主体。
2. 新增模块符合目标结构，依赖方向单向；`tools`/`commands` 不 import `index`，`protocol` 不 import runtime，`notes` 不 import runtime。
3. 公共导出集合与拆分前一致：`apply`、`inject`、`Config`、`DISCUSS_ORCHESTRATION`、`PLAN_ORCHESTRATION`、`IMPLEMENT_ORCHESTRATION`、`FIX_BUG_ORCHESTRATION`、`DOCS_ORCHESTRATION`、`NOTE_LIFECYCLE_ORCHESTRATION`、`GATE_RECORD_NODES`、`NODE_METHODS`、`WORKER_NODES`、`transformImplemented`、`PHASES`、`defaultState`、`normalizeState`、`loadState`、`saveState`；新增 `test/registry.mjs` 对 `Object.keys(lib)` 做精确集合比较。
4. `pnpm typecheck`、`pnpm build`、`pnpm test`、`pnpm -C packages/gate test`、`pnpm verify-notes` 全部通过；`pnpm test` 包含新增的 registry/import-graph/行数检查。
5. 行为不变：现有 unit/composition 全绿；新增 registry 快照比较 tool name/description/parameters/input-schema/output-schema 与 command name/input hint/注册顺序；`render`/函数值不比较 identity，只比较源码文本或存在性；procedure 文本与 `apply` 注入顺序不变。
6. `lib/index.js` 仍是单入口；package exports/files、cordis patch、skills/launchers 路径不变。
7. 新增 `packages/gate/scripts/check-split.mjs`：从 `src/index.ts` 走 import 图检查无环、无反向 import（tools/commands→index、notes→runtime、protocol→runtime），并断言 `index.ts` **总行数** ≤ 250（与 AC1 同一指标）；失败时 `pnpm test` 失败。
8. 单 StateRuntime：每个 `apply` 只调用一次 `createStateRuntime`；tools/commands 只用 `deps.store`，projection key `gate` 只注册一次；`makeWake` 只由 `runtime/gate.ts` 提供。

### Risks

- **循环 import**：tools/commands 需要 runtime/notes/protocol；若模块反向 import index，会形成环。缓解：`GateDeps` 注入、依赖方向表、`check-split.mjs`、每步 typecheck/build/test。
- **闭包行为漂移**：`apply` 里的 `store`、`wake`、`reviewLimit`、`ctx` 被多个注册共享；拆分时若各自 new 一份会破坏 state。缓解：单例 `deps`，测试验证 save/load 与命令行为。
- **注册顺序变化**：systemPrompt、guard、pre-step、commands、tools 的顺序可能影响 DSH 行为。缓解：index 保持原顺序，`tools/index.ts` 按原顺序调用。
- **公共导出丢失**：测试/外部导入依赖 index re-export。缓解：export snapshot + registry 测试。
- **`transformImplemented` 位置变化**：note finalize 使用它；从 index re-export，实现移动到 notes。现有测试不直接 import 它，export-parity 测试会覆盖公共面。
- **registry 快照脆弱**：新增/修改工具 schema 或命令 hint 会要求同步更新快照；这是有意的行为合同，不是行为漂移。
- **拆分后模块行数**：`record`/`commands` 仍可能接近 350 行；若超过 350，再按“命令组/工具子步骤”二次拆分，不把大文件重新堆回 index。
- **diff 大**：一次移动 2,000 行难 review；按 5 步顺序，每步测试，必要时分阶段提交。
- **类型路径/相对 import**：TS NodeNext 使用 `.js` specifier；移动后 esbuild/tsc 解析。缓解：typecheck + build。
