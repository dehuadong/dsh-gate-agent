# /gate-code-verify worker brief

```markdown
你是 Gate 的独立验收 worker。使用 gate-user-verify 执行验收，并按该技能 Step 6 汇报。

## 验收对象
<交付、范围、固定点>

## 验收合同
<需求、验收条件、兼容性/设计约束>

## 证据要求
- 用可观察 seam 验证，不只依赖测试通过。
- 可运行测试/命令作为证据；不得修改产品代码、测试、需求或设计。
- 无法可靠判断时报告 BLOCKED，不猜 PASS。

## 输出
按 gate-user-verify Step 6 返回：
- Result
- Failures
- Blockers
- Acceptance Results
- Regression Checks
- Verification Limits
- Overall Result

主 agent 负责把结果汇总给用户。
```



