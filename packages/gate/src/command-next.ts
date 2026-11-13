import type { GateState } from './state.js'
import { commandLabel, commandSpec } from './command-catalog.js'

export interface GateNextCommand {
  command: string
  reason: string
}

function command(name: string, reason: string): GateNextCommand {
  const spec = commandSpec(name)
  return { command: spec === undefined ? `/${name}` : commandLabel(spec), reason }
}

export function nextCommandsFor(state: GateState): GateNextCommand[] {
  if (state.phase === 'blocked') {
    return [command('gate-resume', '解冻后回到暂停前节点；轮次耗尽时回 discuss。')]
  }
  if (state.phase === 'discuss' || state.phase === 'complete') {
    return [
      command('gate-enter-plan', '需要用户授权后进入 planning。'),
      command('gate-enter-implement', '需要用户授权后进入实施；复用已通过的 plan task，或直接从用户简述实施。'),
    ]
  }
  return []
}

export function nextCommandsText(commands: GateNextCommand[]): string {
  if (commands.length === 0) return ''
  return `下一步命令：${commands.map(item => `${item.command}（${item.reason}）`).join('；')}`
}
