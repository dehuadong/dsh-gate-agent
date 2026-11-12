# dsh-gate-agent

Host 插件：用 phase/node 门禁组织讨论、规划、实施、评审、验收和 Note 生命周期，提供 `/gate-*` 命令、`gate_*` 工具和专项技能。

> 这是流程门禁，不是 OS 级安全边界。硬拒绝由 `ctx.tools.guard` 提供；blocked 的写冻结是 guard/restrict 的进程级限制（显式写工具/写型 shell），真正需要隔离时仍使用 DSH 的 sandbox/approval。未知工具与任意 shell 语义不会被完整分析。

## 安装与启用

### 开发安装（link，标准方式）

与 `see-dsh-novel` 的 `docs/plugin-local-install.md` 相同：

1. 在仓库根构建：

   ```text
   pnpm --filter dsh-gate-agent build
   ```

   安装读取的是磁盘上的 `packages/gate/lib/`，不是 `src/`；`lib/` 被 `.gitignore` 排除。

2. 调用 `plugin_manager`，`action: install_bundle`，`target` 传包目录绝对路径：

   ```text
   E:\workspace\dsh-plugin\gate\packages\gate
   ```

   本地目录不走 npm，不带 `registry`。成功判定是 `application: applied` 且 `warnings: []`；`stage: enable` / `changed: true` 不代表装载成功。

3. profile 侧应看到：

   ```json
   "dsh-gate-agent": "link:E:/workspace/dsh-plugin/gate/packages/gate"
   ```

   `node_modules/dsh-gate-agent` 是指向源码目录的 Junction。源码改动后重新 `pnpm build`，重启 DSH 加载新的 `lib/index.js`。

4. 卸载用 `plugin_manager` 的 `remove_bundle`，target 为 `dsh-gate-agent`。标准卸载只改 profile 的 bundles、依赖和 Junction，不碰工作区。不要用递归删除工具清理 profile 的 `node_modules`：Windows 上 link 是 junction，递归删除可能穿过它删除源目录；`pnpm remove` 实测只移除 link。

### 生产安装（npm）

- `install_bundle` target 使用 npm 版本，例如 `dsh-gate-agent@0.1.2`。
- npm 安装的是独立副本，卸载不会影响本仓库源码。

### 启用

- 安装/升级后重启 DSH。
- 插件由“开发者模式”preset 启用。启用后先执行 `/gate-init`。

`/gate-init` 会：

- 创建 `.agents/notes/` 的 `proposed/`、`implemented/`、`rejected/`、`archived/` 根；
- 创建/更新 `AGENTS.md` managed block；
- 生成 `.agents/gate/verify-notes.mjs`、`.agents/gate/ci/` 和 `.github/workflows/verify-notes.yml`；
- 在项目 `package.json` 中确保 `verify-notes` 脚本；
- 在非 git 工作区执行 `git init`，在 `.gitignore` 缺失时写入基础忽略项；已有 `.gitignore` 不覆盖。

## 工作阶段与节点

`phase` 是当前工作阶段，`node` 是阶段内的具体步骤。`discuss` 之外由命令或 `gate_start_phase` 进入。

| phase / node | 用途 | 主代理/worker 与技能 |
|---|---|---|
| `discuss` | 理解需求、讨论方案、确认授权 | root；不派 worker |
| `orchestrating/plan` | 把工作项整理成规划工件 | planning worker；`gate-planning` + `gate-write-agent-notes` |
| `orchestrating/plan-review` | Plan Review 三轴评审 | review worker；`gate-plan-review` |
| `orchestrating/plan-revise` | 按 findings 修计划 | planning worker；`gate-planning` |
| `orchestrating/implement` | 按已确认计划实施 | implement worker；`gate-implement` |
| `orchestrating/code-review` | 实现 review（Standards/Spec） | review worker；`gate-code-review` |
| `orchestrating/implement-revise` | 按 review findings 修正 | implement worker；`gate-implement` |
| `orchestrating/verify` | 最终验收与证据绑定 | verify worker；`gate-verify` |
| `orchestrating/note-lifecycle` | 把 proposed Note 转 implemented、跑 notes 校验 | root；`gate-write-agent-notes` lifecycle 工具 |
| `orchestrating/fix-bug` | 修复已授权缺陷并复核 | fix worker + review worker；`gate-fix-bug` + `gate-code-review` |
| `reviewing/code-review-standalone` | 单独只读 code review | review worker；`gate-code-review` |
| `reviewing/proposal-review` | 单独提案评审 | review worker；`gate-plan-review` |
| `reviewing/verify-standalone` | 单独只读验收 | verify worker；`gate-user-verify` |
| `docs` | 文档治理 | root；不调用 gate 技能 |
| `blocked` | 冻结写入/派 worker，等待用户决定 | root；`/gate-resume` 或 `/gate-return-discuss` |
| `complete` | 工作完成 | root；可重新进入 plan/implement |

进入阶段不等于执行。主代理按当前 procedure 加载技能、派 worker，再用 `gate_record` 推进节点。

## 命令

| 命令 | 参数 | 作用 |
|---|---|---|
| `/gate-init` | 无 | 初始化 notes、AGENTS.md、`verify-notes`、CI、git 与基础 `.gitignore`，保持 `discuss` |
| `/gate-enter-plan [简单需求]` | 可选 | 进入 `orchestrating/plan` |
| `/gate-enter-implement [简单说明]` | 可选 | 进入 `orchestrating/implement`；复用已通过的 task，或直接用简述 |
| `/gate-docs` | 无 | 文档治理，不调用技能 |
| `/gate-implement-review [范围]` | 可选 | 单独只读 code review，只输出 findings |
| `/gate-code-verify [范围]` | 可选 | 单独只读验收；子代理使用 `gate-user-verify` |
| `/gate-fix-bug [缺陷简述]` | 可选 | 派 fix worker 修复已授权缺陷，完成后回 discuss |
| `/gate-propose-review [提案]` | 可选 | 单独提案评审，走 `gate-plan-review` 三轴 |
| `/gate-note-verify` | 无 | 只读检查 notes tree/format/lifecycle/archived |
| `/gate-note-archive <note> [--superseded-by <new>]` | 必需 Note 路径 | 归档 implemented Note，写 Archived、移动、封印、报告入站链接 |
| `/gate-note-board [输出路径] [标题]` | 可选 | 生成决策看板 `board.html` |
| `/gate-note-seal` | 无 | 只给 `archived/` 中已有 Note 补写 `manifest.json` 的 SHA-256 封印 |
| `/gate-block [原因]` | 可选 | 手动暂停，保留当前节点 |
| `/gate-resume` | 无 | 解冻 blocked，回到 block 前的节点；轮次耗尽回 discuss |
| `/gate-return-discuss` | 无 | 回到 discuss |
| `/gate-status` | 无 | 只读显示当前 phase/node 与 procedure |

离开 discuss 不要求用户输入 slash command：用户在对话或 `ask_user_question` 中明确授权后，主代理可调用 `gate_start_phase({node:'plan'|'implement', brief})`。

## 技能

| 技能 | 使用方 | 作用 |
|---|---|---|
| `gate-planning` | planning worker | 生成/更新规划 Note，组织工作项、验收和设计 |
| `gate-plan-review` | plan/proposal review worker | Standards/Spec/Architecture 三轴评审 |
| `gate-implement` | implement/fix worker | 按计划实施并返回改动/验证结果 |
| `gate-code-review` | code review worker | 对实现做 Standards/Spec 两轴 review |
| `gate-verify` | verify worker | 最终验收、证据收集与汇报 |
| `gate-user-verify` | standalone verify worker | 独立只读验收 |
| `gate-fix-bug` | fix worker | 已授权缺陷修复流程 |
| `gate-write-agent-notes` | planning worker / root note lifecycle | Note 检索、格式、finalize/verify |

## 典型用法

### 初始化

```text
/gate-init
```

从 `discuss` 开始，不进入 planning/implement。

### Planning

```text
/gate-enter-plan
```

主代理派 `gate-planning` worker，创建/更新 proposed Agent Note。worker 完成后：

```text
gate_record({
  node: 'plan',
  task: '工作项简述',
  noteDecision: 'new' | 'update' | 'in-place' | 'mechanical',
  notePaths: [{ path: '.agents/notes/proposed/feature/...', class: 'feature', lifecycle: 'proposed' }]
})
```

进入 `plan-review`，由 review worker 做三轴评审；findings 交回 `plan-revise`，直到通过后回 `discuss`，`planReady=true`。

### Implementation

```text
/gate-enter-implement
```

主代理派 `gate-implement` worker 实施；完成后 `gate_record({node:'implement', workerSessionIds})` 进入 `code-review`。review 通过后进入 `verify`；verify PASS 后进入 `note-lifecycle`。

Note lifecycle：

1. `gate_note_finalize`：把 proposed Note 移到 `implemented/`，更新头块；
2. `gate_note_verify`：跑 notes tree/format/lifecycle/archived 校验，通过后设置 `noteVerified`；
3. `gate_record({node:'note-lifecycle'})`：完成并回 discuss。

gate 不自动 `git add`/`git commit`；完成 note-lifecycle 后由用户或主代理决定是否提交。

### 单独 code review

```text
/gate-implement-review [范围]
```

只读 review，不修改被评审对象；findings 直接输出。

### 单独验收

```text
/gate-code-verify [范围]
```

主代理派只读 verify worker，使用 `gate-user-verify`；PASS 后 `gate_record({node:'verify-standalone', verification, workerSessionIds})` 回 discuss。

### 缺陷修复

```text
/gate-fix-bug 修复空指针异常
```

主代理派 fix worker 执行修复，再派独立 review worker 复核；完成后 `gate_record({node:'fix-bug', workerSessionIds})`。

### 提案评审

```text
/gate-propose-review 某个提案
```

review worker 使用 `gate-plan-review` 做 Standards/Spec/Architecture 三轴评审，不改提案。

### 归档与封印

```text
/gate-note-archive implemented/architecture/2026-11-10-example.md
/gate-note-archive implemented/architecture/old.md --superseded-by implemented/architecture/new.md
/gate-note-seal
```

- 归档由用户命令触发；模型不自动移动 Note。
- `archived/manifest.json` 的封印只由 `/gate-note-seal` 写入。
- 归档后报告被新 Note 取代的入站链接。

### 决策看板

```text
/gate-note-board [输出路径] [标题]
```

生成连接本地 notes 目录的轻量 `board.html`，不改变 Note。

### 文档治理

```text
/gate-docs
```

进入 `docs` phase，不调用 gate 技能；由主代理按项目文档规范处理。

### 暂停、恢复与讨论

```text
/gate-block 等待产品决定
/gate-resume
/gate-return-discuss
/gate-status
```

- `/gate-block`：保留当前节点，冻结写入与 worker 派发，对话仍可继续。
- `/gate-resume`：回到 block 前的节点；review 轮次耗尽时回 discuss。
- `/gate-return-discuss`：放弃当前节点，回 discuss。
- `/gate-status`：只读查看当前 phase/node 和 procedure。

## 工具

### gate_start_phase

只允许 root 调用，在用户已授权时从 `discuss`/`complete` 进入 `plan` 或 `implement`：

```text
gate_start_phase({ node: 'plan' | 'implement', brief })
```

### gate_record

只允许 root 调用。它记录节点结果、推进状态，并返回 transition 后的当前 procedure。

```text
gate_record({
  node,
  task,
  workerSessionIds,
  findings,
  reviewAxes,
  requiresDiscussion,
  discussionReason,
  verification
})
```

- `node`：`plan`、`plan-review`、`proposal-review`、`plan-revise`、`implement`、`code-review`、`implement-revise`、`verify`、`verify-standalone`、`code-review-standalone`、`fix-bug`、`note-lifecycle`、`docs`。
- `plan` 必须带 `task`。
- worker 节点必须带当前 root 的、已 settled 的 child `workerSessionIds`。
- `plan-review`/`proposal-review` 需要 Standards/Spec/Architecture 三轴；`code-review`/`code-review-standalone` 需要 Standards/Spec 两轴。
- `requiresDiscussion=true` 进入 blocked，等待用户决定。
- review 达到 `reviewLimit` 仍有 findings 时 blocked，不能靠重新进入 implement 绕过。

### gate_status

只读，root 和 worker 可调用。root 返回当前 procedure 与状态；worker 只返回状态，不返回 root procedure。

```text
gate_status()
```

### Note 工具

- `gate_note_write`：planning worker 写 proposed Note，或原地更新 implemented Note；通用 `write`/`edit`/`apply_patch`/shell 在 planning 被拒绝。
- `gate_note_verify`：root 在 note-lifecycle 中跑 notes 校验。
- `gate_note_finalize`：root 把 proposed Note 移到 implemented 并更新头块。

## Verify 证据

```json
{
  "verification": {
    "commands": ["node packages/gate/test/unit.mjs"],
    "evidence": ["artifacts/verify.txt"],
    "toolResults": ["call_..."],
    "passed": true
  }
}
```

- `commands`、`evidence`、`toolResults` 不能为空；
- `evidence` 必须是 gate workspace 内的普通文件；
- `toolResults` 必须是 verify worker session log 中真实 `tool/result` 的 `call_...` id；
- gate 记录 evidence 的 `path`、`size`、`sha256`；
- 绑定成功后 verify 标记 `selfReported:false`、`executionBound:true`；
- `commands`/`evidence` 是主代理转述，不是完整独立执行证明。

## 配置

插件 Config：

```json
{ "reviewLimit": 5 }
```

`reviewLimit` 是每个 review 节点的最大轮次；默认 5，范围 1–20。达到上限仍有 findings 时进入 blocked。

## 使用边界

- gate 是流程门禁，不是 OS 安全边界；未知工具和任意 shell 语义不会被完整分析。
- blocked 的写冻结是 guard/restrict 的进程级限制；需要强隔离时使用 DSH sandbox/approval。
- root 在 code-review/verify 可写文件；修改被评审实现后必须重跑 review/verify。
- 旧会话不会自动恢复 gate 管理的 sandbox mode；gate 不再 append `sandbox/mode`。
