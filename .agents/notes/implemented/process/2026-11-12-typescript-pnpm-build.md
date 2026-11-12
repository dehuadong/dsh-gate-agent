# Agent Note: TypeScript + pnpm 构建迁移

Status: implemented

工作项：本次会话“将 gate 插件从直接 JS 入口迁移到 TypeScript 源码 + pnpm 构建”。本 Note 承接构建工具链、包入口与测试方式；gate 的 phase/commit/root-write 行为合同不变，由既有 implemented Notes 承接。

## Problem

当前 `packages/gate` 是“JS 源码直装”：

- `packages/gate/index.js` 直接作为包入口，约 2,000 行；
- `packages/gate/src/classify.js`、`src/state.js` 也是 JS；
- 根 `package.json` 没有 TypeScript、esbuild 或任何构建脚本；
- 没有 `tsc` 类型检查，`index.js` 的 state、tool 参数和 DSH 边界都是隐式 `any`；
- 安装 profile 的 link 直接加载 `index.js`，修改后只能靠运行测试发现语法/路径问题。

参考项目 `E:\see-dsh-novel` 的做法：

- `src/**/*.ts` 源码，`tsc -p tsconfig.json` 只做 `noEmit` 类型检查；
- esbuild 把 Node 入口打成单文件 `lib/index.js`，DSH 用原生 `import()` 加载；
- `package.json` 的 `exports` 指向 `lib`，`files` 只带运行资源；
- pnpm workspace + `pnpm-lock.yaml` + `allowBuilds: esbuild`；
- 测试用 `node`/`tsx`，构建后再验证产物。

本仓库 `.gitignore` 已预留 `/packages/*/lib/`，说明构建产物 `lib/` 不入库、由 build 生成。当前缺少的是源码布局、工具链和入口路径。

## Decision

### 包管理器与 workspace

采用 **pnpm**（参考项目同版本 `pnpm@11.21.0`）：

- 根 `package.json` 增加 `packageManager: "pnpm@11.21.0"`；
- 根 `pnpm-workspace.yaml`：
  ```yaml
  packages:
    - 'packages/*'
  allowBuilds:
    esbuild: true
  ```
- 根 devDependencies：`typescript`、`esbuild`、`@types/node`（`tsx` 不再需要：测试直接跑 `lib` 产物，note 脚本由 Node 24 执行）；另加 `"dsh-gate-agent": "workspace:*"`，让 pnpm 把包链接进根 `node_modules`，composition 才能用 `createRequire` 解析 `dsh-gate-agent/package.json`；profile 的实际解析仍由 profile 自己的 node_modules 负责；
- 根脚本：
  - `build`: `pnpm -r --if-present build`
  - `typecheck`: `pnpm -r --if-present typecheck`
  - `test`: `pnpm run build && node packages/gate/test/unit.mjs && node packages/gate/test/composition.mjs`；后续 index 拆分新增 check-split/registry 检查
  - `verify-notes` 保持现有四段校验
- 提交 `pnpm-lock.yaml`；`node_modules/`、`lib/` 不入库。

不选 npm：单包 npm 更简单，但参考项目、构建脚本和 lockfile 都已是 pnpm 约定，且本机已安装 pnpm 11.21；为了跨仓库一致性和 workspace 脚本，pnpm 的收益更大。

### 构建与源码布局

- `packages/gate/index.js` → `packages/gate/src/index.ts`
- `packages/gate/src/classify.js` → `src/classify.ts`
- `packages/gate/src/state.js` → `src/state.ts`
- 新增 `packages/gate/scripts/bundle.mjs`，用 esbuild 打一个 Node 入口：
  - `src/index.ts` → `lib/index.js`
  - `bundle: true`, `platform: 'node'`, `target: 'node24'`, `format: 'esm'`
  - `external: ['@deepseek-ai/*', 'node:*']`
  - 构建前清空 `lib/`；产物断言无相对 import
- `src/index.ts` re-export `PHASES`、`defaultState`、`normalizeState`、`loadState`、`saveState` 作为测试/维护接口；不新增 package export，避免第二个入口产生独立 state 实例。
- 新增 `packages/gate/tsconfig.json`：
  - `target: ES2023`, `module: NodeNext`, `moduleResolution: NodeNext`
  - `strict: true`, `noUncheckedIndexedAccess: true`, `noEmit: true`, `skipLibCheck: true`
  - `include: ['src/**/*.ts']`
- `packages/gate/package.json`：
  - `exports["."] = "./lib/index.js"`
  - 保留 `"./locale/*.json"`、`"./icon"`，增加 `"./package.json": "./package.json"`（供 patch 解析包根）
  - `files` 用 `lib`、`skills`、`launchers`、`cordis.patch.yml`、`README.md`、`locale/*.json`、`icon.svg`；不再包含 `src/` 或 `index.js`
  - `scripts.build` / `scripts.typecheck`；`scripts.test` 先 build 再跑 unit/composition，保证 clean clone 的包内测试可用
  - 不依赖 `prepare`/`prepack` 兜底：DSH 的绝对路径安装会记录 `link:`，pnpm 不保证执行 linked package 的 prepare；安装前显式 build 是唯一可靠机制
- `lib/` 保持 gitignored；DSH 运行的是 build 产物。

### 类型策略

- `strict: true`，目标是 `pnpm typecheck` 零错误；
- DSH 边界（`ctx`、tool `execute` 参数、session/log 形状）使用显式局部接口或 `any`，不把宿主对象硬编码成假类型；
- `src/state.ts` 定义 `Phase`、`GateState` 等真实类型；
- `src/classify.ts` 为纯函数补参数/返回类型；
- `src/index.ts` 的内部辅助函数尽量补类型；禁止整文件 `@ts-nocheck`；
- 不为通过类型检查改变运行时行为；测试是行为回归的最终证据。

### 包根与运行时路径

入口从 `index.js` 移到 `lib/index.js` 后，`import.meta.url` 指向 `lib/`：

- `PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))`
- `SKILLS = path.join(PACKAGE_ROOT, 'skills')`
- `launchers` 模板 = `path.join(PACKAGE_ROOT, 'launchers', ...)`
- `cordis.patch.yml` 的 `bundledSkillDir` 改为解析 `dsh-gate-agent/package.json` 后取 dirname，不能再用 `resolve('dsh-gate-agent')` + dirname（那会得到 `lib/`）。

### 测试与文档

- `test/unit.mjs` 的 state 导入改为从 `../lib/index.js` 取 `PHASES`/`defaultState`/`normalizeState`/`loadState`/`saveState`；`test/composition.mjs` 也从 `../lib/index.js` 导入；单入口保证测试和插件共用同一个 state 实例；
- `composition.mjs` 的 `files` 检查改为 `lib`，仍禁止仓库治理目录；保留并检查 `exports` 的 `"./locale/*.json"`、`"./icon"`、`"./package.json"`；
- 增加包根检查：用 `createRequire` 解析 `dsh-gate-agent/package.json`，确认 dirname 是包根、`skills/`/`launchers/` 存在，且 patch 字符串引用该解析方式；
- `bundle.mjs` 构建后断言无相对 import；`tsc` NodeNext 源码使用 `.js` specifier，esbuild 负责解析到 `.ts`，构建成功即证明；
- 根 `pnpm test` 先 build，测试真实产物；
- `packages/gate/README.md` 增加 `pnpm install`/`pnpm build`/`pnpm typecheck`，安装前必须 build；
- 根 README/AGENTS 中与本仓库开发命令相关的 `npm run verify-notes` 保持兼容（`npm run` 仍可执行），不把 pnpm 强加给被 gate 初始化的下游项目。

### 非目标

- 不改 gate 的 phase、commit、root-write、note lifecycle 行为；
- 不引入客户端/UI 构建；
- 不把 `@deepseek-ai/*` 打进产物（宿主 provides）；
- 不提交 `lib/`、`node_modules/`；
- 不迁移 skills 下已存在的 `.ts` 脚本（它们由 Node/项目脚本直接运行）。

## Implementation evidence

- `pnpm install`（lockfile 已生成）；`pnpm build` 生成 `packages/gate/lib/index.js`（单入口，内联 state/classify）。
- `pnpm typecheck` 在 `strict: true` + `noUncheckedIndexedAccess: true` 下零错误；没有 `@ts-nocheck`。
- `pnpm test` 与 `pnpm -C packages/gate test` 均 ALL CHECKS PASSED；`pnpm verify-notes` 13 篇通过。
- `state.ts`/`classify.ts` 已类型化；`index.ts` 的 DSH 边界（ctx/agent/tool 参数/event）保留显式 `any`，其余核心 helper（state、procedure、note path、root/git provisioning）已收紧。剩余 `any` 主要在宿主边界，不是整文件逃逸。
- `package.json` 指向 `lib`，保留 locale/icon/package.json；composition 验证 `exports`/`files`/package-root；patch 解析 `dsh-gate-agent/package.json`。
- 最终 Verify：删除 `lib/` 后 `pnpm -C packages/gate test` 重新 build 并通过；`import('dsh-gate-agent')` 返回 apply/inject/Config/state API；`git check-ignore` 确认 `lib/`、`node_modules/` 不入库。
- 残余：安装前必须 build；DSH profile 需重启；pnpm 仅开发期需要。

## Alternatives considered

1. **继续 JS + JSDoc/checkJs**：最小改动，保留现有入口。否决：用户目标是 TS 开发；JSDoc 不能提供 `tsc` 的完整类型收敛，也无法统一构建。
2. **tsc emit 到 `dist/`，不做 bundle**：保留模块边界，调试更直接。否决：DSH 原生 ESM 不补扩展名、没有跨包 node_modules；参考项目已用 esbuild 单文件产物，构建路径更稳。
3. **npm 而不是 pnpm**：单包更少工具。否决：参考项目、workspace 脚本、lockfile 都是 pnpm；本机已装同版本；迁移期保持一致。
4. **保留 `index.js` 作为薄 wrapper re-export `lib`**：兼容旧入口。否决：会造成双入口和路径歧义；package exports 指向 `lib` 后无必要，旧 profile 重启即可。
5. **先只搭工具链、源码继续 JS**：风险最低。否决：用户要 TS 开发；分两步会让类型迁移无限期延后。

## 已有 Note 审计

- 现有 Notes 没有承接构建工具链、包入口或 TypeScript 迁移的条目；本 Note 是唯一属主。
- `packages/gate/README.md` 的安装/开发命令由本 Note 更新；不改变 gate 行为合同。
- `.gitignore` 已有 `/packages/*/lib/`，与本 Note 的“构建产物不入库”一致。
- `2026-11-10-gate-dsh-native`/`repo-plugin-boundary` 只约束插件边界，不承接构建方式；不改写。

## Consequences

### Acceptance criteria

1. `pnpm install` 成功，`pnpm build` 生成 `packages/gate/lib/index.js`；`lib/` 仍被 gitignore。
2. `pnpm typecheck` 在 `strict: true` + `noUncheckedIndexedAccess: true` 下零错误；没有整文件 `@ts-nocheck`。
3. `pnpm test` 全部通过（unit + composition，导入 `lib/index.js`）；`pnpm verify-notes` 通过；`pnpm -C packages/gate test` 在 clean clone 也能先 build 再通过。
4. `packages/gate/package.json` 的 `exports`/`files` 指向 `lib`，保留 `"./locale/*.json"`、`"./icon"` 并暴露 `"./package.json"`；`cordis.patch.yml` 能从 package.json 解析包根并找到 `skills`；根 devDependency `"dsh-gate-agent": "workspace:*"` 使 composition 的 `createRequire` 解析成功。
5. `gate` 的现有行为不变：phase、commit、root-write、note lifecycle 的既有测试全绿；build 后的插件 `apply`/`inject`/`Config` 导出形状不变。
6. 安装前显式运行 `pnpm build`；安装/重启 DSH 后，link 包从 `lib/index.js` 加载；`skills`/`launchers` 路径正确。未 build 的 link/path install 明确属于失败路径，不声称 prepare 能兜底。
7. 不提交 `lib/`、`node_modules/`；提交 `pnpm-lock.yaml`、`pnpm-workspace.yaml`、tsconfig、构建脚本和 TS 源码。

### Risks

- **类型迁移量大**：`index.ts` 约 2,000 行，strict 下可能有大量隐式 any/索引访问错误。缓解：先让 `state`/`classify` 类型化，入口边界显式 `any`，用测试锁行为；不通过改逻辑消错。
- **入口迁移破坏路径**：`SKILLS`/`launchers`/patch 的 package root 解析是高风险点。缓解：集中在 `PACKAGE_ROOT`，patch 改为解析 `package.json`；做 composition 检查。
- **开发环境依赖 pnpm**：下游 DSH 运行不需要 pnpm，但本仓库开发/CI 需要。缓解：`packageManager` 固定版本，README 写明；产物无运行时依赖。
- **`lib` 必须 build 后才可加载**：`exports["."]` 指向 `lib/index.js`，未 build 的 path install/pack 会导致 Loader 无法挂载 gate。DSH 的绝对路径安装记录 `link:`，pnpm 不保证执行 linked package 的 prepare；`prepack` 只在打包时运行。因此安装步骤强制先 `pnpm build`，README 写明顺序；不把 prepare/prepack 当兜底。
- **esbuild 版本/构建脚本**：`allowBuilds: esbuild` 需要 pnpm 批准；参考项目已用同一配置。缓解：提交 pnpm-workspace 配置。
- **测试依赖构建产物**：测试前必须 build，调试源码时需重建。缓解：`pnpm test` 内置 build；可另加 `test:watch` 以后再做。
