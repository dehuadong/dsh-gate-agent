# Agent Note: Discuss orchestration 接入静态方法论

Status: implemented

工作项：本次会话“DISCUSS_ORCHESTRATION 语义与 discuss 约束”。本 Note 承接 discuss 阶段规则的运行时载体；不改 access/guard 矩阵。

## Problem

`DISCUSS_ORCHESTRATION` 是 AGENTS.md Discuss 的 7 条压缩规则，原本用于约束 discuss：读上下文、明确问题、给方案与权衡、只问价值判断、不创建规划产物、汇报、不自行离开。

实际运行时：

- 常量只在 `protocol.ts` 定义、`index.ts` re-export、`unit.mjs` 做字符串断言；
- root 静态 prompt 使用的是 `GATE_METHODOLOGY` 里另一段更短的 `## discuss`；
- `procedureFor` 的 discuss 只返回“不派 worker、文件只读、如何进入 plan/implement”的短句。

结果是详细规则没有进入模型上下文。文件只读由 access/guard 硬保证，但“不创建提案/Note/规格文件”“先自行分析、不把可判断问题交给用户”“不要求用户重复已有信息”等软约束缺失。

## Decision

### Decision

- 把 `DISCUSS_ORCHESTRATION` 作为 `GATE_METHODOLOGY` 的 discuss 段，通过模板插值接入 root 静态 prompt。
- 把常量标题改为 `## discuss`，与 `GATE_METHODOLOGY` 其他段一致；去掉重复的短 `## discuss` 段。
- 保留 `procedureFor` 的 discuss 短句，只负责动态状态与阶段转换，避免每次 `gate_status`/`gate_record` 重复长方法论。
- 在常量中补齐 AGENTS.md 的要点：讨论不是被动访谈、不要要求用户重复已有信息、不要求确定所有实现细节。
- 第 7 条授权文案按用户要求改为：授权可以在对话中要求用户再输入 slash command 或 `ask_user_question` 中给出。

### 非目标

- 不把完整 discuss 规则放进 `procedureFor`；那会增加每次状态返回的 token。
- 不改 access 矩阵、guard、commit 策略。
- 不改变 root 静态 prompt 的字节稳定性；`DISCUSS_ORCHESTRATION` 是静态常量，不随 phase/node 变化。
- 不删除 `DISCUSS_ORCHESTRATION`；它成为实际方法论来源。

## Implementation evidence

- `GATE_METHODOLOGY` 用 `${DISCUSS_ORCHESTRATION}` 插值；root 静态 prompt 可见完整 discuss 规则，标题为 `## discuss`。
- `DISCUSS_ORCHESTRATION` 已改成 bullets、补“讨论不是被动访谈/不要重复已有信息”，并按用户要求修正授权文案。
- `procedureFor` 的 discuss 仍为短句；测试断言它不包含完整 discuss 规则。
- 静态 prompt 测试断言唯一 `## discuss`、完整规则文本、byte-stable；`pnpm test` 通过。
- 旧 methodology Note 的 discuss 行已指向本 Note。

## Alternatives considered

1. **把 `DISCUSS_ORCHESTRATION` 作为 `procedureFor` 的 discuss procedure**：规则最靠近当前状态，但每次 status/record 都重复整段，增加 token；且与静态方法论职责重叠。否决。
2. **删除常量，扩写 `GATE_METHODOLOGY` 的短段**：也能补规则，但会丢失一个可测试的显式契约，且两处文案仍可能漂移。否决。
3. **保持现状，只靠 guard**：只能约束文件写，无法约束“不创建规划产物/不把可判断问题交给用户”等 discuss 方法。否决。

## Consequences

### Acceptance criteria

1. `GATE_METHODOLOGY` 包含 `DISCUSS_ORCHESTRATION`，root 静态 prompt 可见完整 discuss 规则。
2. `GATE_METHODOLOGY` 不再有重复的短 `## discuss` 段；discuss 标题仍为 `## discuss`。
3. `DISCUSS_ORCHESTRATION` 不再有“要求用户再输入 slash command”的错误文案；包含“讨论不是被动访谈”“不要要求用户重复已有信息”。
4. `procedureFor` discuss 仍返回短句，不包含完整方法论。
5. 测试断言静态 prompt 包含 discuss 关键规则，且 root prompt 在 phase/node 变化时仍 byte-stable。
6. `pnpm typecheck`、`pnpm build`、`pnpm test`、`pnpm -C packages/gate test`、`pnpm verify-notes` 通过。
7. 旧 methodology Note 加 2026-11-13 指针，说明 discuss 段改由 `DISCUSS_ORCHESTRATION` 提供。

### Risks

- root 静态 prompt 增加几行，但只影响初始/system prompt，不进入每次 procedure；可接受。
- 规则从“短段”变成“7 条 + 补充”，模型可能更严格地停留在 discuss；这正是目的。
- `## discuss` 标题大小写/重复会导致测试失败；用测试锁住。
- 常量仍可能被外部导入；保持导出，不破坏 API。
