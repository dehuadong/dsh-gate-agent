# Agent Note: 仓库与插件包的目录边界

Status: implemented

## Problem

改造前，仓库根同时是插件包根：`package.json` 既声明 `dsh.bundle`、`exports`、`files`，又承载仓库级 `verify-notes` 脚本；`index.js`、`src/`、`skills/`、`cordis.patch.yml`、`README.md`、`test.mjs` 与 `AGENTS.md`、`.agents/`、`docs/`、`deepseek-harness/` 平铺在同一目录。

这带来四个具体问题：

- 仓库治理文件与插件运行时文件没有物理边界。`install_bundle` 使用本地 link 安装时，`.agents/`、`docs/`、`AGENTS.md` 会随目录一起暴露，`files` 对 link 安装不生效。
- 插件代码通过 `REPO_ROOT = path.resolve(SKILLS, '../../..')`（[index.js](../../../../packages/gate/index.js)）读取仓库级 `.agents/skills/write-agent-notes`；插件安装到 profile 后该路径不存在。这是运行时对仓库治理层的越界依赖。
- `package.json` 的职责混合：插件 manifest 与仓库脚本共用一个文件；根 `README.md` 同时承担仓库入口和插件用户文档，[docs/AGENTS.md](../../../../docs/AGENTS.md) 的文档属主表也因此混层。
- [AGENTS.md](../../../../AGENTS.md) 与 `.agents/GATES.md` 是本仓库开发流程，不是插件运行时契约。改造前的目录布局让读者难以判断某条规则属于哪一层，容易把 `/gate-*` 与仓库授权短语当成同一套。

改造先把“仓库治理层”和“插件包层”固定成物理与文档上的两个边界；P0 与 B 已在此边界上规划。

## Decision

### 1. 最终布局

```text
<repo>/
  AGENTS.md                    # 仓库开发流程
  .agents/
    GATES.md                   # 仓库流程门禁
    notes/                     # 仓库 Agent Note
    skills/                    # 仓库级技能（write-agent-notes 等）
  docs/
    AGENTS.md                  # 仓库文档属主
    agents/domain.md
  packages/
    gate/                      # 唯一可安装插件包
      package.json             # dsh-gate-agent；exports/files/dsh.bundle
      cordis.patch.yml
      README.md                # 插件用户文档
      index.js
      src/
      skills/                  # 插件自有 gate-* 技能
      locale/                  # P0 增加
      icon.svg                 # P0 增加
      test/                    # 插件单测/组合测试
  README.md                    # 仓库总览
  package.json                 # 仓库脚本，private，无 dsh 字段
  .gitignore
  deepseek-harness/            # 外部 DSH 源码联接，gitignored
```

### 2. 迁移结果

| 原位置 | 当前位置 | 说明 |
|---|---|---|
| `index.js` | `packages/gate/index.js` | 用 `git mv` 保留历史 |
| `src/` | `packages/gate/src/` | 同上 |
| `skills/` | `packages/gate/skills/` | 插件自有技能，与 `.agents/skills/` 分开 |
| `cordis.patch.yml` | `packages/gate/cordis.patch.yml` | 只保留包内 patch |
| `README.md` | `packages/gate/README.md` | 变为插件用户文档 |
| `test.mjs` | `packages/gate/test/unit.mjs` | 更新相对 import |
| `package.json` | 根 `package.json` + `packages/gate/package.json` | 根只留脚本；包留 manifest |
| 新增 | 根 `README.md` | 仓库总览与链接 |
| 保留 | `AGENTS.md`、`.agents/`、`docs/`、`deepseek-harness/`、`.gitignore` | 仓库治理层 |

### 3. Manifest 分工

根 `package.json`：`private: true`，无 `exports`、`files`、`dsh`，只保留 `verify-notes` 与 `test`（转发到 `packages/gate/test/unit.mjs`）。

`packages/gate/package.json`：保留 `name`、`version`、`type`、`exports`、`files`、`dsh.bundle`，增加 `test` 脚本；`files` 只列包内运行时/展示资源。

### 4. 边界规则

1. `packages/gate/**` 在运行时只能读取包内资源，以及被 gate 的项目工作区、marker、state；不得读取仓库 `.agents/`、`docs/`、`AGENTS.md`。
2. 项目级资源（例如目标项目自己的 `write-agent-notes`）从 gate root 或显式 Config 解析；缺失时给出可诊断错误或降级，不得回退到插件仓库路径。**计划（2026-11-10，尚未实现）**：`write-agent-notes` 将由插件内置 `gate-write-agent-notes`，项目级同名技能不再解析；其余项目级资源规则不变。实现落地后本节随代码同批更新。见 [内置 write-agent-notes 与 Verify 后 lifecycle](../../proposed/process/2026-11-10-gate-notes-builtin-lifecycle.md)。
3. 仓库级 `.agents/`、`docs/`、`AGENTS.md`、`deepseek-harness/` 永不进入包 `files`，也不作为运行时路径。**计划（2026-11-10，尚未实现）**：内置 vendor 副本将由同步脚本从仓库 `.agents` 生成到 `packages/gate/assets`；当前 assets/scripts 尚不存在，实现前不进入包。插件运行时只读包内 assets，不读取仓库源。
4. 根 `package.json` 不是 bundle；`packages/gate/package.json` 是唯一 bundle manifest；`cordis.patch.yml` 只在包内。
5. 文档属主：根 `README.md` 是仓库总览；`packages/gate/README.md` 是插件命令、安装与限制；`docs/AGENTS.md` 是仓库文档地图；`.agents/notes/` 是决定与设计。
6. 仓库 `AGENTS.md`、`GATES.md` 不是插件运行时契约。若本仓库自举启用 gate，另加一句仓库级集成说明，明确 `/gate-*` 是本仓库的运行时门禁；插件不解析仓库授权短语。
7. 测试：根 `npm test` 转发到包测试；`npm run verify-notes` 仍检查仓库 Note；包内可有自己的 `test` 脚本。
8. `deepseek-harness/` 保持仓库根联接，gitignored；不移动进包。

### 5. 非目标

- 不改变插件运行行为；
- 不解决 `REPO_ROOT` 与 `.agents` 的运行时依赖（留给 P0）；
- 不安装或启用插件；
- 不合并 `AGENTS.md` 与插件命令。

## 后续工作项

边界落地后，已落两篇 proposed Note：

- **P0**：[Gate P0 — 正确性与边界安全](../bug-fix/2026-11-10-gate-p0-correctness.md)
- **B**：[Gate B — DSH 原生状态与强制](../architecture/2026-11-10-gate-dsh-native.md)

两篇 Note 的 Plan Review 只确认到各自范围；实施仍需单独授权。

## Alternatives considered

**保持根目录为插件包，只把仓库文件放进 `repo/`。** 最强理由是改动最小；但 `AGENTS.md` 与 `.agents/` 必须留在仓库根才能被 agent 发现，移动到子目录会破坏仓库流程，故不采用。

**保持根目录为插件包，仅靠 `files` 排除仓库文件。** 最强理由是无需移动；但 `install_bundle` 的本地 link 安装会暴露整个仓库目录，`files` 不生效，且物理边界仍不清晰，故不采用。

**沿用旧的 `tools/gate/` 布局。** 最强理由是历史上 `REPO_ROOT` 的 `../../..` 正好指向仓库根；但这是靠目录深度维持的隐式耦合，且 `.gitignore` 已出现 `packages/` 约定，故不采用。

**拆成两个仓库（插件仓库 + 治理仓库）。** 最强理由是边界最彻底；但本地开发与安装需要跨仓库同步，当前阶段成本过高，故不采用。

## Consequences

- 仓库治理层与插件包层物理分离；`packages/gate` 是唯一包含 `dsh.bundle` 的包，根 `package.json` 只承载仓库脚本。
- `packages/gate` 的 `files` 只包含包内运行时与技能；`npm pack --dry-run` 确认不包含 `.agents/`、`docs/`、`AGENTS.md`、`deepseek-harness/`。
- 验证通过：`node --check packages/gate/index.js`、`npm test`、`npm --prefix packages/gate test`、`npm run verify-notes`（6 篇 Note）。
- 文档属主已同步：根 `README.md` 是仓库总览，`packages/gate/README.md` 是插件用户文档，`docs/AGENTS.md` 与根 `AGENTS.md` 写明仓库/插件边界。
- 代价与风险：移动到 `packages/gate` 后 `REPO_ROOT = ../../..` 恰好回到仓库根，`NOTE_SKILL` 在本仓库会“看起来正常”；这不是修复，P0 必须移除对仓库 `.agents` 的依赖，否则安装后仍坏。profile 仍 link 旧 `@dsh-nove/gate`；本仓库的 `install_bundle` 目标变为 `packages/gate`，迁移需要手动重装或重启。
- P0 与 B 的 proposed Note 已存在，但尚未实施/评审通过；本 Note 只固定边界，不代表插件行为已经修好。
