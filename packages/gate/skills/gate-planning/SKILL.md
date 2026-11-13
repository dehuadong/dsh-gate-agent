---
name: gate-planning
description: Gate 规划方法：主 agent 读取后提炼任务并派发；worker 不加载技能。
user-invocable: false
---

## 必读资源

写设计节（`## Design`、`### 设计` 或自由设计节）前必须读取 `proposal.md` 和 `rfc.md`；rfc 的检查项必须进入 worker prompt，不能以“as needed”跳过。mechanical 或不写设计节的工作项不强制读 rfc。

## 主 agent 使用

主 agent 在派发前自行读取本方法，给 worker 一份自包含任务：具体工作项、约束和规划规则。worker 不应加载本技能或其他 gate 方法文件。worker prompt 只给计划内容；不要附带项目环境验证（`package.json`、Node 版本、git 状态、文件存在性、初始化 smoke 结果）。

任务模板：本技能 `assets/worker-briefs/gate-enter-plan.md`；派发前读取并填写。

# 规划

## 项目绑定

- 本次工作项就是 proposed Agent Note；
- 产品行为、范围、验收由工作项拥有；
- 工作项内容按 [proposal.md](./proposal.md) ；技术设计按 [rfc.md](./rfc.md)（写设计节前必读）；
- 技术设计与长期决定写入 Agent Note；
- 模板使用内置 `gate-write-agent-notes` 的 `templates/proposed.md`；不新增或复制模板；
- Note 的位置、格式、生命周期遵循内置 `gate-write-agent-notes`；不得在 planning 内另建生命周期或状态；
- Plan Review 由 gate 的 `gate-plan-review` worker 执行；planning 接收主代理转交的 findings，负责决定与修正。

## 0. 先检索与判定归属

- 加载内置 `gate-write-agent-notes`，按 §3 用 `grep`/`glob`/`read` 检索入口注释、分类树、关键词和模块 README，不依赖 shell。
- 按 §4 判定：既有决定未变时就地同步 `implemented/` Note；新想法写 `proposed/`；class 只能是六类封闭集。
- 把检索证据写入 `noteSearch`，把归属与 class 写入 `notePaths` / `noteDecision`，随 `gate_record({node:'plan'})` 提交。

把当前对话与项目上下文整理成最少但足够的规划工件，使工作具备实施条件。先确定各项事实的项目属主，再按需让产品合同与技术探索往返收敛；不为填满文档类型而创建工件。

## 1. 确定工作项

本次工作项由 proposed Agent Note 承接。按 [proposal.md](./proposal.md)  写清 why、范围与非目标、产品行为与验收、决定与未决问题、评审与批准证据。

复用合适的既有 Note；需要新 Note 时加载内置技能 `gate-write-agent-notes` 创建 proposed Note，不另建独立 Proposal 文件，也不要求 Issue tracker。

在 gate 环境中，Note 的落盘使用 `gate_note_write`：新建写 `proposed/<class>/...`，原地同步既有 implemented Note 写 `implemented/<class>/...`；通用 `write`/`edit`/shell 在 planning 被限制。

工作项与设计在同一份 Note 分节；工作项不复制 Design 正文，Design 不改写工作项验收。

## 2. 收敛产品合同与技术设计

### 产品合同

产品行为、范围与验收由本次工作项写全；跨工作项持续生效的合同由工作项拥有，并在同一 Note 中分节，不复制成第二套合同。

### 探索性设计

当技术可行性会实质影响产品范围时，读取技术设计检查项[rfc.md](./rfc.md) ，在 proposed Note 中形成探索草案。只要写设计节，就必须先读 rfc.md；规模小不构成跳过理由。

探索草案必须区分产品事实与临时假设，把影响产品范围的结论反馈给工作项，不得作为实施依据。

产品合同与探索草案可以往返修改，直到范围与验收不再依赖未解决的技术可行性问题。

### 技术设计定稿

需要解决重要技术决定时，使用 技术设计检查项（[rfc.md](./rfc.md) ），把已确定的产品合同转成 Agent Note 中的技术设计；一份产品合同可以由多个边界明确的 Note 分别承接。只要写设计节，就必须先读 rfc.md。

设计定稿遵循 技术设计规则（[rfc.md](./rfc.md) ） 的合同稳定性与评审条件。Note 的 proposed/implemented 表示交付生命周期，不代替评审和批准证据。

### 决定权限

在已同意的产品合同、既有架构和项目约束内，自主解决普通技术选择。

涉及未解决的产品、业务、兼容性、成本、风险、架构方向或其他价值判断时，交由用户决定，除非用户已经明确委托决定权。

## 3. Review findings

Plan Review is owned by the gate's `gate-plan-review` worker; do not run it here.

主代理转交 findings 后，逐条决定其属主并在对应工件修正：产品范围与验收回到工作项，本次规划的技术设计回到 Agent Note，工作状态与批准证据回到工作项。引用输入的问题按项目配置反馈其属主，并报告受影响范围。不得自行宣称整体通过。

## 4. 完成与交接

Planning 完成需要同时满足：

- 产品范围和验收条件已经稳定；
- 实施所需设计已按项目约定接受或批准；
- 设计完整承接工作项产品合同；
- 所需决定已解决；
- 主代理报告 Plan Review 无未解决发现（不由本 worker 自行宣称）。

若用户只要求规划，交付规划结果与评审证据后结束。端到端任务把 receipt 交回 gate；执行授权由 gate 单独核对，不在本 worker 内推进。





