# Agent Note: gate-planning 与 Agent Note 的整合

Status: proposed

> 2026-11-10 Note [内置 write-agent-notes 与 Verify 后 lifecycle](../../implemented/process/2026-11-10-gate-notes-builtin-lifecycle.md) 部分取代本页的“插件不复制 write-agent-notes”约束：“唯一载体”仍然成立；write-agent-notes 改为插件内置，项目仍不复制。

工作项：把 `gate-planning` 与 `proposal.md`、`rfc.md`、`write-agent-notes` 整合；工作项与技术设计由同一份 proposed Agent Note 承接。

## Problem

本项目没有 Issue tracker。工作项和技术设计都由 proposed Agent Note 承接，不是两个文件。

当前插件整合存在三个问题：

- 把 `proposal.md` 当成 Proposal 文件模板，重复了 `write-agent-notes` 的模板；
- `proposal-template.md` 与 Agent Note 模板重复；
- 设计的输出阶段错位：方案设计应在 planning，而不是 discuss。

## 源工程证据

| 源工程证据 | 源工程行为 | 复刻落点与裁决 |
|---|---|---|
| `.agents/skills/planning/proposal.md` | 工作项内容：why、范围、产品合同、验收、决定、评审/批准证据 | 用于同一份 proposed Agent Note 的工作项内容 |
| `.agents/skills/planning/rfc.md` | 技术设计：备选、技术决定、边界、验证切入点 | 用于同一份 Note 的 Design 自由节 |
| `.agents/skills/write-agent-notes/SKILL.md` | Note 路径、分类、格式、生命周期、校验 | 唯一 Note 容器规则 |
| `.agents/skills/write-agent-notes/templates/proposed.md` | proposed Note 模板 | 唯一模板；2026-11-10 Note 改为插件内置 vendor，项目不复制 |
| `.agents/skills/planning/review.md` | 三轴评审、合同/设计检查、通过条件 | `gate-plan-review` 只报告；planning 决定与修正 |

## Proposal

### 1. 唯一载体

```text
proposed Agent Note
  = 工作项（Problem / Proposal / Acceptance criteria）
  + 技术设计（Design / Alternatives）
```

- 不另建 Proposal 文件；
- 不建独立 Spec；
- 不复制 `proposal-template.md`；
- 模板使用 `write-agent-notes/templates/proposed.md`。

### 2. Note 结构

```markdown
# Agent Note: <标题>

Status: proposed

## Problem
why、背景、约束

## Proposal
本次范围、非目标、产品行为、验收、决定、评审/批准证据

## Design
技术设计、边界、关键决定

## Alternatives considered
真实备选、最强理由、为什么不选

## Acceptance criteria
可观察、可判定的验收

## Risks
风险与未决问题
```

对应关系：

| 内容 | 方法 |
|---|---|
| Problem / Proposal / Acceptance | `proposal.md` |
| Design / 技术决定 | `rfc.md` |
| Alternatives / 生命周期 / 格式 / 路径 / 校验 | `write-agent-notes` |

### 3. gate-planning 职责

- 工作项内容按 `proposal.md`；
- 技术设计按 `rfc.md`；
- Note 容器按 `write-agent-notes` 的 proposed 模板与生命周期；
- 不创建第二份 Proposal；
- 接收主代理转交的 plan-review findings，按节决定并修正；
- 返回 Note 路径、工作项摘要、决定摘要、未决问题；
- 不自行宣称 Plan Review 通过。

### 4. gate-plan-review 职责

- 评审同一份 Note 的工作项节与设计节；
- 三轴：Standards / Spec / Architecture；
- 只报告 findings、节归属、通过建议；
- 不修改 Note，不更新状态，不宣称批准；
- `Spec` 轴指工作项验收合同，不是独立 Spec 文件。

### 5. Gate 协议

`/gate-enter-plan` 后主代理派 planning worker，注入：

```text
packages/gate/skills/gate-planning/SKILL.md
packages/gate/skills/gate-planning/proposal.md
packages/gate/skills/gate-planning/rfc.md
global write-agent-notes/SKILL.md
write-agent-notes/templates/proposed.md
```

不注入 `proposal-template.md`。

worker 完成后：

```text
gate_record({ node:'plan', task })
```

### 6. 文件变更

修改：

```text
packages/gate/skills/gate-planning/SKILL.md
packages/gate/skills/gate-planning/proposal.md
packages/gate/skills/gate-plan-review/SKILL.md
packages/gate/index.js（协议说明）
```

删除：

```text
packages/gate/skills/gate-planning/spec.md
```

不新增项目级副本：

```text
proposal-template.md
write-agent-notes 项目副本
```

2026-11-10 Note 改为插件内置 vendor；项目仍不复制。

### 7. proposal.md 适配

- 删除“独立 Proposal 文件”与“独立 Spec”假设；
- 删除对 `proposal-template.md` 的引用，改为 Agent Note 的 proposed 模板；
- 明确同一份 Note 同时承接工作项与设计；
- 工作项内容与设计分节写，不复制到第二份文件。

### 非目标

- 不修改 `.agents/skills`；
- 不修改旧 `implement-gate`；
- 不新增模板；
- 不把 Note 生命周期写进 planning；lifecycle 由 2026-11-10 Note 的独立 `note-lifecycle` 节点承接。

## Alternatives considered

**新增 proposal-template.md。** 最强理由是工作项格式独立；会与 Agent Note 模板重复，故不采用。

**工作项与 Note 分成两个文件。** 最强理由是职责分离；本项目已确定由同一份 proposed Note 承接，故不采用。

**planning worker 自己加载 write-agent-notes。** 最强理由是简单；容易漏读，故由主代理派发时注入方法与模板。

## Acceptance criteria

1. planning 不再引用 `proposal-template.md`；
2. 唯一模板是 `write-agent-notes/templates/proposed.md`；
3. 工作项内容使用 `proposal.md`；
4. 技术设计使用 `rfc.md`；
5. Note 生命周期使用 `write-agent-notes`；
6. 不建独立 Spec；
7. review 只报告，不修改 Note/状态；
8. `node packages/gate/test/unit.mjs`、`npm run verify-notes` 通过；
9. 真实 `/gate-enter-plan` 创建/更新同一份 proposed Note。

## Plan Review

- Standards：一个载体、三方法分工、无重复模板。
- Spec：工作项/设计/生命周期/评审职责可观察。
- Architecture：proposal.md 管内容，rfc.md 管设计，write-agent-notes 管容器。
- 结论：通过，进入实施需 implement 授权。

## Risks

- `proposal.md` 原文仍含 Proposal 文件语义，需逐处改写；
- planning worker 需要同时读三个方法，依赖主代理正确注入；
- `Spec` 轴名称容易误解为独立 Spec，需要在 review 技能中明确；
- 真实链路的 Note 创建与 review 回执尚未验证。


