# Agent Note: Gate commit 策略与 gate-init git bootstrap

Status: implemented

工作项：本次会话“commit 限制实测 + gate-init git 初始化”。本 Note 承接 commit 策略与 `gate-init` 的 git/`.gitignore` 初始化；root 写权限、planning rfc 必读、notePaths/verify/finalize 契约由已 implemented 的 [Gate root 写权限](../../implemented/architecture/2026-11-12-gate-root-write-policy.md) 和 [Planning 必读 rfc 与 Note/verify 契约](../../implemented/process/2026-11-12-gate-planning-resources-and-note-contracts.md) 承接。

## Problem

真实会话 `session-32d4939c-57f6-46c1-98fa-6cef2469ade6` 的 implement worker 在第一步建 git 基线时被 gate 拒绝：

```text
Error: Note lifecycle 未完成：gate 会话内拒绝 git commit
```

代码在 [index.js:969-970](../../../../packages/gate/index.js) 对列出的 active 编排节点硬拒绝 `git commit`（plan/plan-review/plan-revise/implement/code-review/implement-revise/verify/note-lifecycle/fix-bug；proposal-review/code-review-standalone 不在旧列表），但 `docs`/`discuss`/`complete` 不在列表里；gate 自己的 `commitGateChanges` 又通过 `execFileSync` 内部提交，完全绕过该 guard。规则既过度限制又不自洽。

结果是：用户只能在 gate 外手动执行 `git commit` 才让 implement 继续；基线 commit `69fba8d` 是用户手动创建的。

另外，`gate-init` 目前只初始化 notes/AGENTS/verify-notes/CI，不初始化 git；测试项目第一次实施时只能由 implement worker 手工 `git init`。基础 `.gitignore` 也不存在，最终自动 commit 才把用户临时创建的 `.gitignore` 扫进了交付。用户确认：`gate-init` 应初始化仓库并创建基础忽略文件。

gate 在 note-lifecycle 自动执行 `git add -A + git commit`，最终 commit `41d1a10` 把工作区里未跟踪的 `.gitignore` 也扫了进去，而计划的非目标明确写了“不加 `.gitignore`”。自动提交不仅不是“建议”，还会改变交付范围。

用户确认的目标：

- commit 只应在 **plan 验收通过**、**implement 验收通过**这两个点建议；
- 其他阶段不应被 gate 硬限制 commit；
- commit 由用户/主 agent 自己决定，gate 不应自动 `git add -A + commit`。

## Decision

### 范围与非目标

本次调整：

- 删除 `gateDenyReason` 的按 active node `git commit` 硬拒绝；只保留 worker 角色限制（planning/review/verify 只读 worker 不能 commit）；
- 删除 `commitGateChanges` 及其在 note-lifecycle / fix-bug / verify-standalone / mechanical verify 的自动提交；
- 在 plan 验收、implement 验收两个点通过 `commitHint`/procedure 文本给出提交建议；
- `gate-init` 初始化 git 仓库并创建基础 `.gitignore`（不 commit、不覆盖已有文件）；
- 更新 README、lifecycle/root-write Note 指针和测试。

非目标：

- 不增加“commit 才能完成 gate”的条件；
- 不引入 Config 开关（自动提交 opt-in 作为未来工作）；
- 不改变 note lifecycle 的 finalize/verify 语义；
- 不改变 blocked/root write 策略；
- 不读取仓库 `.agents/GATES.md`/`AGENTS.md`。

### 行为

| 时点 | gate 行为 |
|---|---|
| discuss / plan / plan-review / plan-revise | root `git commit` 允许；plan review 通过后提示“建议提交 planning baseline” |
| implement / code-review / implement-revise | root `git commit` 允许；不额外提示 |
| verify（非 mechanical） | root `git commit` 允许；进入 note-lifecycle，不在 verify 处提示；note-lifecycle 完成后提示 |
| verify（mechanical） | root `git commit` 允许；verify PASS 直接回 discuss，提示“建议提交实现” |
| fix-bug / verify-standalone | root `git commit` 允许；不自动提交，也不加额外提示（不属于 plan/implement 验收链） |
| note-lifecycle 完成 | root `git commit` 允许；提示“建议提交本次实现与 Note”；不自动提交 |
| blocked | root `git commit` 允许；显式写工具/写型 shell 仍冻结；commit 无阶段硬限制 |
| worker commit | implement/implement-revise/fix-bug 允许；planning/plan-review/review/verify worker 拒绝 |
| discuss / complete / docs | root `git commit` 允许；无 gate 阶段硬限制 |

提交建议是**模型可见的提示**，不是完成条件；不提交也可以 `gate_record` 完成 note-lifecycle。gate 不再执行 `git add`/`git commit`；commit 只保留 worker 角色限制。

### 设计

**1. 删除阶段 guard，只保留 worker 角色限制**

删除 `gateDenyReason` 里按 active node 拒绝 commit 的分支：

```text
if (git commit regex && active node) return 'Note lifecycle 未完成：gate 会话内拒绝 git commit'
```

但 `git commit` 在 `src/classify.js` 里被分类为 `write:false`；如果只删上面分支，会绕过后面的 worker 检查。因此保留一个窄检查：

```text
if (isCommit && effective.worker && !['implement','implement-revise','fix-bug'].includes(state.node)) return `worker ${node} 不允许 git commit`
```

- root 在所有 phase/node 可以 commit，包括 blocked；blocked 的显式写工具/写型 shell 冻结不变；
- implement/implement-revise/fix-bug worker 可以 commit；
- planning/review/verify worker 仍只读，不能 commit；
- 不按 active node 拒绝 root commit。

**2. 删除自动提交**

删除 `commitGateChanges` 函数及**全部四个**调用：

- `gate_record({node:'note-lifecycle'})` 不再返回 `commit-failed`；
- `gate_record({node:'fix-bug'})` 不再自动提交；
- `gate_record({node:'verify-standalone'})` PASS 不再自动提交；
- `gate_record({node:'verify'})` 且 `noteDecision === 'mechanical'` PASS 不再自动提交；
- `gate_record` 的 `commit-failed` 失败路径删除。

note-lifecycle 仍要求 `noteVerified=true`，完成时回 discuss；工作区可能仍有未提交改动，由用户/主 agent 决定。

**3. 提交建议**

在 `gate_record` 的成功结果中增加可选 `commitHint`：

- plan-review 空 findings → `建议提交 planning baseline（Note + 计划）`；
- mechanical verify PASS → `建议提交实现`；
- note-lifecycle 完成 → `建议提交本次实现与 Note`；
- 非 mechanical verify 在进入 note-lifecycle 时不发 `commitHint`；只在 note-lifecycle 完成时提示一次；
- fix-bug/verify-standalone 不自动提交，也不加额外提示。

同时更新 procedure 文本：

- `gate_record` 的 plan-review 空 findings 结果直接带 `commitHint`；不依赖不存在的 `PLAN_STEP_3`；
- `IMPLEMENT_ORCHESTRATION` **Step 4** 删除“回 discuss 前 gate 会 git add -A + git commit”整句；改为“note-lifecycle 完成后建议提交”。注意 Step 4 不在 `NODE_PROCEDURES` 的 Step 1-3 抽取范围内，这是 stale-text cleanup，不是模型可见提示；模型可见提示来自 `commitHint` 和 `NOTE_LIFECYCLE_ORCHESTRATION`；
- `NOTE_LIFECYCLE_ORCHESTRATION` 增加“完成后建议提交本次实现与 Note”；不自动提交；
- `FIX_BUG_ORCHESTRATION` Step 4：去掉“gate 会 git add -A + git commit”，不再自动提交；
- `REVIEWING_VERIFY_PROCEDURE` 没有 commit 文案；移除代码自动提交并同步 README，不加额外提示；
- `IMPLEMENT_STEP_3` 不含 commit 文案，不在本次编辑范围。

`commitHint` 只是文本字段；不改变工具成功条件，不要求模型执行提交。

**4. gate-init git bootstrap**

新增 `provisionGit(root)`，在现有 notes/AGENTS/verify-notes/CI 初始化之后执行：

- 用 `git rev-parse --is-inside-work-tree` 的 **stdout** 判断：`true` 表示已在工作区；其他情况（包括 bare repo 的 `false`、非零 exit）统一尝试 `git init -b main`，旧 git 不支持 `-b` 时回退 `git init`；不创建 commit；
- git 可执行文件缺失时报告 `git: unavailable`；`git init` 非零（损坏/权限等）报告 `git: init-failed` 和 stderr，不把 notes 初始化失败一并吞掉；bare repo 只是不是 work tree，`git init` 可能成功重初始化，不预先判定失败；
- `.gitignore` 不存在时创建基础文件；已存在则保持原样，不覆盖、不合并；
- `git` 不可用时 `gate-init` 仍成功完成 notes 初始化，返回 `git: unavailable` 并创建 `.gitignore`；不把 git 缺失当成 notes 初始化失败；
- `gate-init` 结果文本包含 `git`（initialized/existing/unavailable）和 `ignore`（created/existing）状态；重复执行幂等。

基础 `.gitignore`：

```gitignore
node_modules/
.env
.env.*
!.env.example
*.log
.DS_Store
Thumbs.db
coverage/
dist/
.agents/notes/.gate-finalize-*
.agents/notes/.gate-validate-*
.agents/notes/*.gate-backup
```

**5. 文档与测试**

- README 的 gate-init、note-lifecycle、fix-bug、verify-standalone 和已知限制同步：gate-init 段落（README:11/12/18）加 git init/.gitignore 说明，commit 段落删除自动 commit 并改为提交建议；
- [2026-11-10-gate-notes-builtin-lifecycle](../../implemented/process/2026-11-10-gate-notes-builtin-lifecycle.md) 的 commit 守卫/自动提交段落加“2026-11-12 部分取代”指针，不改写旧 Decision；
- 测试：
  - 覆盖全部 `GATE_RECORD_NODES` + discuss/complete/docs 的 root `git commit` 允许（含 blocked）；blocked 的显式写工具/写型 shell 仍拒绝；
  - worker commit：implement/implement-revise/fix-bug 允许，planning/plan-review/review/verify worker 拒绝；
  - `gate_record` note-lifecycle/fix-bug/verify-standalone/mechanical verify 不产生 commit、不改变 git status；
  - 未跟踪文件在 gate 完成后仍是未跟踪，不被 `git add -A` 扫入；
  - `commitHint` 在 plan-review 空、mechanical verify PASS、note-lifecycle 完成出现，普通 verify 不出现；
  - `gate-init` 在非 git 工作区创建 `.git` 和基础 `.gitignore`，且不产生 commit；重复执行幂等；测试使用确定的非 repo fixture，避免 tmpdir 位于上层 work tree 时误判；
  - 已有 git 仓库不重新 init；已有 `.gitignore` 保持原内容，不被覆盖/合并；
  - git 不可用（PATH/stub）时 notes 初始化仍成功，`.gitignore` 创建，结果 `git: unavailable`；`git init` 非零报告 `git: init-failed`；结果包含 `git:`/`ignore:` 状态；
  - 使用真实临时 git 仓库（`git init` + user.email/user.name）或 git stub，避免 `not-git` 空转；
  - `npm test`、`verify-notes`、`node --check` 全绿。

### 决策与未决

已决定：

- 采用 A：commit 只建议，不自动、不硬限制；
- plan 验收和 implement 验收是两个建议点；
- gate 不再执行 `git add`/`git commit`；
- 自动提交 opt-in 留作未来 Config 工作，不在本次范围。

未决：

- 无。

## 已有 Note 审计

- [2026-11-10-gate-notes-builtin-lifecycle](../../implemented/process/2026-11-10-gate-notes-builtin-lifecycle.md)：其 commit 守卫/自动提交与 gate-init provisioning（§3/AC1）被本 Note 部分取代；note lifecycle 的 finalize/verify 语义不变。该篇是 decision，在 :112、:171、:184 和 gate-init §3/AC1 加 2026-11-12 指针，不改写正文。
- [Gate root 写权限](../../implemented/architecture/2026-11-12-gate-root-write-policy.md)：其“commit 守卫不变”、AC2“git commit 拒绝保持不变”和依赖 `commitGateChanges` 的 `git add -A` 叙述被本 Note 部分取代；root/blocked 的写矩阵不变，只增加 commit 的 worker 角色窄限制（blocked 的 root commit 也允许）。该篇加指针，不改写 root 写决定。
- `packages/gate/README.md` 的 note-lifecycle/fix-bug/verify-standalone commit 段落和已知限制由本 Note 更新；README:317 的 root 写在 review/verify 的限制仍成立，只删除自动 `git add -A` 的那一半。
- 没有其他 Note 承接 commit 策略；不新建重复模型。

## Implementation evidence

- `npm test` ALL CHECKS PASSED；`node --check` 通过；`verify-notes` 12 篇通过。
- 测试覆盖：root 在 plan/blocked 的 commit 允许、review worker deny、implement worker allow；plan-review 空/mechanical verify/note-lifecycle 的 `commitHint`；真实 git repo 的 note-lifecycle 不自动 commit；`gate-init` 创建 `.git`/基础 `.gitignore`、已有 ignore 保留、已有 repo 不重复 init、git unavailable 不失败、gate-init 不产生 commit。
- `commitGateChanges` 与 `commit-failed` 已删除；gate 不再执行 `git add`/`git commit`。
- 残余：gate-init 的 `git init` 依赖真实 git；测试路径需要 git；旧会话不自动恢复 sandbox mode（既有 residual）。

## Alternatives considered

1. **保留硬 guard，只在 plan/implement 允许 commit。** 最强理由：防止未验收代码被提交。否决：用户要求 commit 只是建议；live session 证明 guard 会阻断 implement 的基线提交，且 gate 自己的自动提交绕过它，规则不自洽。
2. **保留 note-lifecycle 自动提交，只去掉硬 guard。** 最强理由：保证回 discuss 前有 commit。否决：自动 `git add -A` 会把 `.gitignore` 等未计划文件扫入（live `41d1a10`）；用户要求“建议”而不是自动提交。
3. **自动提交改为 Config opt-in。** 最强理由：保留喜欢自动提交的用户。否决：本次不引入 Config；作为未来工作项。
4. **只删 guard，不改 README/测试。** 最强理由：最小代码改动。否决：文档仍声称 commit 被拒绝/自动提交，测试无法防回归。

## Consequences

### Acceptance criteria

1. root 在所有 phase/node（含 blocked）`git commit` 允许；blocked 只冻结显式写工具/写型 shell；worker commit 仅 implement/implement-revise/fix-bug 允许，planning/review/verify worker 拒绝；不再出现“Note lifecycle 未完成：gate 会话内拒绝 git commit”。
2. `commitGateChanges` 删除，gate 不再执行 `git add`/`git commit`；note-lifecycle/fix-bug/verify-standalone/mechanical verify 不因 commit 失败而失败，不自动提交。
3. 未跟踪/无关文件在 gate 完成后保持原状态，不被 gate 自动 stage/commit。
4. plan-review 空 findings、mechanical verify PASS、note-lifecycle 完成的结果/过程包含可读的 `commitHint` 或等价提交建议；建议不是完成条件；普通 verify、fix-bug、verify-standalone 不提示。
5. `gate-init` 在非 git 工作区创建 `.git` 和基础 `.gitignore`，不产生 commit；重复执行幂等；已有 git/`.gitignore` 不被重写；git 不可用时 notes 初始化仍成功并报告 `git: unavailable`；`git init` 失败报告 `git: init-failed`；结果文本包含 `git`/`ignore` 状态。
6. README、lifecycle/root-write Note 指针、`IMPLEMENT_ORCHESTRATION` Step 4、`NOTE_LIFECYCLE_ORCHESTRATION`、`FIX_BUG_ORCHESTRATION` 和测试同步；`npm test`、`npm run verify-notes`、`node --check` 全绿。
7. 不新增 Config；不改变 note lifecycle 的 finalize/verify；blocked 的显式写冻结不变，commit 不再有阶段硬限制。

### Risks

- 不再自动 commit 后，discuss 回到时工作区可能有未提交改动；README 必须明确“用户/主 agent 自行提交”，不能把 gate 完成误认为已提交。
- 提交建议可能被模型忽略；这是有意的软约束，不应用 gate failure 兜底。
- 删除 `commitGateChanges` 会改变依赖自动提交的旧用户工作流；README 记录迁移方式（手动 commit 或等待未来 opt-in）。
- 建议点覆盖 plan/implement；docs/fix-bug/verify-standalone 不提示，也不强制。
- `gate-init` 只在“不在 git 工作区”时 init；目录位于上层 git 仓库内时不会创建嵌套仓库。已有 `.gitignore` 不合并基础条目，用户可能缺少某些忽略项；这是“不覆盖用户文件”的取舍。
- `git init -b main` 依赖较新的 git；旧版本回退 `git init` 后默认分支可能是 `master`。README 说明分支名由 git 配置决定，不把 `main` 当契约。
- git 不可用时仍创建 `.gitignore`，但不初始化仓库；`gate-init` 报告 `git: unavailable`，后续需要用户安装 git 后手动 init。
