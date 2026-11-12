# Agent Note: gate_record 错误返回必须是 lossless JSON

Status: implemented

工作项：修复 `gate_record` 在缺少 `node` 时返回 `got: undefined`，被 DSH lossless JSON 校验替换为 `value is not lossless JSON`、从而掩盖真正 `wrong-node` 错误的问题。

## Problem

在实测会话 `session-f1ec6bcd-6a98-4816-8ecb-e30ade86be17` 中，模型在 `plan-review` 连续调用 `gate_record` 时漏传了 `node`。`gate_record` 的 wrong-node 分支返回 `{ ..., got: args.node, ... }`；`args.node` 为 `undefined`。DSH 的 tool pipeline 用 `snapshotJsonValue` 校验工具输出（[pipeline.ts:629-633](../../../../deepseek-harness/packages/core/tools/src/pipeline.ts#L629-L633)），`undefined` 被拒绝，于是真正的错误被替换成 `Error: tool "gate_record" returned invalid output: value is not lossless JSON`。

状态没有变化，因为 wrong-node 检查发生在任何 `store.write` 之前；但模型看不到“当前节点是 plan-review，不是未提供”，只能反复修改 `findings`/`reviewAxes` 形状，最终把会话阻断在 plan-review。同一类问题还存在于 `gate_start_phase`：`execute({})` 在 discuss 会先把 phase 写成 orchestrating，再返回 `ok:true` 和 `node: undefined`，既污染状态，也产生 non-lossless 输出。

## Decision

- `gate_record` 的 wrong-node 返回（docs 分支与主分支）使用 JSON-safe 值：`expected: state.node ?? null`（docs 为 `'docs'`），`got: args.node ?? null`；`reason` 用 `args.node ?? '未提供'`，不再输出 `undefined`（[index.js:1386](../../../../packages/gate/index.js#L1386)，[index.js:1394](../../../../packages/gate/index.js#L1394)）。
- `gate_start_phase` 在 root-only 检查之后、读取/写入状态之前校验 `node` 只允许 `plan`/`implement`；否则返回 `{ok:false, code:'invalid-node', reason}`，不改变状态（[index.js:1299](../../../../packages/gate/index.js#L1299)）。
- 新增回归测试：plan-review 缺 `node`、docs 缺 `node`、`gate_start_phase` 缺 `node`；测试带一个按 `snapshotJsonValue` 规则实现的 lossless 检查（[unit.mjs](../../../../packages/gate/test/unit.mjs)）。
- 正常路径、prompt/cache 行为和其他工具契约不变；节点仍然必须显式传入。

## Testing

- 3 个新增回归测试在修复前失败、修复后通过；`gate_start_phase` 的测试同时断言状态仍为 discuss/null。
- 用 DSH 的 `snapshotJsonValue` 对三个错误返回复核，均 `lossless=true`，`got:null`。
- `node --check packages/gate/index.js`、`node --check packages/gate/test/unit.mjs`、`npm test`（完整权限，`ALL CHECKS PASSED`）、`npm run verify-notes` 通过。
- 工作区沙箱下 notes 校验的嵌套 Node spawn 会 EPERM，这是环境限制而非修复回归；完整权限下通过。

## Alternatives considered

**从 `state.node` 推断缺失的 node。** 最强理由是让模型少传一个参数、减少一次错误往返；但 `gate_record` 的 node 是推进契约的一部分，推断会把“记录哪个节点”变成隐式行为，也无法发现模型在错误节点上的记录，故不采用。

**在工具输出外面包一层 sanitizer，过滤所有 undefined。** 最强理由是一次性覆盖所有工具；但 DSH 已有 lossless JSON 边界，插件应在源头返回合法值，包一层会掩盖其他输出缺陷并扩大改动面，故只修选定的错误返回。

**只改测试或文档，不改错误返回。** 最强理由是改动最小；但真正的问题是错误被框架替换，模型无法恢复，必须修输出。

## Consequences

错误路径现在返回可行动的 `wrong-node`/`invalid-node`，模型能看到当前节点并补上 node；不会再出现被 lossless JSON 掩盖的错误。代价是多了一个 execute-level 的 node 守卫和三个测试；其他工具的错误返回未逐一审计，仍可能存在同类 `undefined` 风险。此前 P0 记录已补过 `gate_record` 的关键失败码（[P0 note](./2026-11-10-gate-p0-correctness.md)），本次是该错误输出契约的后续修正。
