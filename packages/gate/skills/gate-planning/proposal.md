# Proposal

工作项与技术设计由同一份 proposed Agent Note 承接；工作项负责为什么要改、本次范围、产品行为与验收、评审与批准证据及就绪状态；技术设计写在同一 Note 的 Design 节，不另设设计属主。

## 配置与存放

- 唯一载体：`proposed/<class>/YYYY-MM-DD-topic.md`；
- 不创建独立 Proposal 文件；
- 模板使用 `<skills-root>/write-agent-notes/templates/proposed.md`；
- 路径、分类、格式与生命周期由 `write-agent-notes` Skill 管。

## 内容

同一份 Note 中，工作项部分必须包含：

```text
## Problem
why、背景、约束

## Proposal
### 范围与非目标
### 产品行为与验收
### 决定与未决问题
### 评审与批准证据

## Design
技术设计、边界、关键决定

## Alternatives considered
真实备选、最强理由、为什么不选

## Acceptance criteria
可观察、可判定的验收

## Risks
风险与未决问题
```

- `## Proposal` 的子项是内容要求，不是新增模板；
- `## Design` 是自由节，由 `rfc.md` 检查；
- `## Alternatives considered`、`## Acceptance criteria`、`## Risks` 保持 Agent Note 模板结构；
- 工作项内容与设计写在同一份 Note，不复制到第二份文件。

## 状态更新

- Plan Review 结果、批准与就绪状态记录在 Note 的工作项部分；
- 评审通过、批准、执行授权是三件事；
- 只有规划内容通过、所需批准齐备且没有阻塞时，才标记为就绪；
- proposed → implemented 由 `write-agent-notes` 在实现与验证完成后处理，planning 不提前转换。
