# Agent Note: init-manifest 与 gate_init_verify

Status: implemented

工作项：为 `/gate-init` 产物提供可重复的本地校验，避免模型为了核对初始化去读插件源码或解析 app.asar。本 Note 承接 init manifest 与只读 verify 工具；不改变 `gate-init` 的 provisioning 行为，只增加证据。

## Problem

session `d8ec5e8d` 中，用户要求“只检查初始化配置是否正确”。工作区只有 init 产物，没有生成规则或版本清单。模型为了做逐字节/哈希校验，去读：

- `C:\Users\MyPC\.dsh\profiles\desktop\node_modules\dsh-gate-agent\lib\index.js`
- skills/templates/launchers
- 甚至尝试解析 `app.asar`

结果：

- 初始化本身没有阻塞性错误；
- 但模型绕路、读大文件、解析 app.asar，浪费 token/tool 时间；
- 校验依据来自“当前安装的插件”，不是 init 当时的版本；
- 没有区分“应固定的生成物”和“用户可编辑的配置”。

不能把所有 init 产物都 hash：

- notes 内容持续变化；
- `artifact-policy.json` 用户会改；
- `AGENTS.md`、`package.json`、`.gitignore`、workflow 也可能由用户维护。

## Decision

### Decision

#### 1. 新增 `.agents/gate/init-manifest.json`

`/gate-init` 在所有 provisioning 完成后生成/更新：

```json
{
  "version": 1,
  "gateVersion": "0.1.5",
  "createdAt": "ISO",
  "immutable": {
    ".agents/gate/ci/agent-note-tree.ts": "sha256:<64 hex>",
    ".agents/gate/ci/verify-agent-note-tree.ts": "sha256:<64 hex>",
    ".agents/gate/ci/verify-agent-note-format.ts": "sha256:<64 hex>",
    ".agents/gate/ci/verify-agent-note-lifecycle.ts": "sha256:<64 hex>",
    ".agents/gate/ci/verify-archived-agent-notes.ts": "sha256:<64 hex>",
    ".agents/gate/verify-notes.mjs": "sha256:<64 hex>"
  },
  "managed": {
    "artifactPolicy": {
      "path": ".agents/gate/artifact-policy.json",
      "schemaVersion": 1,
      "sha256": "sha256:<64 hex>"
    },
    "agentsBlockHash": "sha256:<64 hex>",
    "packageScript": "node .agents/gate/verify-notes.mjs",
    "workflow": ".github/workflows/verify-notes.yml"
  },
  "notes": {
    "path": ".agents/notes",
    "lifecycles": ["proposed", "implemented", "rejected", "archived"]
  }
}
```

- `createdAt` 只在首次生成时写入；重跑 init 保留。
- 不写 `updatedAt`：同内容重跑 init 时 manifest 字节稳定，避免每次 init 产生无意义 diff；生成物/策略变化时 manifest 自然变化。
- `gateVersion` 取插件 package.json 的 version。
- manifest 自身不做 hash。
- immutable 列表必须由 `NOTES_CI_SCRIPTS` 动态生成，当前为 5 个脚本 + launcher；示例只是完整列表。
- 所有 hash 格式统一为 `sha256:<64 位小写 hex>`，对文件原始字节计算，不做换行归一化。
- `init-manifest.json` 作为生成证据被 git 跟踪，不加入 `.gitignore`；由用户在 init 变更时一并提交。
- `packageScript` 记录 `provisionProjectScripts` 实际返回的 command，而不是固定的默认命令。

#### 2. immutable 范围

只 hash `/gate-init` 会覆盖的生成物：

- `.agents/gate/ci/*.ts`（`NOTES_CI_SCRIPTS`）
- `.agents/gate/verify-notes.mjs`

不 hash：

- `artifact-policy.json`
- `AGENTS.md`
- `package.json`
- `.gitignore`
- `.github/workflows/verify-notes.yml`
- `.agents/notes/**`

#### 3. managed 检查

- `artifactPolicy`：读取并调用现有 `parseArtifactPolicy`；有效即通过。当前文件 hash 与 manifest 的 `sha256` 不同时报告 `customized`，但仍算 valid；不把 hash 变更当失败。
- `agentsBlock`：比较 AGENTS.md 中的 managed block 与 manifest 记录的 `agentsBlockHash`；不比较整份 AGENTS.md。
- `packageScript`：比较 `package.json` 的 `scripts.verify-notes`；用户改脚本时报告 `customized`，不因 hash 失败。
- `workflow`：只检查存在；用户可自定义，不 hash。缺失报告 `workflow: missing` + warning，不阻断 `ok`。
- `notes`：检查四个 lifecycle 目录存在；不检查 Note 内容/hash。内容验证继续用 `verify-notes`。

#### 4. `gate_init_verify`

新增 root-only 只读工具：

```ts
gate_init_verify()
```

返回结构化报告：

```ts
{
  ok: boolean,
  manifest: 'ok' | 'missing' | 'invalid',
  immutable: Array<{ path, status: 'ok'|'missing'|'modified'|'unknown' }>,
  artifactPolicy: 'ok'|'customized'|'missing'|'invalid',
  agentsBlock: 'ok'|'modified'|'missing'|'unknown',
  packageScript: 'ok'|'customized'|'missing'|'unknown',
  workflow: 'existing'|'missing',
  notes: 'ok'|'missing',
  issues: Array<{ severity:'error'|'warning', code, message }>,
  text: string
}
```

- 不修改 state、不写文件、不重新 run init。
- 可选：不自动运行 `verify-notes`，避免把内容校验混入 init 校验。
- `ok` 为 true 的条件：manifest 有效；immutable 全部 ok；notes 四目录存在；artifact policy 有效（custom 也算有效）；agents block 存在；package script 存在；workflow missing 只是 warning。
- manifest missing/invalid 时仍运行 editable 检查，但 immutable 标记 `unknown`，整体 ok=false。
- immutable mismatch/missing = error；manifest missing/invalid = error；notes missing = error；artifact policy invalid/missing = error。
- immutable 的期望 key 集合固定为 `NOTES_CI_SCRIPTS` 的 5 个脚本 + `.agents/gate/verify-notes.mjs`；manifest 删除任一项也报 missing。
- `agentsBlock` 缺失 = error；modified = warning（用户可能有意改，`/gate-init` 会覆盖）。
- `packageScript` 缺失 = error；customized = warning。manifest 记录的是实际 command，避免 init 保留自定义脚本后立即误报。
- `gateVersion` 与当前插件 version 不同 = warning `stale-init`，建议 rerun `/gate-init`；不自动改。
- manifest missing 时 `agentsBlock`/`packageScript` 报 `unknown`；manifest invalid 时同样不假装 ok。
- 输出文本按 section 展示，错误优先；warnings 不使 ok=false。

#### 5. gate-init 输出

`/gate-init` 增加：

- `init-manifest.json` 路径和状态（created/updated）；
- 提示 `gate_init_verify` 可用于只读核对。

重跑 init 会把当前 artifact-policy 的 hash 重新作为 manifest 基线；因此用户先改 policy 再重跑 init，后续 `gate_init_verify` 会显示 `ok` 而不是 `customized`。

不改变现有文件覆盖策略：

- artifact policy 不覆盖；
- 已有 `.gitignore` 不改；
- workflow 只在缺失时生成；
- CI scripts/launcher 继续覆盖；
- manifest 只在 init 后更新。

### 非目标

- 不 hash notes 内容；
- 不 hash 用户可编辑配置；
- 不自动修复错误，只报告；
- 不新增 `/gate-init-verify` 用户命令（只加工具）；
- 不把 `verify-notes` 内容检查合并进 init verify；
- 不改变 `/gate-init` 的 provisioning 行为。

## Implementation evidence

- 新增 `src/init-manifest.ts`：manifest schema、6 个 immutable hash、createdAt 保留、artifact-policy/AGENTS/packageScript/workflow/notes 检查、stale 版本。
- 新增 `gate_init_verify` root-only 只读工具；`/gate-init` 生成/更新 manifest 并输出 created/updated。
- manifest 不 hash 用户可编辑文件；policy 改动只报 customized；notes 不检查内容。
- 工具数 9 → 10，命令 17 不变；registry/help/README/skill docs 同步。
- 测试覆盖 created/updated、6 个 hash、删除 immutable key、manifest missing/invalid、policy custom/invalid、notes missing、workflow missing、stale。
- `pnpm typecheck`、`pnpm build`、`pnpm test`、`pnpm verify-notes` 通过。

## Alternatives considered

1. **所有 init 文件都 hash**：notes/AGENTS/package/policy 每次变化都会误报。否决。
2. **hash 整个目录**：无法区分用户修改和生成物；notes 持续变化。否决。
3. **让 gate_init_verify 自动 rerun init**：会覆盖用户文件，违背 init 的不覆盖策略。否决。
4. **只校验 schema，不做 immutable hash**：无法发现 CI 脚本/launcher 被改。否决。
5. **新增 `/gate-init-verify` 命令**：用户只要求工具；`gate_init_verify` 即可，避免命令目录膨胀。否决。

## Consequences

### Acceptance criteria

1. `/gate-init` 生成 `.agents/gate/init-manifest.json`；首次写 createdAt，重跑保留 createdAt，只更新 gateVersion/immutable/managed 的当前值；不写 updatedAt。
2. manifest 记录 immutable hashes（CI scripts + launcher）和 managed metadata；不记录用户可编辑文件 hash。
3. `gate_init_verify` root-only、只读；不改变 state/files。
4. `gate_init_verify` 对 manifest missing/invalid、immutable mismatch、policy invalid/missing、notes missing 返回 error。
5. policy custom 但有效 → `customized` + ok；AGENTS block/package script custom → warning；notes 内容不检查。
6. 插件版本与 manifest gateVersion 不同 → stale warning，不自动改。
7. `gate_init_verify` 输出结构化 JSON + 可读 text；工具数 9 → 10，命令仍 17；README、`skills/gate-write-agent-notes/SKILL.md`/`references/verification.md`、gate_help、registry.snapshot.json、硬编码断言同步。
8. 测试覆盖 init manifest created/updated、5 个 CI 脚本 + launcher hash、删除 immutable key、manifest missing/invalid、packageScript 实际值、policy custom/invalid、notes missing、AGENTS/package custom、workflow missing、stale version。
9. `pnpm typecheck`、`pnpm build`、`pnpm test`、`pnpm verify-notes` 通过。
10. README 说明 manifest、hash 范围、用户可编辑文件和按需验证。

### Risks

- manifest 自身被用户修改：verify 检查格式/版本，不防篡改；它只是诊断证据，不是安全边界。
- immutable 文件用户定制后会被 init 覆盖；verify 会报 modified，应在 README 说明。
- `createdAt` 时钟不可信；只作显示，不参与校验。
- 不写 `updatedAt` 会让 manifest 无法显示“最近一次 init 时间”；以文件内容/hash 变化和 git diff 作为实际证据。
- `gateVersion` 来自 package.json，npm/link 来源可能不同；stale 只 warning。
- notes 结构检查与 `verify-notes` 内容检查职责分离；用户需分别运行。
