---
name: gate-implement
description: Gate 实现方法：主 agent 读取后提炼任务并派发；worker 不加载技能。
---

## Main agent use

主 agent 在派发前自行读取本方法，给 worker 一份自包含任务：已接受的范围、约束、验收检查和实现规则。worker 不应加载本技能或其他 gate 方法文件。

## 实现

## 1. 入口条件

实现已接受工作项（proposed Agent Note）的选定范围。编码前读取其范围、验收条件与引用的设计章节。

实现前检查范围、验收条件、必需决定、批准证据、未解决 blocker，以及该范围的执行授权。复用有效证据，不重复确认。把已确认的范围和决定同步给各自属主；未解决的重要决定按项目的讨论、授权和 gate 规则返回 discuss。仅记录状态或位置不构成就绪或授权。

## 2. 按需拆分

通过 Implementation Gate 后，只在确实需要拆分时创建 implementation ticket。ticket 的存在不是进入实现的前提。

工作适合一个连贯执行单元时直接实现。

工作过大、存在有意义的独立切片或依赖时，读取 [tickets.md](./tickets.md) 。

不要为了枚举编码步骤而创建 ticket。

## 3. 执行

按工作项的范围、验收条件、引用要求、已接受设计和架构决定实现。

使用既有架构、约定、接口和领域语言，除非权威设计明确改变。

如果实现暴露出未解决的产品、领域、架构、接口、兼容性或其他合同决定，停止受影响实现，并向主 agent 返回 receipt 和该决定。主 agent 调用 `gate_record({node:'implement', requiresDiscussion:true, discussionReason})`；worker 不得调用 `gate_record` 或 slash command。决定未解决前先讨论，不做新的 planning/implement 授权，也不继续受影响代码。

### 实现期测试

按改动需要编写或更新测试。测试优先能改善反馈或明确行为时使用；采用时加载 `tdd` 技能并遵循其流程。

工作时运行聚焦测试和相关静态检查。

### 实现 findings

gate 可能返回实质 findings。按属主处理：

| Finding | 路由 |
| --- | --- |
| 当前实现缺失或违反已同意合同 | 在当前实现中修复 |
| 同一已同意工作需要额外执行单元 | 增加或更新 implementation ticket |
| 产品或技术合同必须改变或从未解决 | 停止受影响工作，把决定 blocker 返回主 agent；主 agent 调 `gate_record` 带 `requiresDiscussion:true`；新 planning 需要授权 |
| 与已同意工作无关 | 不自动扩大范围 |

没有“顺手修一下”的无关工作路径。

对属于本实现的 findings，在当前实现中修复，重跑受影响测试和静态检查，并在下一次 receipt 报告每项处置。没有证据不要标记已解决。

## 4. Receipt 与交接

实现完成的条件：

- 授权范围已实现
- 必需 ticket 已完成
- 相关实现期检查通过
- 实质 findings 已解决或明确报告为 blocked
- 改动已准备好进入 `verify`

返回 receipt，包含：

- 改动文件与覆盖范围
- 运行的测试和静态检查及结果
- 每项 finding 的处置
- 剩余风险、blocker 或需要决定的点

不要执行 `verify`、不要把工作项标完成、不要推进 gate。verify 节点和最终完成由 gate 负责。

