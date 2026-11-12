# Agent Note: npm 发布经验与 staged release

Status: implemented

工作项：本次会话“`dsh-gate-agent` 发布到 npm registry”。本 Note 记录发布流程、npm staged publishing 的实测行为、失败模式和下次发布的检查清单；不改变插件运行行为。

## Problem

`dsh-gate-agent` 原先只有 profile link 安装，没有 npm 发布配置：

- `packages/gate/package.json` 是 `private: true`；
- 没有 `publishConfig`；
- 构建产物 `lib/` gitignored，发布前必须显式 build；
- 第一次发布遇到 npm 11.6 的 staged publishing：`npm publish` 返回成功，但 registry 先出现 `0.0.0-stage` 占位版本，实际 `0.1.0` 延迟可见；
- npm 的 cache/credentials 在 workspace 外，受限 sandbox 下 `npm whoami` 会因 cache EPERM 失败；
- `npm pack packages/gate` 被 npm 当成 git spec 解析，正确做法是在包目录执行 `npm pack`，或使用 `./packages/gate`。

## Decision

### 发布配置

- 包保持 unscoped `dsh-gate-agent`；`publishConfig.access: "public"`。
- 删除包的 `private: true`；根 `package.json` 仍 private。
- `files` 只带运行资源：`lib`、`skills`、`launchers`、`cordis.patch.yml`、`README.md`、`locale/*.json`、`icon.svg`。
- 发布前 `pnpm build`，不在 publish 生命周期里隐式构建；`lib/` 不入库、必须存在。

### 发布步骤

```text
pnpm build
npm pack --dry-run --json        # 在 packages/gate 目录执行
npm whoami
npm view dsh-gate-agent version  # 新包应 404
npm publish --access public
npm view dsh-gate-agent version
```

- npm CLI 需要访问全局 cache/credentials；在 DSH workspace sandbox 下用 full access 执行。
- `npm publish` 成功后不要立即把“命令成功”当成“用户可安装”；必须用 `npm view <name> version` 验证 registry。
- 首次发布会自动产生 `0.0.0-stage` 占位版本；这是 npm staged publishing 的名称保留/审批机制，不是包内容。
- 账 户 Staged Packages 页面可能暂时为空，而版本仍在处理队列；不要在未确认前重复 `npm publish`，否则可能得到 `E409 Cannot publish over previously staged version`。
- 传播完成后 `npm view` 的 `versions` 应同时包含 `0.0.0-stage` 与目标版本，`dist-tags.latest` 指向目标版本。

### 安装来源（2026-11-12 实测事故）

**不要让 profile 的安装 target 指向本地 `packages/gate` 路径。**

本次通过 `install_bundle` 的绝对路径安装，profile 里生成 `link:E:/workspace/.../packages/gate`。卸载插件后，`packages/gate` 的源文件被一起删除；`git status` 显示全部为 deleted，但历史仍在，已用 `git restore --source=HEAD -- packages/gate` 恢复并重新 build。

正确做法：

- **生产安装**：安装 target 使用 npm 版本，例如 `dsh-gate-agent@0.1.1`；profile 依赖写成 `"dsh-gate-agent": "0.1.1"`，node_modules 是 registry 包的独立副本（pnpm store 硬链接），卸载只删除 profile 副本。
- **开发安装**：不要直接 link 正在开发的源目录。用 `npm pack` 生成 `.tgz`，把 tarball 绝对路径交给 `install_bundle`；或 link 一个可丢弃副本。tarball 安装也是独立副本，卸载不会删除源目录。
- 本次修复后 profile 使用本地 tarball：`file:E:/workspace/dsh-plugin/gate/.artifacts/dsh-gate-agent-0.1.1.tgz`；源目录仍是开发目录，改代码后重新 pack/install 验证。
- 发布 npm 不会自动替换已 link 的 profile，切换来源后要重新安装并重启 DSH。

### staged release 处理

- npm 文档：[Staged publishing](https://docs.npmjs.com/staged-publishing/)。
- 如果 staged 版本需要审批，用维护者账号在 npmjs.com 的 staged release 页面完成 2FA 审批；CLI 的 `npm stage` 在 npm 11.6.1 不可用，不能假设有 `npm stage` 命令。
- 本次实测：`npm publish` 后约 1–2 分钟 registry 传播完成，`0.1.0` 成为 `latest`；不需要额外 CLI 操作。
- 若长时间只有 `0.0.0-stage`，先查 npmjs.com 的 package/staged 页面；不要立刻换版本重发，避免占用版本号或产生 pending staged version。

### 验证与提交

- 发布后验证：`npm view dsh-gate-agent version`、`dist-tags`、`dist.tarball`。
- 发布配置是源码事实，发布后提交：
  ```text
  git add packages/gate/package.json
  git commit -m "chore(release): enable public npm publishing"
  git push origin main
  ```
- profile 的 link 安装与 npm 包是两种安装来源；发布 npm 不会自动替换已 link 的 profile。需要时重新用 npm 包安装并重启 DSH。

## Implementation evidence

- `dsh-gate-agent@0.1.1` 已发布，`dist-tags.latest = 0.1.1`，tarball `https://registry.npmjs.org/dsh-gate-agent/-/dsh-gate-agent-0.1.1.tgz`；本次是技能加载提示词优化后的 patch 版本。
- 0.1.0 首次发布时约 5 分钟后才在 registry 可见；0.1.1 同样经历短暂传播延迟，`npm view` 最终确认 latest。
- tarball 65 个文件、约 144.2 kB；包含 `lib/index.js`、skills、launchers、locale、icon、`cordis.patch.yml`、README。
- `0.0.0-stage` 占位版本保留在 versions 列表，属于首次 staged publishing 的正常结果。
- 安装事故：path/link 安装后卸载导致 `packages/gate` 源文件被删；已从 HEAD 恢复，当前 profile 改为本地 tarball `file:E:/workspace/dsh-plugin/gate/.artifacts/dsh-gate-agent-0.1.1.tgz`，node_modules 为独立副本。
- 发布配置提交：`chore(release): enable public npm publishing`。

## Alternatives considered

1. **保持 private，只做 link 安装**：不引入 registry/版本管理。否决：用户要求 npm 发布，且 link 安装不适合分发。
2. **发布前用 `prepublishOnly` 自动 build**：少一步手工操作。否决：`prepublishOnly` 依赖 workspace 的 esbuild/root devDependencies，在 npm 打包/外部环境不可靠；显式 build + pack 预览更可控。
3. **首次发布遇到 placeholder 就改用新版本号**：绕过等待。否决：可能留下 pending staged version，且 `E409` 会让版本不可重发；应先等待/审批。
4. **发布 scoped 包**：更容易做 access 控制。否决：当前包名和 profile 都使用 `dsh-gate-agent`，改名会破坏现有引用。

## Consequences

- 正常发布命令可复用；发布前必须 build 并 pack 预览。
- `0.0.0-stage` 会永久出现在版本列表，不要把它当 latest 或安装目标。
- npm 发布依赖账号 2FA/权限和 registry 传播；`npm publish` 成功只代表提交成功，`npm view` 才是可见性证据。
- `lib/` 仍不入库；源码 checkout 不能直接 `npm publish`，必须先 build。
- 发布配置变更已经提交；后续版本发布应更新版本号并重复本清单。
