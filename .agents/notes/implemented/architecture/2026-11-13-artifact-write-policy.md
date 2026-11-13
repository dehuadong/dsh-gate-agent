# Agent Note: Artifact 写入白名单与 gate-init 基础配置

Status: implemented

工作项：本次会话“discuss/plan 中的 artifact 技能写入权限”。本 Note 承接 artifact policy、`gate_artifact_write`、`gate_research_dispatch`、`/gate-prd` 命令和 `/gate-init` 模板；不改变默认文件写矩阵。

## Problem

以下技能需要产物写入，但 discuss/plan 默认只读：

- `gate-prd`：用户级 skill，discuss 中创建/更新 PRD；
- `gate-handoff`：用户级 skill，交接文档；当前写 OS temp，workspace 外路径被拒绝；
- `gate-research`：模型在 discuss/plan 发起，后台 worker 写 Markdown；
- `gate-writing-for-agents`：改 skill/AGENTS 时走 implement；
- `gate-playwright-e2e`：模型走 implement；用户 discuss 只做方案。

当前权限矩阵：

- discuss root：文件只读；
- planning worker：只读 shell + `gate_note_write`；
- implement/fix worker：可写；
- docs root：可写。

因此，artifact 技能不能在 discuss/plan 落盘，且 handoff 在 workspace 外始终失败。

用户确认：

- `paths` 支持精确文件、目录、glob、单层 glob；
- `/gate-init` 创建 `.agents/gate/artifact-policy.json` 基础配置，且不覆盖已有文件；
- 不新增 `/gate-research` 用户命令；
- `gate-research` 可以派 worker。

## Decision

### Decision

#### 1. artifact policy 文件

位置：

```text
.agents/gate/artifact-policy.json
```

基础结构：

```json
{
  "version": 1,
  "artifacts": {
    "handoff": {
      "phases": ["*"],
      "roles": ["root"],
      "paths": [".scratch/handoff/**"]
    },
    "prd": {
      "phases": ["discuss"],
      "roles": ["root"],
      "paths": ["docs/prd/**", ".scratch/prd/**"]
    },
    "research": {
      "phases": ["discuss", "orchestrating/plan"],
      "roles": ["root", "worker"],
      "paths": ["docs/research/**", ".scratch/research/**"]
    }
  }
}
```

规则：

- `version` 必须为 `1`；
- `artifacts` key 是 artifact kind；内置为 `handoff`、`prd`、`research`，但 policy 允许用户增加 kind；
- `phases` 使用 `methodologyKeyFor(state)` 的 canonical key（`discuss`、`orchestrating/plan`、`reviewing/...` 等）；`*` 表示任意 **非 blocked** 状态；blocked 始终拒绝，即使 policy 写 `*`；
- `roles`：`root` / `worker`；
- `paths`：精确文件、目录、glob；`*` 只匹配一个路径段，`**` 匹配零个或多个路径段；末尾 `/**` 是目录范围；
- 未命中规则一律拒绝；
- 配置缺失/无效时 artifact 写入失败，不静默放行；
- 不覆盖已有文件；`/gate-init` 只在不存在时创建基础配置；
- 新建 `.gitignore` 时基础项增加 `.scratch/`；已有 `.gitignore` 不重写。

#### 2. `gate_artifact_write`

新增 root/worker 均可调用的写入工具：

```ts
gate_artifact_write({
  kind: string,
  path: '.scratch/research/foo.md',
  content: '...'
})
```

`kind` 是 policy 中的 key，不在 tool schema 里硬编码；内置技能使用 `handoff`、`prd`、`research`，用户可增加 kind。

- 读取 gate root 下的 policy；
- 检查 `kind + methodologyKeyFor(state) + root/worker + path`；
- blocked 在任何 policy 下都拒绝；
- 精确路径/目录/glob 匹配；
- 只允许 workspace 内相对路径；
- 拒绝绝对路径、`..`、symlink、越界；
- 允许创建目标文件父目录，但父目录也做 symlink/边界检查；
- 只写文件，不创建空目录 artifact；
- 返回实际相对路径，不暴露任意文件写；
- 保留路径：`.agents/gate/artifact-policy.json` 和 `.agents/notes/**` 永远拒绝，不能通过 policy 自我放大或绕过 Note 工具。

该工具不进入普通 `write` 权限矩阵；普通 write 仍按 access 拒绝。

#### 3. `/gate-prd` 用户命令

新增：

```text
/gate-prd [主题或上下文]
```

- 用户级命令，仅 discuss 可用；
- 不改变 phase/node；
- command 读取并注入 `skills/gate-prd/SKILL.md` 的指令（或让 root 读取该文件），不依赖用户 skill 的 `disable-model-invocation`；
- skill 用 `gate_artifact_write(kind:'prd')` 写 PRD；
- 没有 policy 时明确报错，不伪造写入权限。

不新增 `/gate-research` 命令；`gate-research` 保持 `user-invocable: false`。

#### 4. `gate_research_dispatch`

新增 root-only 内部工具：

```ts
gate_research_dispatch({
  question: string,
  purpose?: string,
})
```

- 只在 `discuss` 或 `orchestrating/plan` 可用；
- 检查 policy 的 `research` 允许当前 phase 和 `worker` role；
- 通过 `ctx.subagents.startActivation` 启动 research worker；
- 参数必须包含 provider（默认 `spawn`）、label、prompt: ContentBlock[]、parent（`exec.agent`）、signal（`exec.signal`）、delivery: `caller`；
- 工具等待 `activation.result`，返回 worker 的 output/写入路径，再 `dispose()`；使用 `delivery: caller`，避免 parent notice 与 tool result 重复投递；这期间 root 不推进 phase，避免 research worker 写时 phase 已变化；
- `ctx.subagents` 不可用或 provider 不存在时返回明确错误，不 fallback 到通用写；
- worker prompt 直接包含 research 任务与 artifact tool 用法，不依赖 gate 技能加载；
- worker 只获得 artifact 写能力，不获得通用 workspace 写；
- 通用 `subagent` 在 discuss 仍拒绝；
- 该工具替代 `/gate-research` 用户命令。

#### 5. 技能调整

- `gate-handoff`：产物路径改为 `.scratch/handoff/`；使用 `gate_artifact_write(kind:'handoff')`；
- `gate-prd`：使用 artifact tool；保持 discuss；
- `gate-research`：使用 artifact tool；discuss/plan；由 `gate_research_dispatch` 派 worker；
- `gate-writing-for-agents`：改 skill/AGENTS 时走 implement；
- `gate-playwright-e2e`：模型走 implement；用户 discuss 只做方案，落盘在 implement。

### Registry 与帮助

- `command-catalog.ts` 增加 `/gate-prd`（16 → 17 个命令）；
- `tools/catalog.ts` 增加 `gate_artifact_write` 与 `gate_research_dispatch`（7 → 9 个工具）；
- `gate_help` 输出、README 命令/工具表、`test/registry.snapshot.json` 同步；
- 现有硬编码断言 `help.commands.length===16`、`help.tools.length===7` 改为 17/9。

### Policy 校验

- 顶层只允许 `version`、`artifacts`；
- kind 必须有 `phases`、`roles`、`paths`；
- phases 不允许未知 phase；
- roles 只允许 `root`、`worker`；
- paths 必须是 workspace 内相对模式，不允许绝对路径/`..`；
- 非法配置整体失效，返回明确错误。

### 基础配置写入

新增 `provisionArtifactPolicy(root)`：

- 确保 `.agents/gate/` 存在；
- 文件不存在时写基础配置；
- 文件存在时不覆盖，返回 `existing`；
- 不在 `provisionNotes` 里隐式覆盖用户配置。

`/gate-init` 输出增加 artifact policy 路径/状态。

### 非目标

- 不打开 discuss 的通用 write；
- 不改变普通 `gate_note_write`/planner 权限；
- 不新增 `/gate-research` 命令；
- 不让 `gate_artifact_write` 写任意 workspace 路径；
- 不让 policy 影响 shell 写入；shell 仍按 access 拒绝/允许；
- 不把 Playwright 的依赖安装/配置写入放进 discuss。

## 已有 Note 审计

- [Gate 阶段/角色读写权限与 access](../../implemented/architecture/2026-11-13-gate-access-permissions.md)：其 `access.write='none'` 仍适用于通用 write；本 Note 增加独立的 policy-scoped artifact 写能力，部分修订“discuss/plan 完全不能产生文件”的表述。旧 Note 加指针。
- [Gate 命令目录](../../implemented/architecture/2026-11-13-gate-command-catalog.md)：`/gate-prd` 需加入 command catalog；`gate_help`/registry 同步。
- [Gate 方法论的 canonical keys](../../implemented/architecture/2026-11-13-gate-methodology-canonical-keys.md)：policy 的 phase 匹配使用 `methodologyKeyFor`，不另造 phase 字符串。
## Implementation evidence

- 新增 `src/artifacts/policy.ts`：policy 解析/校验、精确文件/目录/glob、保留路径、symlink/越界、provision。
- 新增 `gate_artifact_write`；discuss/plan 的 artifact 写入走 policy，generic write 仍拒绝。
- 新增 `gate_research_dispatch`：discuss/plan root-only，caller delivery，await result/dispose；worker 只写 research artifact。
- 新增 `/gate-prd`（discuss-only，命令注入 skill 文件）；`gate-handoff` 改为 `.scratch/handoff/`；research skill 使用 dispatch/artifact。
- `/gate-init` 创建 policy 基础配置且不覆盖；新建 `.gitignore` 含 `.scratch/`。
- registry/help 更新到 17 命令/9 工具；测试覆盖 policy、glob、保留路径、blocked、init、prd、research dispatch。
- `pnpm typecheck`、`pnpm build`、`pnpm test`、`pnpm verify-notes` 通过。

## Alternatives considered

1. **只加 artifact tool，不加 policy 文件**：固定目录不够灵活，用户无法按项目调整 docs 路径。否决。
2. **让 policy 直接授权通用 write**：模型可用 write 写任意匹配路径，shell 仍可绕过；路径判断分散。否决。
3. **新增 `/gate-research` 命令**：用户已明确不需要；research 由模型/内部 dispatch 发起。否决。
4. **让 discuss 的普通 subagent 放开**：会破坏 discuss 不派 worker，且无法只限制 research。否决。
5. **handoff 写 OS temp**：workspace 外路径始终被拒绝；改为 `.scratch/handoff/`。否决旧路径。

## Consequences

### Acceptance criteria

1. `.agents/gate/artifact-policy.json` schema 与基础配置由 `/gate-init` 创建；已有文件不覆盖；新建 `.gitignore` 时基础项含 `.scratch/`，已有文件不重写。
2. `gate_artifact_write` 支持精确文件/目录/glob，拒绝越界/绝对路径/`..`/symlink；只写文件。
3. policy 规则按 kind + phase/node + root/worker + path 生效；非法/缺失 policy 安全失败。
4. `gate-handoff`、`gate-prd`、`gate-research` 使用 artifact tool；handoff 路径 `.scratch/handoff/`。
5. `/gate-prd` 仅 discuss，不改变 phase；无 policy 时明确失败。
6. `gate_research_dispatch` root-only，discuss/plan 可用，派 research worker；worker 只写 research artifact；通用 discuss subagent 仍拒绝。
7. `gate-writing-for-agents` 的 skill/AGENTS 修改走 implement；`gate-playwright-e2e` 模型走 implement，用户 discuss 不落盘。
8. 测试覆盖 policy 解析/路径匹配/越界拒绝、blocked 拒绝、保留路径拒绝、init 不覆盖、handoff/prd/research、research dispatch、命令不改变 phase；更新 `tools/catalog.ts`、`command-catalog.ts`、`registry.snapshot.json`、`gate_help`、README 及硬编码的 16 命令/7 工具断言。
9. `pnpm typecheck`、`pnpm build`、`pnpm test`、`pnpm -C packages/gate test`、`pnpm verify-notes` 通过。
10. README 说明 artifact policy、基础配置、`/gate-prd` 和各技能阶段。

### Risks

- policy 过宽会允许误写；基础配置仅 `.scratch` + docs 指定目录，用户自行扩展；
- `gate_research_dispatch` 依赖 `ctx.subagents` 可用性；不可用时返回明确错误，不退回通用写；同步等待会占用工具调用时间，但研究通常可接受；
- 精确文件与 glob 的匹配需要测试，避免 `docs/prd/*.md` 误解为递归；glob 必须手写，不新增依赖；
- `docs/prd/**` 与 `docs/research/**` 可能写错文档目录；无 policy 时不写；
- 现有 `.gitignore` 不自动加 `.scratch/`，避免覆盖用户内容；README 说明。
