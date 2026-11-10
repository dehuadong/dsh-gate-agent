# Agent Note: 内置 write-agent-notes 与 Verify 后 lifecycle

Status: implemented

工作项：解决 gate 对项目级 `write-agent-notes` 的安装依赖；让 `/gate-init` 幂等初始化 notes 根和 AGENTS.md；planning 按 `write-agent-notes` §3/§4 判定 Note 归属与分类；Verify PASS 后、commit 前完成 Note lifecycle。class：`process`（gate 工具链/生命周期）。关联并部分取代：[gate-planning 与 Agent Note 的整合](../../proposed/process/2026-11-07-implement-gate-orchestrated-phases.md)；相关边界决定：[repo/plugin 边界](./2026-11-10-repo-plugin-boundary.md)。

## Problem

- 项目必须自带 `.agents/skills/write-agent-notes`，e2e 手工复制；`notes-skill-required` 使安装不完整。
- 项目安装/项目副本会产生版本漂移；面向 standalone 的 npm/`npx tsx` 指令在 gate 项目不可执行。
- planning 没有明确按 `write-agent-notes` §3 检索、§4 判定归属，Note 分类随意。
- Verify PASS 直接 complete，Note 可能仍是 proposed；commit 前没有可靠的 lifecycle 门。
- 项目没有稳定的 notes 校验入口。

## Decision

范围：

- 插件内置一份 gate 专用的 notes 技能与脚本，项目不复制 skill/scripts；`/gate-init` 只生成一个 `verify-notes` 启动器和 `package.json` script。
- `/gate-init` 幂等创建 `.agents/notes/` 根、AGENTS.md managed block、`.agents/gate/verify-notes.mjs` 和 `package.json` 的 `verify-notes` script；不创建技能目录。
- planning 使用 §3/§4，记录 Note 归属、class、决策证据。
- Verify PASS 后进入独立 `note-lifecycle` 节点；finalize + 校验通过才 complete。
- 提供 `gate_note_verify`、`gate_note_finalize` 和 `/gate-note-verify`；工具返回 state projection。
- 保留 `notesSkillPath` 字段兼容，但不再使用/不再报 `notes-skill-required`。

不包含：

- 不把 write-agent-notes 复制到目标项目；
- 不修改 docs 节点语义；
- 不承诺 gate 会话之外的 commit；
- 不自动生成 24 个空分类目录。

验收见 [Acceptance criteria](#acceptance-criteria)。

## Design

### 1. 内置来源与技能名

```text
packages/gate/skills/gate-write-agent-notes/   # 插件内置、唯一的运行时 notes 技能
```

- `packages/gate/skills/gate-write-agent-notes` 是 gate 的默认 notes 方法，也是运行时唯一来源；项目 `.agents/skills/write-agent-notes` 不参与解析，即使存在也不影响 gate。
- 注册技能名为 **`gate-write-agent-notes`**，避免项目同名技能以 project rank 遮蔽 runtime skill；注册内容直接来自内置 `SKILL.md`。
- 内置 `SKILL.md` 已改写为 gate 专用：使用 `gate_note_verify` / `/gate-note-verify` / lifecycle 工具，不包含项目安装、`npm run` 或 `npx tsx` 指令。
- planning 加载 `gate-write-agent-notes`，不加载项目同名技能；项目同名技能保留但被忽略。

### 2. Node 执行

`gate_note_verify` 不假设 `process.execPath` 是 Node：

- 普通 `node` 进程：用 `process.execPath`；
- Electron/desktop：优先 `DSH_DESKTOP_NODE_EXECUTABLE`（仅当实际存在），其次 `path.join(process.resourcesPath, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')`；`process.resourcesPath` 覆盖 Windows 与 macOS `Contents/Resources`，不硬编码安装布局；
- desktop host 已继承 `ELECTRON_RUN_AS_NODE=1` 时仍显式定位真实 node，不用 `process.execPath` 冒充；
- 都不可用时返回 `notes-runtime-unavailable`，不伪造 pass；
- 用 `execFile`（无 shell）+ `--root <gate.root>/.agents/notes`，cwd 为 gate root；
- 单测覆盖 plain Node、`process.resourcesPath`、环境变量缺失、平台路径分支；真实 desktop 布局作为手工 smoke，不写成自动 AC。

### 3. `/gate-init`

- 预设启用即生效；不再读取 marker。重复 init 只做幂等 provisioning，并返回“已初始化 + provisioning 结果”。
- 创建 `.agents/notes/` 根，以及 `proposed/`、`implemented/`、`rejected/`、`archived/` 四个 lifecycle 根（各放 `.gitkeep`，以便 git 跟踪）；**不预建 24 个 class 目录**，class 目录由首篇 Note 创建。这样 `verify-agent-note-lifecycle.ts` 不会因缺根目录 ENOENT。
- AGENTS.md：
  - 缺失时创建；
  - managed block `<!-- gate-notes:start -->` / `<!-- gate-notes:end -->`；
  - 已有 block 时只替换 block 内内容；block 外内容不改；
  - 目标路径是 symlink 时拒绝；
  - 内容说明使用内置 `gate-write-agent-notes`、§3/§4、commit 前运行 `/gate-note-verify`。
- 不创建 `.agents/skills/write-agent-notes`，不改 package scripts；`notesSkillPath` 保留为 accepted-but-deprecated。
- 不创建、不读取 marker；重复 init 可修复部分 provisioning。

### 4. Planning §3/§4

`gate-planning` Step 0：

- 加载 `gate-write-agent-notes`；
- §3 检索使用 gate 可用的 `grep` / `glob` / `read`，不依赖 shell `rg`（planning worker 的 shell 被 deny）；主 agent 可先检索后把证据交给 worker；
- §4 判定：既有决定未变则原地同步；新想法 `proposed`；class 六选一；
- §3 的 `grep`/`glob`/`read` 检索证据写进 `noteSearch`；
- 原地同步需要编辑 `implemented` Note：扩展 `gate_note_write`，允许路径前缀 `implemented/`，但只允许编辑已存在的 implemented 文件；新建仍只能 `proposed/`。路径经 `isInside` + symlink 校验；`proposed/` 默认保持现有 API；
- `gate_record({node:'plan'})` 记录：
  - `notePaths[]`：`{path, class, lifecycle:'proposed'|'implemented'}`；
  - `noteDecision`：`new|in-place|update|mechanical`；
  - `noteSearch`：检索摘要/证据；
- 一致性：`new` 只能 proposed 新建；`update` 只能更新已有 proposed；`in-place` 只能更新已有 implemented；`mechanical` 必须空 `notePaths` 且 task 以 `mechanical:` 开头（复用 `isMechanical`），否则拒绝——不能只靠 `noteDecision` 自证；非 mechanical 至少一篇；
- `notePaths` 允许多篇（同一产品合同分开承接）；`plan-revise` 可更新，`/gate-enter-plan` 重置这些字段与 `noteVerified`；
- **implement 入口改为读取 `state.notePaths`**，不再调用 `hasProposedNote(root, task)`；`mechanical` 直接放行，implemented 原地同步也放行。`hasProposedNote` 仅保留为旧数据兼容/诊断。

### 5. notePath 契约

- 路径必须是 `.agents/notes/{proposed|implemented}/<class>/yyyy-mm-dd-<topic>.md`；
- class 属于 `feature|bug-fix|simplification|architecture|process|testing`，只存在 `notePaths[].class`，不另设 `noteClass`；
- 拒绝 symlink、`..`、越界、未知 lifecycle/class、缺日期或深度不符；plan 期即要求文件存在、`Status` 与 lifecycle 一致；
- **节规则不手写**：plan 期把目标 Note 复制到临时根 `.agents/notes/.gate-validate-<id>/<lifecycle>/<class>/...`，只对该副本运行内置 `verify-agent-note-format`（含 REQUIRED/BANNED 与中英文别名），避免无关 Note 违规阻断 plan；临时根用完即删。其余 Note 的错误留到 note-lifecycle 四检。`notePaths` 只做路径/存在/Status/同 topic 唯一性；新增 parity 测试：同一 fixture 同时喂 plan 期校验与内置 format，并覆盖“无关 Note 违规时目标仍通过”。proposed/implemented 的必需/禁止节以脚本为唯一来源（当前 implemented 未禁 `### Risks`，plan 不额外禁）。
- 同 topic 唯一性覆盖 `proposed`、`implemented`、`rejected` 三个 lifecycle（对齐 `verify-agent-note-lifecycle.ts`），不能只查 proposed+implemented；
- `path` 的 class/lifecycle 与字段冲突时直接报错，不以路径静默覆盖；
- `implemented` 条目表示原地同步，lifecycle 不移动，只校验；
- 无 Note 的 `mechanical` 工作项跳过 lifecycle；非 mechanical 的空 `notePaths` 直接拒绝。

### 6. Verify → lifecycle

- Verify PASS 不直接 complete；state 进入 `node='note-lifecycle'`，phase 保持 orchestrating，work active；agent 侧 read-only，只有 `gate_note_finalize` 工具可写。
- 新增 gate node `note-lifecycle`；`gate_record` enum 增加该 node；`PLAN_ORCHESTRATION`/`IMPLEMENT_ORCHESTRATION`/`phaseMethod`/planNodes/implementNodes/statusText 都要包含它。
- `noteVerified` 的唯一定义：所有 `notePaths` 都处于 `implemented/<class>/`（或本来就是 implemented 的原地同步），`Status: implemented`，四检通过，且不存在同 topic 的 proposed/rejected 副本；`mechanical` 工作项以 `noteVerified=true` + `noteDecision='mechanical'` 跳过。
- 唯一完成序列：`gate_note_finalize` → `gate_note_verify`（置 true）→ `gate_record({node:'note-lifecycle'})`；不得跳步或只跑 `/gate-note-verify` 报告。
- `noteVerified` 复位：`/gate-enter-plan`、`/gate-enter-implement`、`gate_record plan/plan-revise`、verify FAIL、finalize 任何失败、`/gate-resume` 后状态重建。旧 true 不得让新工作项直接 complete。
- `note-lifecycle` 只在 `noteVerified === true` 时 complete；`gate_record({node:'verify'})` PASS 返回 `lifecycle-required` 或 `lifecycle-skipped`。
- 失败修复：finalize 失败回滚并留在 note-lifecycle；verify 失败留在 note-lifecycle；其他 Note 的全局违规（坏链接、rejected 重题）在阶段内没有修复工具，`/gate-return-discuss` 后经 `/gate-docs` 修复 notes，再重进 planning。`/gate-docs` 是修复入口，不是 verify→complete 的替代。archived manifest 的迁移例外：由用户执行 `/gate-note-seal` 显式完成，不属于 docs 修复。
- commit 守卫扩到所有 active 编排阶段（plan/implement/verify/note-lifecycle）：未 complete 时字面 `git commit` 被拒绝；`git add` 允许。守卫是命令级软门（`git -c ... commit`、脚本内 commit、docs/discuss 不在内），sandbox/approval 仍兜底；外部 commit 不在 gate 控制内，合同表述为“gate complete 前完成，并在 gate 会话内尽量阻止未 lifecycle 的 commit”。
- `/gate-docs` 保持 discuss/complete 入口和原语义，不承担 lifecycle。

### 7. Tools 与状态

- `gate_note_verify`：root-only；运行四条校验；返回 `presentationMeta` 含最新 `gate.state`；失败返回结构化输出；只有 node=`note-lifecycle` 且所有路径已 post-lifecycle 时才把 `noteVerified` 置 true，其他 phase 只报告不置位。
- `gate_note_finalize`：root-only；先按 session 校验并恢复自己的 journal，再按 state `notePaths` 处理 proposed 条目；可选 `decisionBodies: {path, body}` 供主 agent 提交现在时正文，工具替换 `## Decision` 正文后移动；返回 state projection；已完成/implemented 条目只校验；任何失败回滚且不置 `noteVerified`。
- **不注册 `gate_note_seal` 工具**：archived manifest 迁移只通过用户命令 `/gate-note-seal` 执行；模型不能自行调用确认。命令等价于 `verify-archived-agent-notes.ts --write`，生成 manifest 后返回 state；默认 init/verify 只报告 `archived-manifest-missing`。
- `/gate-note-verify`：gate 会话命令；在 plan/plan-revise/implement/note-lifecycle 可运行，只返回校验报告，**不修改** `noteVerified`，不能绕过 note-lifecycle；命令的 state 快照由 command event 重放，不新增状态写路径。
- `gate_note_verify` / `gate_note_finalize` 必须像 `gate_record` 一样输出 projection 快照，否则 resume/replay 后 `noteVerified` 丢失。
- 状态 plumbing：`WORKER_NODES` 不包含 `note-lifecycle`（它是 root 工具节点，不能要求 workerSessionIds）；`normalizeState` 对 `notePaths` 归一为数组、`noteVerified` 归一为布尔、`noteFinalizeRecovery` 归一为数组，拒绝畸形旧快照透传。
- journal 名带 owner session id：`.agents/notes/.gate-finalize-<sessionId>.json`；finalize/verify 只恢复 owner 与当前 root session 一致的 journal，其他会话的 journal 只报告 `journal-owned-by-other-session`，不修改 source/backup。恢复触发点固定为 note-lifecycle 的 finalize/verify 工具调用前，不在插件 apply 时扫描项目。
- 崩溃残留：journal 存在但 temp/backup 均缺 → 删除 journal 并报告 `journal-orphan`；journal 缺失但有 `.<name>.gate-backup` → 仅当 backup 名与 state.notePaths 匹配时恢复，否则报告 `orphan-backup` 不动文件。
- AGENTS.md 的提交前入口写 `/gate-note-verify`（只报告）；gate 内完成 lifecycle 的唯一序列是 `gate_note_finalize` → `gate_note_verify` 工具 → `gate_record({node:'note-lifecycle'})`。

### 8. finalize 顺序与原子性

1. 读取并校验 source；目标不存在；source/target 非 symlink；topic 唯一；Status/lifecycle 一致。
2. 在内存中转换：`Status: implemented`；计划段固定为顶层 `## Plan`、`## Proposal`、`## Acceptance criteria`、`## Risks` —— `## Proposal`→`## Decision`，Acceptance/Risks 正文按顺序并入唯一的 `## Consequences`（`### Acceptance criteria` / `### Risks` 子节），`## Plan` 删除；其他 H2 内容不动，不删除实质内容。可选 `decisionBodies` 用于主 agent 提供现在时 Decision 正文；未提供时只做结构改写，正文时态列入 Risks/已知限制。
3. 在 `.agents/notes/.gate-finalize-<sessionId>.json` 写 journal（owner/sessionId/source/target/backup/temp/phase），用固定隐藏名 `.gate-finalize-<topic>.tmp` / `.<name>.gate-backup`（不以 `.md` 结尾，避免 tree 误判）；先写 temp，再把 source rename 为 backup，最后把 temp rename 到 target。
4. 运行 format/lifecycle；失败则删除目标、按 journal 恢复 source backup、删除 journal；成功后删除 backup/journal。
5. 启动或新一次 finalize 前按 journal 恢复；**只处理 owner=当前 root session**，其他会话 journal 只报告不动：
   - source 缺失、backup 存在、target 缺失 → 恢复 source；
   - source 缺失、backup 存在、target 存在 → 先校验 target；通过则删 backup/journal，失败则删 target、恢复 source；
   - source 存在、backup 存在、target 不存在 → 删 backup/journal；
   - journal 但 temp/backup 均缺 → 删 journal，报告 `journal-orphan`；
   - journal 缺失但 `.gate-backup` 存在 → 仅当 backup 名匹配 state.notePaths 时恢复，否则报告 `orphan-backup` 不动文件；
   - 恢复事件写入工具返回值和 state `noteFinalizeRecovery`，不静默吞掉。
6. implemented 条目跳过移动，只运行校验；不覆盖已有 Note；目标已存在、source 被移走、symlink 替换等 TOCTOU 都在写入前失败。
7. 工具返回转换后的 Note 路径、差异摘要和 state；主 agent 只审查语义合并，不直接写文件。

### 9. 兼容与取代

- marker 配置解析已移除；`notesSkillPath` 不再参与技能解析。
- 本 Note 部分取代 [repo/plugin 边界](./2026-11-10-repo-plugin-boundary.md) 4.2 中“项目级 notes skill 解析”的部分；boundary note 已同步为已实现事实。
- 旧篇 [2026-11-07](../../proposed/process/2026-11-07-implement-gate-orchestrated-phases.md) 的“唯一载体”保留；“插件不复制”由本 Note 改为“插件内置，项目不复制”；旧篇已加反向链接。
- 内置技能不改写 boundary rule 3 的运行时禁令：插件不读取仓库 `.agents`；仓库 `.agents/skills/write-agent-notes` 只是开发期仓库治理，不是插件运行时来源，也不是需要同步的“上游”。
- `packages/gate/README.md` 的 notes skill/`notesSkillPath` 章节随实现同步更新，列入范围与 AC。

## Alternatives considered

- **项目级 skill 保留，插件只注册。** 安装仍不完整，e2e 问题不解决；拒绝。
- **内置并复制到项目。** 两份 skill/scripts 漂移；用户明确拒绝；拒绝。
- **注册 `write-agent-notes` 原名。** project rank 会遮蔽 runtime skill，规划加载到错误方法；拒绝，改用 `gate-write-agent-notes`。
- **Verify 内直接 finalize。** Verify 只读证据边界被破坏；拒绝。
- **复用 docs 做 lifecycle。** docs 从 discuss/complete 进入且无条件结束，语义冲突；拒绝，新增 `note-lifecycle`。
- **单 notePath。** 无法支持多 Note、implemented 原地同步、mechanical；拒绝，改 `notePaths[]`。
- **项目 package scripts。** 路径依赖 profile，且用户要求不写项目 scripts；拒绝，gate 工具/命令替代。

## Consequences

### Acceptance criteria

1. `/gate-init` 可重复执行；创建 `.agents/notes/` 及 `proposed/`、`implemented/`、`rejected/`、`archived/` 四个 lifecycle 根（`.gitkeep`），不预建 class 目录；创建 AGENTS.md managed block；不创建 `.agents/skills/write-agent-notes`，不写项目 package scripts；`.agents`/`.agents/notes`/AGENTS.md 的 symlink 被拒绝；部分失败可重跑修复，测试用只读目录或 fs hook 注入失败点。
2. 注册 `gate-write-agent-notes`；项目同名技能不遮蔽；`notes-skill-required` 不再出现；README 命令章节与实际一致。
3. planning 使用 `grep/glob/read` 执行 §3；`gate_record plan` 记录 `notePaths/noteDecision/noteSearch`（class 在 notePaths 内）；plan-revise 可更新，enter-plan 重置。
4. `notePaths` 支持多 Note、proposed/implemented、mechanical 豁免；路径/日期/class/Status/同 topic（含 rejected）唯一/symlink 在 plan 期校验；非 mechanical 空路径拒绝；noteDecision（new/update/in-place/mechanical）与 lifecycle 一致；节规则以内置 format 为准，plan 只校验目标副本，并有 fixture parity 测试（含无关 Note 违规时目标仍通过）。
5. Verify PASS 进入 `note-lifecycle`；`noteVerified` 的定义和复位按 §6；未 finalize/verify 不能 complete；失败阻断；`gate_record` 与两个新工具都返回 state projection；resume 后状态不丢；`PLAN_ORCHESTRATION`/`IMPLEMENT_ORCHESTRATION`/`phaseMethod`/status 都包含 note-lifecycle。
6. finalize 原子移动、目标冲突/TOCTOU/symlink 失败、校验失败回滚；`.gate-finalize-<sessionId>.json` 的 source 缺失/backup+target 双在/仅 backup/temp+backup 均缺/跨会话 owner 五个 case 都有定义；implemented 条目只校验；计划段删除；固定 fixture 逐节断言转换前后无内容丢失，Acceptance/Risks 转入 Consequences 子节；可选 decisionBodies 可替换正文。
7. 所有 active 编排阶段未 complete 时字面 `git commit` 被 guard 拒绝；`git -c ... commit`/脚本内 commit 明确不在软门内；`/gate-note-verify` 只报告不置 `noteVerified`；`/gate-note-seal` 是唯一 archived manifest 迁移入口，模型不能直接调用工具确认；docs 原语义不变。
8. 内置 `SKILL.md` 是 gate 专用：不要求项目安装技能或 tsx；`/gate-init` 生成 `npm run verify-notes` 启动器，只调用插件内置脚本；项目同名技能不影响 gate。
9. 测试：`npm test`、`npm run verify-notes`、`node --check packages/gate/index.js`；临时项目 fixture 覆盖 init 幂等/AGENTS/四根/planning notePaths/verify→lifecycle/finalize rollback/command；Node resolver 覆盖 plain、`process.resourcesPath`、环境变量缺失、平台分支；skills 列表与 prompt 断言覆盖 `gate-write-agent-notes` 和 note-lifecycle；`normalizeState` 对 notePaths/noteVerified/noteFinalizeRecovery 归一化、`WORKER_NODES` 不含 note-lifecycle 有断言。不宣称真实 Loader。
10. 旧 note 与 boundary note 有反向链接且 boundary 已同步为“已实现”事实；`/gate-docs` 回归测试通过；README notes 章节更新并用 grep 断言不再把 `notesSkillPath` 描述为 planning 必需。
11. archived 缺 manifest 的迁移：init/verify 报 `archived-manifest-missing` 且不自动写；只有用户执行 `/gate-note-seal` 才生成 manifest；模型侧没有可直接确认的工具；未确认时 note-lifecycle 不能以“已 sealed”通过，测试覆盖命令执行与拒绝两条路径。

### Risks

- 内置技能与仓库治理里的同名技能可以独立演进；内置技能是运行时权威，更新时需人工同步，不依赖项目或仓库源。
- Electron/desktop Node 路径随 DSH 安装布局变化；无法解析时明确失败，不能静默跳过。
- finalize 的语义合并（Acceptance/Risks→Consequences）与现在时正文仍要主 agent 审查；未提供 `decisionBodies` 时工具只做结构改写，format 不检查正文时态，这是明确的已知限制。
- 多 Note 的 notePaths 让 plan 记录变大；需要 schema/状态序列化测试。
- 现有项目自定义 notes 结构可能与内置不同；verify 报迁移错误，而不是猜。
- commit 守卫只覆盖 gate 会话；外部 commit 不在合同内。







