# Agent Note: Gate 阶段/角色读写权限与 access 可视化

Status: implemented

工作项：本次会话“gate 阶段读写权限与 access”。本 Note 承接阶段/角色的文件、Note、shell 与仓库写权限，以及模型可见的 access。commit 建议时机由 [Gate commit 策略](../../implemented/process/2026-11-12-gate-commit-policy.md) 承接；本 Note 不改变 commit 建议时机。

## Problem

当前权限分散且模型不可见：

- planning worker 的 `read`/`glob`/`grep` 可用，`gate_note_write` 可用，但 `write`/`edit`/`apply_patch` 和 `pwsh`/`bash` 被整个隐藏；planning 连只读 shell 都不能用。
- discuss root 在现有 [root 写权限](../../implemented/architecture/2026-11-12-gate-root-write-policy.md) 下可写文件。模型常见行为是：用户一句话后先写文件，随后才发现需要阶段授权，导致错误写入、返工和额外 token。
- `gate_status`/procedure 不显示当前读写权限。模型只能从工具被隐藏或 guard 报错反推，先尝试再失败。
- 文件写、Note 写、shell 写和仓库写（`git add/commit/push`）混在同一个“写”概念里，导致 discuss 只读与“提交已有改动”冲突。

用户确认：

- planning worker：**A**：只读 shell + `gate_note_write`，产品写仍拒绝；
- discuss root：**A**：默认只读文件，写入时拒绝并提示先授权进入阶段；
- discuss 仍允许 `git add/commit/push`，避免“只提交”被强制进入 implement；
- implement/fix worker 保留 `push`。

## Decision

### Decision

#### Access 模型

```ts
type WriteScope = 'none' | 'workspace'
type ShellMode = 'read' | 'write'
type RepoWrite = 'none' | 'push'

interface GateAccess {
  read: boolean
  write: WriteScope
  noteWrite: boolean
  shell: ShellMode
  repoWrite: RepoWrite
}
```

- `write`：工作区文件写（`write`/`edit`/`apply_patch`/写型 shell）。
- `noteWrite`：`gate_note_write` 与 lifecycle 工具的可用性描述；`gate_note_write` 的硬限制仍由工具自身 planning-worker 检查，不是独立 guard。
- `shell`：`read` 允许非写 shell，`write` 允许写型 shell。
- `repoWrite`：`none` 禁止 `git add/commit/push`；`push` 允许 add/commit/push。

### 权限矩阵

| 阶段/角色 | read | write | noteWrite | shell | repoWrite |
|---|---:|---|---:|---|---|
| `discuss` root | ✅ | none | ❌ | read | push |
| `plan` / `plan-revise` planning worker | ✅ | none | ✅ | read | none |
| `plan-review` review worker | ✅ | none | ❌ | read | none |
| `implement` / `implement-revise` / `fix-bug` worker | ✅ | workspace | ❌ | write | push |
| `code-review` / `code-review-standalone` / `proposal-review` worker | ✅ | none | ❌ | read | none |
| `verify` / `verify-standalone` worker | ✅ | none | ❌ | read | none |
| `note-lifecycle` root | ✅ | workspace | ✅ | write | push |
| `docs` root | ✅ | workspace | ❌ | write | push |
| `blocked` root | ✅ | none | ❌ | read | push |
| `blocked` worker | ✅ | none | ❌ | read | none |
| `complete` root | ✅ | workspace | ❌ | write | push |
| 其他 root orchestrating/reviewing | ✅ | workspace | ❌ | write | push |

说明：

- discuss root 的文件写从 `allow` 改为 `none`；这是对 root 写权限 Note 的部分修订。
- discuss root 的 `repoWrite=push` 保留“提交/推送已有改动”的能力；文件写仍拒绝。
- planning worker 只读 shell + `gate_note_write`，不能借 shell 做 `git add/commit/push`。
- review/verify worker 有只读 shell；写型 shell 和仓库写都拒绝。
- note-lifecycle/docs/complete 的 root 写权限保持现状；docs 仍可写 workspace，不在本次收紧。
- blocked 保留现有 commit 策略；文件写仍冻结。

### 单一来源

新增纯模块 `src/access.ts`（依赖 state 类型与 `classify.ts` 的 `gitSubcommands`），导出 `accessFor(state, worker): GateAccess`、`accessText(access)` 和 `repoCommands(command)`。`runtime/guards.ts`、`tools/status.ts`、`tools/record.ts`、`tools/start-phase.ts`、`runtime/prompt.ts` 都从 `access.ts` 导入，避免 protocol→runtime 或 guards→protocol 的层级冲突。

- `restrictionFilter` 从 access 派生：`write === 'none'` 时 deny `write`/`edit`/`apply_patch`；shell 工具不再整体隐藏，由 guard 区分读/写。
- `workerWriteAllowed` 使用 `access.write === 'workspace'`。
- `workerShellAllowed` 使用 `access.shell === 'write'`。
- `gateDenyReason` 使用 access 判断文件写、shell 写、仓库写。
- `gate_status` 对 worker 使用 worker access，对 root 使用 root access；`/gate-status` 命令同样按调用者身份计算；`gate_record`/`gate_start_phase` 使用 root access；worker prompt 使用 worker access。

不允许多处手写权限表。

### 仓库写检测

`git add/commit/push` 在 `shellAccess` 里是 `write:false`，不能依赖它判断。guard 必须增加显式 `repoCommands`：

```ts
// 按 && || ; 换行 | 分段；每段把 git/git.exe 后面的 token 解析到子命令：
// - 跳过无值全局选项（如 --no-pager、--literal-pathspecs）
// - 跳过带值全局选项及其值：-C <path>、-c <k=v>、--git-dir[=]<path>、
//   --work-tree[=]<path>、--namespace[=]<name>、--config-env[=]<k=v>
// - 第一个非选项 token 才是子命令；只识别 add/commit/push
repoCommands(command): Set<'add' | 'commit' | 'push'>
```

- `repoWrite === 'none'`：拒绝 add/commit/push；
- `push`：允许三类；
- `git stash`/`apply`/`merge`/`restore` 等修改工作树的命令归入文件写分类，不能借 repoWrite 绕过。
- `git.exe` 与 `git` 同等处理；`-C`/`-c`/`--git-dir`/`--work-tree`/`--namespace`/`--config-env` 必须跳过其值，不能把值当子命令。
- root discuss 为 `push`，所以提交/推送不被文件只读拦截；`git checkout/reset/clean` 仍是文件写，discuss 拒绝；
- planning/review/verify worker 为 `none`，即使 shell 只读可见也不能提交。

### 错误信息

- discuss root 文件写：
  > discuss 文件只读；要修改请先取得用户授权，然后 `gate_start_phase({node:'plan'|'implement', brief})` 或 `/gate-enter-plan` / `/gate-enter-implement`。提交已有改动不受影响。
- planning worker 写：
  > planning worker 只允许 `gate_note_write`；产品文件和仓库写被拒绝。
- review/verify worker 仓库写：
  > 当前 review/verify worker 不允许仓库写。
- 其他 blocked/写型 shell 沿用现有明确错误。

### Access 展示

`accessText(access)` 输出：

```text
权限：read=yes write=none noteWrite=no shell=read repoWrite=push
```

展示位置：

- `gate_status`：root/worker 状态行；worker 分支用 `accessFor(state, true)`，root 用 `accessFor(state, false)`；
- `/gate-status` 命令：用 `rootAgentOf(ctx, invocation.agent)` 与 invocation.agent.id 判断 worker，再追加对应 access；`statusText` 本身不猜 worker；
- `gate_record`：结果 `access` 字段，render 的 JSON 可见；
- `gate_start_phase`：结果 `access` 字段；
- 命令 follow-up：`makeWake` 的 procedure 文本追加 access；
- worker prompt：`installSystemPrompt` 的 worker 分支追加 access；
- root 静态 `gate:protocol` 不加入动态 access，避免破坏 prompt cache。

### 用户流程

```text
用户：帮我改 X
模型：discuss 只读分析、确认范围
用户：批准进入 plan/implement
模型：进入阶段后写文件、测试、提交
```

```text
用户：把 X 文案改一下，直接做
模型：取得授权，gate_start_phase({node:'implement', brief})
模型：写文件、验证、提交
```

```text
用户：提交当前改动
模型：discuss 直接 git add/commit（repoWrite=push）
```

### 非目标

- 不把 gate 变成 OS 安全边界；access 是流程提示，硬拒绝仍由 guard/restrict。
- 不改变 commit 建议时机，不恢复自动 commit。
- 不增加 `direct-edit` 新阶段；快速修改仍通过直接 `implement`。
- 不收紧 note-lifecycle/docs/complete 的 root 文件写；docs 仍为 workspace。
- 不改变 review/verify 的只读内容语义。

## Implementation evidence

- 新增 `src/access.ts`：`accessFor`/`accessText`/`repoCommands`；guard、restriction、status、record、start-phase、wake、worker prompt 共用。
- 共享 `gitSubcommands` 同时驱动文件写分类和 repoCommands；覆盖 `git -C`、`-c`、`--git-dir`、`--work-tree`、`--namespace`、`--config-env`、`git.exe`、`git log --grep commit`。
- planning worker：只读 shell 可用；write/edit/apply_patch、仓库写拒绝；`gate_note_write` 可用。
- discuss root：文件写/写型 shell 拒绝；只读 shell；git add/commit/push 允许。
- access 已进入 gate_status（root/worker）、/gate-status、gate_record、gate_start_phase、命令 follow-up、worker prompt。
- 测试覆盖 access 矩阵、global-option git、discuss/planning/review/verify 行为、registry/export snapshot。
- 残余：`git stash list` 会被保守地当文件写拒绝；`npm test`/build 等只读 shell 仍可能写盘（既有分类边界）。

## Alternatives considered

1. **只改 planning worker 的 shell，不改 discuss root**：解决 planning 读能力，但 discuss 仍会先写文件，浪费未解决。否决。
2. **discuss root 完全只读，包括 `git add/commit/push`**：边界最纯，但“只提交”必须进入 implement 或手动终端；用户明确要求保留提交能力。否决。
3. **让 planning worker 完全可写**：实现更方便，但 plan-review 会评审已发生实现，计划被否决时还要回滚。否决。
4. **只在 prompt 里说明权限，不改 guard**：零代码风险，但模型仍可能先写；不可靠。
5. **新增 `/gate-commit` 代替 discuss 仓库写**：更显式，但增加新命令/合同；当前 `repoWrite=push` 已够用。保留为未来选项。

## 已有 Note 审计

- [Gate root 写权限](../../implemented/architecture/2026-11-12-gate-root-write-policy.md)：其 discuss root 可写文件（:133）、review/verify worker 的 pwsh/bash 被隐藏（:142）和 AC5/6 被本 Note 部分取代；root 在 note-lifecycle/docs/complete 的写策略保持不变。实施时在旧 Note 加 2026-11-13 指针并更新这些事实，不改写旧 Decision。同步 `runtime/workers.ts`/`notes.ts`/README 中“planning shell 被拒绝”的旧文案。
- [Gate commit 策略](../../implemented/process/2026-11-12-gate-commit-policy.md)：commit 建议时机不变；本 Note 只增加 `repoWrite` guard，discuss 仍允许 commit/push。
- [Planning 必读 rfc 与 Note/verify 契约](../../implemented/process/2026-11-12-gate-planning-resources-and-note-contracts.md)：planning worker 的 Note 写入口仍为 `gate_note_write`；本 Note 只增加只读 shell。
- [Gate 方法论与 procedure](../../implemented/architecture/2026-11-12-gate-methodology-procedure.md)：access 展示在动态 procedure/status，不改变静态方法论文本。
- 没有既有 Note 承接 access 模型；本 Note 是唯一属主。

## Consequences

### Acceptance criteria

1. `accessFor` 是唯一权限来源；`restrictionFilter`、`workerWriteAllowed`、`workerShellAllowed`、`gateDenyReason` 不再各自维护矩阵；`noteWrite` 仅描述 `gate_note_write`/lifecycle 工具，不另设 guard。
2. planning worker：`read`/`glob`/`grep` 与只读 shell 可用；`write`/`edit`/`apply_patch` 拒绝；写型 shell 拒绝；`git add/commit/push` 拒绝；`gate_note_write` 允许。
3. discuss root：文件写与写型 shell 拒绝并返回可操作提示；只读 shell 可用；`git add/commit/push` 允许。`DISCUSS_ORCHESTRATION` 与 discuss procedure 的“可自行读/写”文案同步改为只读。
4. review/verify/standalone worker：只读 shell 可用；文件写、仓库写拒绝；`git add/commit/push` 显式拒绝。
5. implement/fix worker：工作区写、写型 shell、`repoWrite=push` 保持。
6. blocked 文件写冻结；blocked root 保留 commit/push，blocked worker 无仓库写；note-lifecycle/docs/complete 的 root 权限保持现状。
7. `gate_status`（root/worker 分别用对应 access）、`/gate-status` 命令（按调用者身份）、`gate_record`、`gate_start_phase`、命令 follow-up、worker prompt 显示 access；`statusText` 不隐式猜测 worker；root 静态方法论不包含动态权限。
8. 测试覆盖 access 矩阵、planning shell 读写、discuss 文件写/commit、review/verify 仓库写、`git log --grep commit` 不被误判、`git -C repo commit`/`git -c k=v commit`/`git --git-dir .git commit`/`git.exe commit`/`git --work-tree . push` 被识别、`git stash` 等文件写、gate_status root/worker access；更新现有 unit（discuss root 写、review/verify shell）断言和 readme/worker 文案。
9. `pnpm typecheck`、`pnpm build`、`pnpm test`、`pnpm -C packages/gate test`、`pnpm verify-notes` 全绿。
10. root write Note 与 planning 权限描述同步更新；插件 README 的阶段/权限表同步。

### Risks

- **discuss 只读影响快速修改**：用户必须授权进入 implement；这是有意取舍，换取不先写错文件。直接 implement 不要求 planning。
- **只读 shell 仍可能写盘**：`npm test`/build、`node -e` 等命令可能绕过显式写分类；access 是流程提示，不是 OS 隔离。测试只覆盖显式写命令，残余风险保留。
- **仓库写与文件写分离**：discuss 可 commit/push 但不可改文件；如果用户要求改文件后立刻提交，模型仍需先进入阶段。
- **权限漂移**：多处判断容易不一致；必须由 `accessFor` + 测试锁住。
- **快照变化**：`access` 字段会改变 gate_status/record 输出；不改变工具 schema registry snapshot；新增 access 断言。
- **note-lifecycle/complete 仍可写文件**：与“只写 Note”的理想不完全一致；本次保持现状，避免扩大范围。
