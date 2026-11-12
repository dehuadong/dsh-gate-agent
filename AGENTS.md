## 工程工作流 

工程任务从 Discuss 开始。

### Discuss


使用 Discuss 理解问题，结合现有代码、文档、历史决策、已接受的 ADR/RFC 和项目约束形成解决方案，并消除足够的歧义，以判断下一阶段。

讨论不是被动访谈。优先自行分析已有项目上下文，而不是把可判断的问题交给用户。

讨论过程中：

- 明确实际问题、约束和相关既有决策
- 提出有实质差异的可行方案，并在依据充分时给出推荐
- 说明关键权衡、风险和影响
- 发现假设与现有事实或决策冲突时，明确指出
- 仅在缺少必要信息，或涉及未决的产品、业务、范围、兼容性、成本、风险及其他价值判断时，请求用户裁决

不要要求用户重复已有信息，也不要求在 Discuss 中确定所有实现细节。

在以下情况下继续停留在 Discuss：

- 工作仍处于探索阶段
- 仍在比较重要的备选方案
- 用户当前只是寻求理解，而不是准备推进
- 目标或选定范围尚不足以形成实施合同

不要仅因为正在讨论产品、技术或架构决策，就创建规划产物。

若可以判断讨论已经足够成熟，并说明已解决事项、剩余未决事项和建议的下一阶段，但不能仅凭自身判断离开 Discuss。

何时从 Discuss 进入 Planning 或 Implementation Gate，由用户决定。若用户此前的请求已经明确授权推进，则复用该授权。

讨论后推进、直接收到阶段请求或恢复工程工作时，读取并按 `.agents/GATES.md` 的 Steps、授权与返回规则执行；具体工作方法由对应技能负责。

任务汇报之后，提示用户输入下一步门禁指令（以 `.agents/GATES.md` 为准）：


- 收到 `批准，使用技能 planning 执行规划 {工作项}` 时加载 `planning`，完成规划及必要评审后回到 Discuss。
- 收到 `批准，使用技能 implement 执行实现 {工作项}` 时加载 `implement`。若关键合同仍未解决，指出 blocker 并建议先 `planning`，不自行进入规划。

执行授权仅适用于**当前工单已确认范围的实施工作**，并覆盖该工作内部连续发生的：

- 实施
- Implementation Review
- 范围内修正
- Verify

这些阶段之间不需要重复请求执行授权。

文档和仓库治理工作可以绕过该工程工作流；涉及重要产品、技术、架构或其他工程合同变化时，仍遵守 GATES 门控规则。

## 仓库结构

- 仓库治理层：根 `AGENTS.md`、`.agents/`、`docs/`、`deepseek-harness/`（开发用目录联接，gitignored）。
- 插件包层：`packages/gate/`，唯一 `dsh.bundle`。
- 插件运行时不得读取仓库 `.agents/`、`docs/`、`AGENTS.md`；项目级资源从 gate root 或 Config 解析。
- 目录边界决策见 `.agents/notes/implemented/process/2026-11-10-repo-plugin-boundary.md`。

## DSH 插件与预设

在开发deepseek-harness 插件时遇到问题可参阅deepseek-harness官方源码工程包 `deepseek-harness/packages`（仓库根下的目录联接）
DSH 开发文档参考：`deepseek-harness/docs`

## 文档与约定

文档遵循 [`docs/AGENTS.md`](docs/AGENTS.md)：文档分层、位置、职责与写法。

- Domain docs：单上下文，领域术语表位于根 `GLOSSARY.md`（术语确定时由 `domain-modeling` 创建）；术语与决策消费规则见 [`docs/agents/domain.md`](docs/agents/domain.md)。
- Agent Note：长期技术提案、设计、决定与备选存放在 `.agents/notes/`，格式与生命周期遵循 `write-agent-notes` Skill；本仓库不使用 Issue 跟踪器，工作项由当前任务/对话承载并链接到 Note。

## npm 发布

发布 `packages/gate` 到 npm 时：

1. 先 `pnpm build`，确认 `packages/gate/lib/index.js` 存在；`lib/` 是 gitignored 构建产物。
2. 在 `packages/gate` 目录执行 `npm pack --dry-run --json` 预览；不要从仓库根用 `npm pack packages/gate`，npm 会把它当 git spec。
3. 包不能是 `private: true`，`publishConfig.access` 应为 `public`；版本号按 semver 递增。
4. npm 命令需要访问 workspace 外的 global cache/credentials；受限 sandbox 会报 cache EPERM 或 esbuild spawn EPERM。
5. `npm publish --access public` 后，以 `npm view dsh-gate-agent version` / `dist-tags.latest` 为发布成功证据，不以 publish 命令返回为准。
6. 首次发布会自动产生 `0.0.0-stage` 占位版本；实际版本可能延迟可见，可能需要在 npmjs.com 做 2FA staged approval。不要因 placeholder 立即重发，否则可能 `E409 Cannot publish over previously staged version`。
7. 发布完成后提交版本号/发布配置并推送；profile link 安装与 npm 包是两种来源，npm 发布不会自动替换已 link 的 profile。
8. 安装/升级时不要 link 正在开发的源目录。生产安装用 npm 版本（如 `dsh-gate-agent@0.1.1`）；开发安装用本地 tarball（`npm pack` 后安装）或 link 一个可丢弃副本。Windows 上 `link:` 是 junction，卸载时递归删除可能穿过 junction 删除源目录；本次已实际发生，源文件需从 Git 恢复。

发布流程、故障排查和 0.1.0/0.1.1 实测记录见 [`2026-11-12-npm-publish-staged-release.md`](.agents/notes/implemented/process/2026-11-12-npm-publish-staged-release.md)；命令摘要见根 [`README.md`](README.md#发布)。

## 重要改动必须留笔记

1. 非平凡改动（改了行为、架构、跨文件契约、流程与工具链、测试策略、落盘/网络/配置格式）前，遵循 `write-agent-notes` Skill 写或更新笔记；机械性小改（样式、格式化、打标、不改行为的补丁）直接提交。
2. 写之前先检索 .agents/notes/ 里的同主题旧笔记：有归属就地更新；新想法先放 proposed/，落地随同代码改动转 implemented/；新方案彻底取代旧决策时，同批归档旧篇并标明被谁取代。
3. 被放弃的方案先写它最强的理由，再解释为什么不用。
4. 提交前跑 pnpm run verify-notes，红了先修再交。
