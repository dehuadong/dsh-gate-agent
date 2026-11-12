# Agent Note: Gate root 写权限：编排优先，blocked 例外

Status: implemented

工作项：本次会话“Gate root 写策略与 planning 资源加载”。本 Note 只承接 root 写权限；planning 的 `rfc.md` 必读、`notePaths`/verify/finalize 契约由 [process Note](../process/2026-11-12-gate-planning-resources-and-note-contracts.md) 承接。

## Problem

现有 [Gate B 的 B-2/T2 决策](../../implemented/architecture/2026-11-10-gate-dsh-native.md) 把 root 写当成阶段门禁的一部分：discuss/reviewing/verify 用 `tools.restrict` 移除写工具、`gateDenyReason` 拒绝 root 写、`sandboxModeFor` 切 `read-only`。这与当前要求冲突。

真实会话 `session-ad7b174a-1db2-47b3-a57f-a10016283e93` 暴露了后果：note-lifecycle 完成回到 discuss 后，主代理发现 implemented Note 仍有“本 Note 位于 proposed/...”的过期正文，两次 `edit` 都被拒绝：

```text
当前阶段不允许写入；主代理在编排中不写文件
```

另外，review/verify 的 `read-only` sandbox 让 root 在 plan review 和 verify 阶段跑 `npm test`/临时目录时遇到 EPERM，主代理只能提权到 `danger-full-access` 取证。更根本的是，`setSandbox` 无条件 append `sandbox/mode`：旧实现会为 docs/plan/implement 升级到 `workspace-write`（用户以 read-only 启动的会话也会被升级），blocked 的 read-only 又没有恢复路径；这违反“DSH sandbox/approval 是硬边界”的既有边界。

用户确认：主代理可以有自己的写权限，gate 只做编排，**编排优先派发子代理**；只有 blocked 保留“冻结写入”。硬权限应由 DSH 的 sandbox/approval 负责，而不是 gate 的 phase 判断。worker 的角色限制（planning worker 只走 `gate_note_write`、review worker 只读、implement/fix worker 可写）保持不变。gate 不 append `sandbox/mode`；blocked 的冻结由 guard/restrict 表达，用户已确认采用进程级冻结而不是 OS/sandbox 级冻结。

## Decision

### 范围与非目标

本次调整：

- root 在 discuss/docs/orchestrating/reviewing/complete 的 `write`/`edit`/`apply_patch` 和写型 shell 全部允许；
- root 在 blocked 仍被拒绝，且 blocked 继续冻结 worker 派发与 gate 推进；blocked 由 guard/restrict 的进程级冻结表达；
- gate 不 append `sandbox/mode`，DSH 的 sandbox/approval 会话策略保持原样；
- 更新 `discuss` procedure，移除“无 worker/write”的误导；
- 更新 README、测试和 [B-2/T2 决策](../../implemented/architecture/2026-11-10-gate-dsh-native.md) 的交叉引用。

非目标：

- 不改 worker 角色限制；
- 不取消工作区外写入拒绝；commit 策略已由 [2026-11-12 commit Note](../../implemented/process/2026-11-12-gate-commit-policy.md) 取代；commit 守卫已移除；
- 不把 blocked 的冻结扩大到 root 只能读；blocked 的 root 写仍拒绝，但这是用户确认的唯一例外；
- 不接管 DSH 的 sandbox mode/approval；
- 不引入 Config、不读取仓库 `.agents/GATES.md`/`AGENTS.md` 作为运行时权限来源。

### 行为矩阵

| phase / node | root 写 | worker 写 |
|---|---|---|
| discuss | allow | 无 worker 节点；`subagent` 仍拒绝（discuss 不派发） |
| docs | allow | 无 worker 节点；dispatch 未额外拒绝（现有行为） |
| orchestrating plan / plan-revise | allow | planning worker 只允许 `gate_note_write`；通用 write/edit/shell 拒绝 |
| orchestrating plan-review | allow | review worker 只读 |
| orchestrating implement / implement-revise / fix-bug | allow | implement/fix worker 可写 |
| orchestrating code-review | allow | review worker 只读 |
| orchestrating verify | allow | verify worker 只读 |
| reviewing code-review-standalone / proposal-review / verify-standalone | allow | review/verify worker 只读 |
| orchestrating note-lifecycle | allow | 无 worker 节点；dispatch 拒绝 |
| blocked | 写 deny；只读 shell allow | 无 worker 且 `subagent` 拒绝 |
| complete | allow | 无 worker 节点；dispatch 未额外拒绝（现有行为） |

root 的 review/verify 写权限不等于“应当修改被评审对象”；静态方法论仍要求 review 只报 findings、verify 只做判断，root 修改应发生在 review/verify 之外或明确的范围修正。gate 不再用工具权限替代这条方法约束。

### 设计

**`restrictionFilter(state, worker)`**

- worker 分支完全不变：planning/plan、plan-revise 拒绝写工具，implement/implement-revise/fix-bug 不限制，review/verify 拒绝写工具。
- root 分支改为：`state.phase === 'blocked' ? { deny: ['write', 'edit', 'apply_patch'] } : undefined`。blocked 不在工具层隐藏 `pwsh`/`bash`，因为只读 shell 仍应可用；写型 shell 由 `gateDenyReason` 的 `access.write` 检查拒绝。其他 phase 不再 restrict。

**`gateDenyReason`**

- `write`/`edit`/`apply_patch`：先判工作区外；worker 仍走 `workerWriteAllowed`；root 仅在 blocked 返回明确错误（“Gate 已冻结：...先 /gate-resume 或 /gate-return-discuss”），其他 phase 返回 `undefined`。
- `pwsh`/`bash`：写访问的工作区外拒绝；commit 策略已由 [commit Note](../../implemented/process/2026-11-12-gate-commit-policy.md) 取代；commit 守卫已移除；worker 仍走 `workerShellAllowed`；root 仅在 blocked 拒绝；其他 phase 允许。
- `subagent`/`subagent_fork`/`workflow`：新增 blocked 拒绝（当前 blocked 应冻结 worker 派发）；discuss 和 note-lifecycle 的既有拒绝保留。
- `gate_record` 的 root-only 不变。

**sandbox**

- 删除 `sandboxModeFor`/`setSandbox` 的 phase mode；`store.write` 不再 append `sandbox/mode`。
- gate 不接管 DSH 的 sandbox/approval；会话保持用户/部署的原有 mode。非 blocked 不 append `workspace-write`，blocked 不 append `read-only`。
- blocked 的写冻结由 `restrictionFilter`（root 只 deny `write`/`edit`/`apply_patch`）和 `gateDenyReason`（shell 写访问）实现；只读 shell 仍可用。进程级冻结不覆盖 `node -e`/build script 等分类器之外的写，README 必须保留“gate 是流程门禁，不是 OS 安全边界”的声明。
- review/verify worker 的只读由 `restrictionFilter`/`workerWriteAllowed`/`workerShellAllowed` 保证；这些是 gate 的流程限制，不是 OS 边界。

**procedure 与文档**

- `procedureFor` 的 discuss 文案改为：“discuss 不派 worker；主代理可自行读/写；用户授权后 `gate_start_phase` 进入 plan/implement。”不再出现“无 worker/write”，也不与“discuss 不派发”矛盾。
- `DISCUSS_ORCHESTRATION` 的“不创建提案/Note/规格文件”仍是**方法约束**：discuss 的 root 写权限允许修改既有文件/文档，不等于把 discuss 变成 planning；需要在 Note 或 procedure 中明确，避免误读为可以创建规划工件。
- blocked 文案保持冻结；`/gate-block` 命令的提示保持“冻结写入和 worker 派发”。
- README 顶部“按阶段控制 agent 的写入”改为“root 写由 DSH 策略；gate 只冻结 blocked 并限制 worker 角色”；blocked 章节保留冻结说明，并明确冻结的是**写型 shell/显式写工具**，不是所有 shell 语义（`node -e`/build script 不在 classifier 覆盖内）；保留“gate 是流程门禁，不是 OS 安全边界”。

### 决策与未决

已决定：

- 采用 B：discuss/reviewing/complete 放开 root 写，blocked 保留冻结；
- root 的写权限不按 phase 硬拒绝；worker 角色限制保留；
- gate 不 append `sandbox/mode`；DSH 保留自己的 sandbox 策略；blocked 用 guard/restrict 做进程级冻结；
- blocked 仍是唯一 root 写拒绝的 phase，并补上 `subagent`/`subagent_fork`/`workflow` 拒绝。

未决：

- 无。是否在 blocked 期间允许 root 通过 approval 临时提权，由 DSH sandbox/approval 决定，不属于 gate 契约。

## 已有 Note 审计

- [Gate B 的 B-2/T2](../../implemented/architecture/2026-11-10-gate-dsh-native.md)：root 阶段写限制被本 Note 部分取代；worker 角色限制与 blocked 冻结保留。新 Note + 旧篇前向指针，不重写旧 Decision。
- [notes lifecycle](../../implemented/process/2026-11-10-gate-notes-builtin-lifecycle.md)：其中第 102 行“note-lifecycle agent 侧 read-only”是旧表述；本 Note 明确 root 在该节点可写，finalize 仍是唯一 lifecycle 迁移工具。该篇是 decision，实施时只加 superseded-by 指针，不改写正文。
- [方法论与 procedure 分层](../../implemented/architecture/2026-11-12-gate-methodology-procedure.md)：其 discuss procedure 记录“无 worker/write”由本 Note 改为“不派 worker；主代理可自行读/写”；方法论正文不变。
- [2026-11-07 discuss 运行时协议](../../proposed/process/2026-11-07-discuss-runtime-protocol.md)：其“discuss 不写文件/拒绝代码文档写入”被本 Note 部分取代；discuss 不派 worker、不创建规划工件仍是方法约束。旧篇加前向链接，不合并。
- `packages/gate/README.md:5` 的“按阶段控制写入”以及 planning/implement `workspace-write`、review/verify `read-only` 括号由本 Note 的“DSH 策略 + 只有 blocked 进程级冻结”取代；实施时同步 README，并记录“旧版本已写入 read-only 的会话”迁移 residual。
- 没有其他架构 Note 承接 root 写权限；本 Note 不新建重复的权限模型。commit 策略由 [commit Note](../../implemented/process/2026-11-12-gate-commit-policy.md) 承接。

## Implementation evidence

- `npm test` ALL CHECKS PASSED；`node --check` 通过；`npm run verify-notes` 11 篇通过。
- 单元测试覆盖 root 在 discuss/docs/orchestrating/reviewing/complete/note-lifecycle 的 `write`/`pwsh`，blocked 的写拒绝、只读 shell、`subagent`/`subagent_fork`/`workflow` 拒绝，以及 gate 不 append `sandbox/mode`。
- worker 角色限制测试保持：planning 通用写拒绝、`gate_note_write` 可用；review/verify worker 写拒绝；implement/fix worker 可写。
- 残余按 Risks：blocked 是进程级冻结（`node -e`/build script 可绕过）；旧会话已记录的 `sandbox/mode` 不会被新 gate 恢复；commit 策略已由 [commit Note](../../implemented/process/2026-11-12-gate-commit-policy.md) 取代；自动 commit 已移除。

## Alternatives considered

1. **保留 B-2/T2 的 root 阶段写限制。** 最强理由：review/verify 期间防止主代理改被评审对象，降低“自己审自己”的风险。否决：用户明确要求 root 有自己的写权限，gate 只做编排；且 live session 证明该限制会阻断 note-lifecycle 后的正常修正，并在 review/verify 造成工具 EPERM。review 独立性改由方法论和 worker 只读保证。
2. **连 blocked 也放开 root 写。** 最强理由：权限完全交给 DSH，gate 不保留任何写拒绝。否决：用户选择 B；blocked 是显式的“冻结写入 + 不派 worker”状态，保留它才能让 `/gate-resume`/`/gate-return-discuss` 有明确语义。
3. **只保留 `tools.restrict`，删掉 `gateDenyReason` 的写判断。** 最强理由：减少重复。否决：`restrict` 只掩当前 scope 的全局工具，scoped 工具/其他插件仍可能绕过；`gateDenyReason` 的 blocked 拒绝是单调 guard，和 restrict 互补。
4. **保留 review/verify read-only，只给 root 一个写旁路。** 最强理由：保持阶段隔离。否决：sandbox 是 session 级，无法只给 root 旁路；而 read-only 正是 live EPERM 的来源。
5. **blocked 仍切 sandbox read-only，记录/恢复 prior mode。** 最强理由：blocked 仍有 OS 级写入冻结。否决：sandbox 是 session 级，prior 无法从现有 API 可靠重建；要跨 restart 只能依赖 gate-owned session event/额外 payload 或原子 append 失败处理，触及持久化格式和既有“不新增自定义 session 事件”约束。用户确认采用进程级冻结；本 Note 不接管 sandbox。

## Consequences

### Acceptance criteria

1. root 的 `write`/`edit`/`apply_patch` 在 discuss、docs、orchestrating（plan/plan-revise/plan-review/implement/implement-revise/code-review/verify/fix-bug/note-lifecycle）、reviewing（code-review-standalone/proposal-review/verify-standalone）和 complete 均被允许；blocked 被拒绝（工具被 restrict 隐藏，或 `gateDenyReason` 返回冻结错误）。
2. root 的 `pwsh`/`bash` 写访问在上述非 blocked phase 允许；blocked 拒绝写型 shell 但允许只读 shell；工作区外写入拒绝保持不变；`git commit` 策略已由 [commit Note](../../implemented/process/2026-11-12-gate-commit-policy.md) 取代。
3. blocked 的 `subagent`/`subagent_fork`/`workflow` 被拒绝；discuss 和 note-lifecycle 的既有派发拒绝不变。
4. gate 不 append `sandbox/mode`；blocked 的写冻结只由 `restrictionFilter`/`gateDenyReason` 的进程级限制表达，只读 shell 可用；测试断言 gate 不产生 sandbox mode 变更，且 blocked 的显式写被拒绝。
5. worker 角色限制不变：planning worker 通用写拒绝、`gate_note_write` 可用；review/verify worker 写拒绝；implement/fix worker 可写；现有 worker 测试全绿。
6. discuss procedure 不再包含“无 worker/write”，明确“discuss 不派 worker、主代理可自行读写”；`DISCUSS_ORCHESTRATION` 的“不创建规划工件”作为方法约束保留；blocked 文案仍冻结。
7. README、[Gate B Note](../../implemented/architecture/2026-11-10-gate-dsh-native.md) 的 B-2/T2、[notes lifecycle](../../implemented/process/2026-11-10-gate-notes-builtin-lifecycle.md) 的 note-lifecycle read-only 表述、[方法论 Note](../../implemented/architecture/2026-11-12-gate-methodology-procedure.md) 的 discuss procedure 记录、[discuss 运行时协议](../../proposed/process/2026-11-07-discuss-runtime-protocol.md) 和 README:5 的写入描述都有本 Note 的修订指针；README 删除 planning/implement workspace-write 与 review/verify read-only 括号，并记录旧会话已写入 read-only 的迁移 residual；旧决策不被改写成相反结论。
8. `node --check`、`npm test`、`npm run verify-notes` 通过；新增 root/worker/blocked 矩阵测试，覆盖 `subagent_fork`/`workflow` blocked、blocked 只读 shell、blocked→resume 的 restrict disposal、每个非 blocked phase 的 root `pwsh`、blocked 显式写拒绝、gate 不产生 `sandbox/mode` 变更，且没有放宽 worker 限制。
9. 不读取仓库 `.agents/GATES.md`/`AGENTS.md` 作为运行时权限来源；不新增 Config。

### Risks

- root 在 reviewing/verify 可写会削弱“评审与实现分离”的表面保证；缓解：静态方法论仍要求 review/verify 不改被评审对象，review/verify worker 仍只读，root 的修正应发生在 review/verify 之外或明确范围。
- note-lifecycle 的自动 `commitGateChanges` 已由 [commit Note](../../implemented/process/2026-11-12-gate-commit-policy.md) 移除；gate 不再自动提交。约束：root 在 code-review/verify 期间的修改仍必须重跑 review/verify；gate 不靠 commit 工具区分“已评审/未评审”文件。这个限制写进 README/Note，不新增 baseline 机制。
- 非 blocked 不再切 read-only 后，review/verify worker 的只读只剩 `restrictionFilter`/`workerWriteAllowed`/`workerShellAllowed` 的流程限制；review/verify worker 的 `pwsh`/`bash` 被工具限制隐藏，但这不是 OS 级安全边界。README 必须保留“gate 是流程门禁，不是 OS 安全边界”的既有声明。
- blocked 采用进程级冻结，不是 OS/sandbox 级：显式 `write`/`edit`/`apply_patch` 和写型 shell 被拒绝，但 `node -e`/build script 等分类器之外的写可以绕过。用户已确认该层级；README 的 blocked 文案必须写“写型 shell/显式写工具”，不能写成 OS 级强制。
- 升级 residual：旧 gate 已经在会话 log 里 append 过 `sandbox/mode`（planning/implement workspace-write、review/verify read-only）；新版本不再管理 sandbox，也不会替旧会话恢复。DSH 会继续 replay 最后一条 read-only，旧 blocked/reviewing/discuss 会话仍可能遇到 EPERM。缓解：新会话，或用户显式重新选择 sandbox mode；README 的 Known Limitations 记录该 residual，不声称“DSH 策略对所有会话保持原样”。
- blocked 仍拒绝 root 写，note-lifecycle 之后的 Note 修复只能在 discuss/complete 或 blocked 解除后进行；blocked 只读 shell 可用，写型 shell 由 guard 拒绝。这是用户选择的冻结语义，需在 README 明确。
- 现有测试直接断言旧行为（discuss/review 的写拒绝、sandbox read-only、discuss procedure 的“用户授权后调用 gate_start_phase”字样），必须同步更新；只改实现不改测试会让行为看似通过。
