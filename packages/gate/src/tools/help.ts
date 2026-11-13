import type { GateDeps } from '../runtime/deps.js'
import { rootAgentOf, resolveGate } from '../runtime/session.js'
import { GATE_COMMANDS, commandLabel } from '../command-catalog.js'
import type { GateCommandSpec } from '../command-catalog.js'
import { GATE_TOOLS } from './catalog.js'

function commandLine(spec: GateCommandSpec): string {
  const hint = spec.hint === null ? '' : ` ${spec.hint}`
  return `- ${commandLabel(spec)}${hint} — ${spec.description}（${spec.when}）`
}

function helpText(phase: string, node: string | null): string {
  return [
    '## Gate help',
    `当前 phase/node：${phase} / ${node ?? '无'}`,
    '',
    '命令（由用户执行）：',
    ...GATE_COMMANDS.map(commandLine),
    '',
    '工具（由模型调用）：',
    ...GATE_TOOLS.map(tool => `- ${tool.name} — ${tool.summary}`),
    '',
    '命令由用户执行；工具由模型调用。命令不会作为 tool 出现在工具目录。',
  ].join('\n')
}

export function registerHelp(ctx: any, deps: GateDeps) {
  const { store } = deps
  ctx.tools.register({
    name: 'gate_help',
    description: '只读列出 gate 命令、工具用途和当前 phase/node。仅 root agent；只在不确定命令名/工具用途时使用。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: any, value: any) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }],
    },
    async execute(_args: any, exec: any) {
      const root = rootAgentOf(ctx, exec.agent)
      if (root?.id !== exec.agent?.id) return { ok: false, code: 'root-only', reason: 'gate_help 只能由 root agent 调用。' }
      const gate = resolveGate(ctx, exec.agent)
      if (gate.root === undefined) return { ok: false, code: 'state-unavailable', reason: '无法确定工作区。' }
      const state = store.read(gate.root, root)
      return {
        ok: true,
        phase: state.phase,
        node: state.node,
        current: { phase: state.phase, node: state.node },
        note: '命令由用户执行；工具由模型调用。',
        commands: GATE_COMMANDS.map(spec => ({ ...spec, command: commandLabel(spec) })),
        tools: GATE_TOOLS,
        text: helpText(state.phase, state.node),
      }
    },
  })
}
