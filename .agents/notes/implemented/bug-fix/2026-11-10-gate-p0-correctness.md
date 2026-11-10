# Agent Note: Gate P0 — 正确性与边界安全

Status: implemented

工作项：在[仓库/插件包边界](../process/2026-11-10-repo-plugin-boundary.md)落地后，修复现有 gate 会让流程错误推进或让写门禁失效的 P0 问题；不改变整体架构，也不承担 B 的 DSH 原生重构。

## Problem

边界 Note 已经把仓库治理层与 `packages/gate` 分开，但插件行为仍是旧实现：`test.mjs` 是 fake Host，不能证明真实 Loader；插件也未安装到 profile。P0 要修的是“已知会错”的行为，而不是把插件重写成安全边界。

具体缺陷：

- **worker prompt 用错状态**：[index.js](../../../../packages/gate/index.js) 的 system prompt 用 `loadState(gate.root, context.agent)` 读取当前 agent；子 agent 的 `context.agent` 是 worker 自己，于是 worker 看到 `discuss`，`## Method files` 为空，而主代理被要求派 worker。
- **entry/cap/blocked 可绕过**：`enterPhase` 不检查 `work`、`blockReason`；review 达到 5 轮后设置 `work=blocked`，但再次 `/gate-enter-implement` 会重置 rounds；`requiresDiscussion` 后同样可以重新进入。旧 `implement-gate` 的 proposed/mechanical 工作项检查在新代码里只剩死函数。
- **invalid config fail-open**：marker JSON 坏或缺字段时，`tools/pre-execute` 直接 `next()`；`enabled:false` 是显式停用，但 status 没有区分“停用”和“损坏”。
- **写门禁面不完整**：只拦 `write`/`edit`，不拦 `apply_patch`；`forceCode` 被忽略；`Remove-Item -Recurse .agents` / `rm -rf .` 不保护保护项的祖先；`workingDirectory` 与 `sandboxPolicy` 的路径基准不一致；配置文件按“非代码”放行。
- **verify 自证**：只检查 evidence 路径存在，命令字符串不执行；任意已存在文件都能通过。
- **打包与可验证性缺失**：没有 `locale`/`icon`，没有 `Config`，没有真实 Loader 组合测试；`REPO_ROOT` 仍从包外读仓库 `.agents`。

## Decision

### 1. P0 范围

| 工作流 | 内容 |
|---|---|
| P0-1 包边界 | 删除 `REPO_ROOT`/`NOTE_SKILL`；`methodFiles` 从 gate root 解析项目级 notes 资源；缺资源时给出 `notes-skill-required`；skill 设置 `resourceBase`/`path` |
| P0-2 Worker/state | system prompt 使用 root 状态；worker 只显示自己的 node；`gate_record` 只允许 root 调用；`rootOf` 失败时回退到 durable `parentSession` |
| P0-3 Entry/cap/blocked | `enterPhase` 要求 task、`work==='active'`、`blockReason===null`、未 `exhausted`；接回 `workItemAllowed`；review cap 与 `requiresDiscussion` 进入 blocked；invalid marker fail-closed；docs 由 `gate_record({node:'docs'})` 结束 |
| P0-4 写工具面 | 覆盖 `apply_patch` 与已知写工具；使用 `forceCode`；拒绝保护路径的祖先目录；按 `workingDirectory` 分类；`gate-init` 默认把包配置/CI 算 code；未知工具不假装识别 |
| P0-5 Verify | evidence 必须是 gate workspace 内的普通文件，记录 size/sha256；未执行命令标记 `selfReported: true` |
| P0-6 打包/展示/Config | `locale/en.json`、`locale/zh.json`、`icon.svg`、exports/files；`Config.reviewLimit`；项目级 notes 资源进 marker 的 `notesSkillPath`；真实 Loader 验证 |
| P0-7 文档/测试 | 包 README 只写插件契约；根 README/docs 属主表；旧 notes 的路径/状态同步；`npm test` |

### 2. 关键技术决定

**资源解析顺序**：项目 marker 的可选 `notesSkillPath`（相对 gate root，禁止绝对路径/`..`）→ `gate.root/.agents/skills/write-agent-notes` → 明确错误 `notes-skill-required`。P0 不把仓库的 `write-agent-notes` 复制进包，也不从插件包外读它；profile 级 Config 不承载项目资源。

**docs 完成**：`gate_record` 支持 `node: 'docs'`，只允许 `phase==='docs'` 时调用；它结束 docs 回到 discuss。

**review 上限与 requiresDiscussion**：都进入 `phase='blocked'`，保存 `blockedFrom` 与 `blockReason`；只有用户 `/gate-resume` 能恢复；`exhausted.plan/code` 阻止重新进入 implement。`enterPhase` 在 blocked 下拒绝；`gate-return-discuss` 也不能绕过 blocked。

**写入范围**：P0 不追求完整安全边界。`apply_patch` 与已知写工具显式拦截；未知工具不假装识别（否则会误伤只读工具），README 写明它只是流程门禁，不是 OS 级强制。`forceCode`、目录删除、保护祖先、`workingDirectory` 基准都在 P0 修复；`node -e`、`npm install`、`make`、任意 shell 语义不在 P0 覆盖范围，B 用 sandbox/guard 处理。

**verify**：P0 只做“证据可审计”，不假装执行了命令；未执行命令标记 `selfReported: true`，不能冒充独立验证。B 再把 verify 绑定到 worker/tool result。

**config 状态**：invalid（JSON 坏、缺 required、unknown key）fail-closed；`enabled:false` 是显式停用，pass-through，但 `/gate-status` 与 system prompt 显示“已停用”。

### 3. 非目标

- 不实现 B 的 session projection/guard/sandbox 重构；
- 不把仓库 `AGENTS.md`/`GATES.md` 接入插件运行时；
- 不移除旧 `@dsh-nove/gate`/`implement-gate`（迁移留给 B）；
- 不新增 UI；
- 不追求 shell 命令的完整静态分析。

## Implementation

- P0-1：移除 `REPO_ROOT`/`NOTE_SKILL`；plan 从 marker 的 `notesSkillPath` 或 `<gate root>/.agents/skills/write-agent-notes` 解析；技能注册带 `path`/`resourceBase`。
- P0-2：system prompt 使用 root 状态；worker 只显示自己的 node；`gate_record` 只允许 root 调用；真实 subagent 中 `rootOf` 不可靠时按 `origin:'subagent'` 的 `parentSession` 回退。
- P0-3：`enterPhase` 检查 task、`work`、`blockReason`、`exhausted`；plan 的 task 必填；review cap/`requiresDiscussion` 进入 blocked；invalid marker fail-closed；`enabled:false` pass-through 且 status 可见；docs 由 `gate_record({node:'docs'})` 结束。
- P0-4：覆盖 `apply_patch` 与已知写工具；使用 `forceCode`；拒绝保护路径的祖先目录；按 `workingDirectory` 分类；`gate-init` 默认把包配置/CI 算 code；未知工具不假装识别。
- P0-5：evidence 限制在 gate workspace 内、必须是普通文件（含符号链接拒绝），记录 size/sha256；结果标记 `selfReported: true`。
- P0-6：`Config.reviewLimit`；`locale/en.json`、`locale/zh.json`、`icon.svg`；exports/files 更新。
- P0-7：unit 测试扩展覆盖新增行为；包 README 重写；根 `npm test` 跑 unit + composition manifest checks。

## Implementation Review

- **Standards**：真实 Loader 组合已通过临时安装验证（`gate_record` 可执行、技能注册、root/worker prompt 实际出现）；`composition.mjs` 仍只做 manifest/export 检查，Config catalog status=`unsupported`。README 中仓库路径已改为“包含本 package.json 的目录”。重复的 gate guard、节点 switch、状态字段 clump 与中文 model-facing 文本作为 judgement 保留，B 阶段处理；`gate_record` 的关键失败码已补 reason。
- **Spec**：修复了 `gate-return-discuss` 绕过 blocked、`enterPhase` 重入重置 review 轮次、主代理在 revise/code-review/verify 节点丢失协议、verify 接受符号链接、`notes-skill-required` 无错误码、`trash.mjs`/`git apply|merge|stash`/review orchestration 范围蔓延；`node -e`/`npm install`/`make` 明确列为 P0 限制。live root/worker prompt 已验证。
- 结论：P0-1..7 实现与验收检查完成；Config catalog 投影与 shell 完整性作为残余风险，进入 B。

## Verification

- 结果：**PASS**。
- PASS：`gate_record` root-only/node、entry/cap/blocked、review 轮次、invalid/disabled、`apply_patch`/`rm -rf .`/`git clean`/包配置分类、verify evidence hash/selfReported、locale/icon/manifest、`npm test`、`npm run verify-notes`、`node --check`。
- 真实 Loader：临时安装后 root prompt 显示 `状态：orchestrating`、`节点：plan`、`## Method files`；worker prompt 显示 `Gate worker`、同一 plan 状态与 5 个 method files。worker 的 `gate_record` 被 auto-review 拦截，没有推进状态。插件随后移除，marker/state 已清理。
- 残余限制：`Config` 在 Config catalog 中 status=`unsupported`（Cordis 接受 Standard Schema，但 DSH catalog 只投影 schemastery 原生图）；`composition.mjs` 仍只覆盖 manifest/export；shell 与 verify 的完整性属于 B。
- P0 Note 已完成，转入 implemented。

## 后续工作项

B 的正式设计已 implemented：[Gate B — DSH 原生状态与强制](../architecture/2026-11-10-gate-dsh-native.md)。它承接 session projection、guard/restrict/sandbox、worker 证据绑定、Config catalog 与旧 gate 迁移；AC1 fallback/AC5 自动化保留为 residual。

## Alternatives considered

**只修测试，不动行为。** 最强理由是风险最小；但 worker prompt、cap 绕过和 fail-open 是确定错误，只修测试会掩盖问题，故不采用。

**直接做 B，跳过 P0。** 最强理由是一次性对齐 DSH；但 B 依赖状态与强制模型的重要决定，周期长，期间现有插件仍不可用，故先做 P0，再做 B。

**只依赖 sandbox `read-only` 做所有阶段。** 最强理由是强制最可靠；但 planning 需要写 proposed Note、implement 需要写代码，单一 read-only 会阻断流程，故 P0 仍保留分类门禁，B 再用分阶段 sandbox + 专用写入口。

## Consequences

### 验收结果

1. 真实 Loader 中 root/worker prompt 节点分别正确：PASS（live install 验证）。
2. 子 agent 不能推进 `gate_record`：PASS（unit root-only；live 由 auto-review 拦截）。
3. 无 task、无 proposed Note/`mechanical:`、blocked 时拒绝 implement：PASS。
4. review 5 轮后不能靠重新 enter 绕过：PASS（`exhausted` + rounds 保留）。
5. invalid marker fail-closed；`enabled:false` pass-through 且可见：PASS。
6. `apply_patch`/`rm -rf .`/`git clean`/保护祖先/包配置分类：PASS（限已知模式）。
7. verify evidence 项目内普通文件 + size/sha256 + `selfReported`：PASS。
8. locale/icon/Config/marker notesSkillPath/真实 Loader：PASS（Config catalog `unsupported` 为残余风险）。

### 代价与残余风险

- **Config catalog**：`Config` 是 Cordis 可接受的 Standard Schema，但 DSH catalog 不投影；Config UI/schema 未覆盖，留给 B。
- **写入面与 verify**：P0 仍是启发式与自报；README 明确“不是安全边界”。
- **测试表面**：`composition.mjs` 只覆盖 manifest/export；真实组合依赖临时 profile 安装，未固化为自动测试。
- **偶然路径修复**：`REPO_ROOT` 在本仓库“看起来正常”不是 P0-1 的验收；验收以 notes 资源解析与安装路径为准。
- **B 的边界**：P0 保留 `tools/pre-execute` 与 side-file state；B 需要迁移，不能把 P0 的局部修复当成最终架构。
