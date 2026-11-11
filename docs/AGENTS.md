# 文档标准

本文件是本仓库文档的统一入口，登记各类文档的属主与位置，以及新工件应写入的位置。本仓库为单上下文项目，管理根为仓库根（本文件与 `AGENTS.md` 所在目录）；仓库治理层与插件包层分开，插件包位于 `packages/gate/`。下文 Markdown 相对链接以本文件位置为基准；表格中的仓库路径以仓库根为基准。

## 文档分层

仓库文档分四层：入口与规则（根 `README.md`、`AGENTS.md`、`.agents/GATES.md`、本文件；插件入口在 `packages/gate/README.md`）、方法与技能（`packages/gate/skills/` 与 `.agents/skills/`）、运行时代码（`packages/gate/src/`、`packages/gate/index.js` 及其注释）、长期记录（`.agents/notes/` 的 Agent Note）。每层只写自己的主题，其他位置链接到属主，不复制事实。

## 现有文档属主

| 文档 | 属主职责 |
| --- | --- |
| `README.md` | 仓库总览与入口；链接插件包、文档与流程 |
| `packages/gate/README.md` | 插件入口：命令、典型用法、`gate_record` 与 Verify 证据格式 |
| `AGENTS.md` | Agent 行为规则：Discuss 工作流、DSH 插件开发参考 |
| `.agents/GATES.md` | 阶段授权、准入、返回与审查收敛规则 |
| `.agents/notes/` | Agent Note：长期技术提案、设计、决定、备选与理由；格式与生命周期遵循 `write-agent-notes` Skill |
| `.agents/skills/` | 项目级技能实现；技能正文拥有各自方法 |
| `packages/gate/skills/<name>/SKILL.md` | 插件专项技能：gate-planning、gate-plan-review、gate-implement、gate-code-review、gate-verify |
| `packages/gate/skills/gate-write-agent-notes/` | 插件内置 write-agent-notes 方法、引用与脚本；gate 默认使用，项目不需要安装同名技能 |
| `packages/gate/src/`、`packages/gate/index.js` | 插件运行时：Gate 状态、分类与写权限 |
| `packages/gate/cordis.patch.yml` | 插件 bundle 装配 |
| `docs/AGENTS.md` | 本入口：文档属主与新工件位置 |
| `docs/agents/domain.md` | 领域文档消费规则：术语表与决策冲突 |
| `GLOSSARY.md` | 领域术语表；由 `domain-modeling` 在术语确定时创建 |

## 项目归属配置

| 内容或类型 | 启用方式与适用范围 | 属主、位置与规则入口 |
| --- | --- | --- |
| 工作项 | 已启用；本次交付范围、产品行为与验收 | 当前任务/对话；本仓库不使用 Issue 跟踪器 |
| 工作状态、评审与批准证据 | 已启用；工作项推进 | 当前任务/对话；Gate 状态见 `/gate-*` 命令与 `gate_record` |
| Agent Note | 已启用；长期技术提案、设计、决定、备选与理由 | `.agents/notes/`；格式与生命周期遵循 `write-agent-notes` Skill；工作项链接到 Note |
| 独立 RFC／ADR | 新工作未启用 | 相应技术设计与决定归 Agent Note |
| 独立 Spec | 按需启用；跨工作项持续生效的行为合同 | 首次使用前先登记合同属主、适用范围、位置与规则，再创建正文 |

## 一个事实一个家

每个事实由负责它的属主完整说明，其他位置只链接。工作项拥有状态、评审与批准证据；跨工作项持续生效的合同按需由独立 Spec 拥有；长期技术设计与决定归 Agent Note。仓库治理事实留在根、`.agents/` 与 `docs/`；插件安装、运行时与展示事实留在 `packages/gate/`，两者不互相引用。新增或实质改写的文档使用相对链接，历史引用不要求专项清洗。

## 仓库与插件包边界

- `packages/gate/` 是唯一可安装插件包；根 `package.json` 只承载仓库脚本。
- 插件运行时只读包内资源与目标项目工作区；不得读仓库 `.agents/`、`docs/`、`AGENTS.md`。
- 仓库 `AGENTS.md`、`GATES.md` 不是插件运行时契约；若本仓库自举启用 gate，另加集成说明，明确 `/gate-*` 是本仓库的运行时门禁。
- 目录边界决策见 [`../.agents/notes/implemented/process/2026-11-10-repo-plugin-boundary.md`](../.agents/notes/implemented/process/2026-11-10-repo-plugin-boundary.md)。

## 写作规则

- **写当前状态**：变更过程归工作项；长期设计依据与决定归 Agent Note。
- **事实与推论分开**：可核实的事实标明证据位置，例如用例名、命令或留档路径；推论与待确认事项明确标注。
- **用能指向具体对象的词**：写端点、字段、类型、命令或行为本身；复用 `GLOSSARY.md` 已定义的术语。
- **一个段落一行**：用编辑器软换行；表格、代码块和列表保持原有格式。

## 检查

Agent Note 的目录、格式、正文骨架与本地链接由 `write-agent-notes` Skill 的校验命令检查，入口为管理根的 `npm run verify-notes`。机械检查通过不代替对事实归属与内容真实性的审阅。


