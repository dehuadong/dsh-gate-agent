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

## DSH 插件与预设

在开发deepseek-harness 插件时遇到问题可参阅deepseek-harness官方源码工程包 `deepseek-harness/packages`（仓库根下的目录联接）
DSH UI设计判断参考`deepseek-harness/docs/ui-design-review-cases.zh.md`
Web UI 样式参考`deepseek-harness/docs/web-styling.zh.md`
DSH  UI统一圆角规范`deepseek-harness/docs/ui-radius.zh.md`

