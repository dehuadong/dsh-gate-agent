# dsh-plugin-gate

本仓库分为两层：

- **仓库治理层**：根 [`AGENTS.md`](AGENTS.md)、[`.agents/`](.agents/GATES.md)、[`docs/`](docs/AGENTS.md)，以及开发用的 `deepseek-harness/` 目录联接（gitignored）。
- **插件包层**：[`packages/gate/`](packages/gate/README.md)，唯一可安装的 `dsh.bundle`。

插件运行时不得读取仓库 `.agents/`、`docs/`、`AGENTS.md`；项目级资源从被 gate 的项目根或插件 Config 解析。目录边界决策见 [`2026-11-10-repo-plugin-boundary.md`](.agents/notes/implemented/process/2026-11-10-repo-plugin-boundary.md)。

## 插件

- 入口：[`packages/gate/README.md`](packages/gate/README.md)
- 安装：`plugin_manager` 的 `install_bundle` 目标为 `packages/gate`（绝对路径以当前 checkout 为准）
- Bundle patch：[`packages/gate/cordis.patch.yml`](packages/gate/cordis.patch.yml)

## 开发

- `npm test`：插件单测
- `npm run verify-notes`：Agent Note 目录、格式与归档校验
- `npm --prefix packages/gate test`：包内单测

## 文档

- 文档属主与位置：[`docs/AGENTS.md`](docs/AGENTS.md)
- 开发流程与门禁：[`AGENTS.md`](AGENTS.md)、[`.agents/GATES.md`](.agents/GATES.md)
- 长期设计与决定：`.agents/notes/`
