import type { GateState } from './state.js'
import { gitSubcommands } from './classify.js'

export type WriteScope = 'none' | 'workspace'
export type ShellMode = 'read' | 'write'
export type RepoWrite = 'none' | 'push'

export interface GateAccess {
  read: boolean
  write: WriteScope
  noteWrite: boolean
  shell: ShellMode
  repoWrite: RepoWrite
}

/**
 * The only source of stage/role access. Guards, restrictions, status and
 * prompts all derive from this function.
 */
export function accessFor(state: GateState, worker: boolean): GateAccess {
  if (state.phase === 'blocked') {
    return { read: true, write: 'none', noteWrite: false, shell: 'read', repoWrite: worker ? 'none' : 'push' }
  }
  if (!worker) {
    if (state.phase === 'discuss') {
      return { read: true, write: 'none', noteWrite: false, shell: 'read', repoWrite: 'push' }
    }
    return {
      read: true,
      write: 'workspace',
      noteWrite: state.node === 'note-lifecycle',
      shell: 'write',
      repoWrite: 'push',
    }
  }
  if (state.node === 'plan' || state.node === 'plan-revise') {
    return { read: true, write: 'none', noteWrite: true, shell: 'read', repoWrite: 'none' }
  }
  if (state.node === 'implement' || state.node === 'implement-revise' || state.node === 'fix-bug') {
    return { read: true, write: 'workspace', noteWrite: false, shell: 'write', repoWrite: 'push' }
  }
  return { read: true, write: 'none', noteWrite: false, shell: 'read', repoWrite: 'none' }
}

export function accessText(access: GateAccess): string {
  return `权限：read=${access.read ? 'yes' : 'no'} write=${access.write} noteWrite=${access.noteWrite ? 'yes' : 'no'} shell=${access.shell} repoWrite=${access.repoWrite}`
}

/** Return the git write subcommands present in every shell segment. */
export function repoCommands(command: string): Set<'add' | 'commit' | 'push'> {
  const commands = new Set<'add' | 'commit' | 'push'>()
  for (const subcommand of gitSubcommands(command)) {
    if (subcommand === 'add' || subcommand === 'commit' || subcommand === 'push') commands.add(subcommand)
  }
  return commands
}

