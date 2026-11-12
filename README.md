# dsh-plugin-gate

本仓库分为两层：

- **仓库治理层**：根 [`AGENTS.md`](AGENTS.md)、[`.agents/`](.agents/GATES.md)、[`docs/`](docs/AGENTS.md)，以及开发用的 `deepseek-harness/` 目录联接（gitignored）。
- **插件包层**：[`packages/gate/`](packages/gate/README.md)，唯一可安装的 `dsh.bundle`。

插件运行时不得读取仓库 `.agents/`、`docs/`、`AGENTS.md`；项目级资源从被 gate 的项目根或插件 Config 解析。目录边界决策见 [`2026-11-10-repo-plugin-boundary.md`](.agents/notes/implemented/process/2026-11-10-repo-plugin-boundary.md)。

## 插件

- 使用文档：[`packages/gate/README.md`](packages/gate/README.md)
- Bundle patch：[`packages/gate/cordis.patch.yml`](packages/gate/cordis.patch.yml)
- 安装前先构建：`pnpm install && pnpm build`；`lib/` 是 gitignored 的构建产物，未 build 的 link/path install 会挂载失败。
- 安装：`plugin_manager` 的 `install_bundle`，target 指向 `packages/gate` 的绝对路径；安装/升级后重启 DSH。
- 插件由“开发者模式”preset 启用；安装后先执行 `/gate-init`。

### 从旧 gate 迁移

1. profile 依赖移除 `@dsh-nove/implement-gate`，删除 `@dsh-nove/gate` 的 link；不要保留旧 gate bundle。
2. 安装目标改为 `packages/gate`；先 `pnpm build`，安装/升级后重启 DSH。
3. 删除旧 `.agents/implement-gate.json`、`.agents/state/implement-gate`；只保留一个新的 gate 实现。
4. 工具面仍有 `implement_gate` 时，先移除旧实现。

## 开发

- `pnpm install`：安装 workspace 开发依赖
- `pnpm build`：esbuild 生成 `packages/gate/lib/index.js`
- `pnpm typecheck`：`tsc --noEmit` 类型检查
- `pnpm test`：build 后跑插件单测、composition、registry 快照与 check-split
- `pnpm verify-notes`：Agent Note 目录、格式与归档校验
- `pnpm -C packages/gate test`：包内 build + 单测

安装前必须先 `pnpm build`；`lib/` 不入库。

## 文档

- 文档属主与位置：[`docs/AGENTS.md`](docs/AGENTS.md)
- 开发流程与门禁：[`AGENTS.md`](AGENTS.md)、[`.agents/GATES.md`](.agents/GATES.md)
- 长期设计与决定：`.agents/notes/`
