export interface GateToolSpec {
  name: string
  summary: string
}

export const GATE_TOOLS: readonly GateToolSpec[] = [
  { name: 'gate_status', summary: '读取当前 phase/node、procedure、access 和 nextCommands；root/worker 均可调用。' },
  { name: 'gate_record', summary: '记录 worker 结果并推进 gate；仅 root 可调用。' },
  { name: 'gate_start_phase', summary: '在用户授权后进入 plan/implement；plan 基于讨论共识，implement 基于已确认计划或实施说明；仅 root 可调用。' },
  { name: 'gate_note_write', summary: 'planning worker 写 proposed Note 或原地更新 implemented Note。' },
  { name: 'gate_note_verify', summary: '在 note-lifecycle 中运行 notes 校验；root-only。' },
  { name: 'gate_note_finalize', summary: '把 proposed Note 移到 implemented 并更新头块；root-only。' },
  { name: 'gate_help', summary: '列出 gate 命令、工具和当前 phase/node；只读，root-only。' },
]
