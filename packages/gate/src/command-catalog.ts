export interface GateCommandSpec {
  name: string
  description: string
  hint: string | null
  when: string
}

export const GATE_COMMANDS: readonly GateCommandSpec[] = [
  { name: 'gate-init', description: '初始化 notes、AGENTS.md、verify-notes、CI、git 与基础 .gitignore', hint: null, when: 'any' },
  { name: 'gate-enter-plan', description: '基于讨论共识、既有决策与用户需求进入 planning', hint: '<具体工作事项或上下文语义>', when: 'discuss/complete' },
  { name: 'gate-enter-implement', description: '基于已确认计划或讨论后的实施说明进入 implementation', hint: '<具体工作事项或上下文语义>', when: 'discuss/complete' },
  { name: 'gate-fix-bug', description: '为已授权缺陷派发 fix worker，基于描述或当前上下文修复', hint: '<具体工作事项或上下文语义>', when: 'discuss/complete' },
  { name: 'gate-docs', description: '进入文档治理，按项目文档规范处理', hint: null, when: 'discuss/complete' },
  { name: 'gate-implement-review', description: '对当前改动做独立只读 code review', hint: '<具体工作事项或上下文语义>', when: 'discuss/complete' },
  { name: 'gate-code-verify', description: '对当前改动做独立只读验收（gate-user-verify）', hint: '<具体工作事项或上下文语义>', when: 'discuss/complete' },
  { name: 'gate-propose-review', description: '对提案做独立只读三轴评审', hint: '<具体工作事项或上下文语义>', when: 'discuss/complete' },
  { name: 'gate-block', description: '手动暂停：保留当前节点并停止写入/派 worker；对话仍可继续', hint: '[原因]', when: 'any' },
  { name: 'gate-resume', description: '解冻 blocked：回到 block 前的节点；轮次耗尽回 discuss', hint: null, when: 'blocked' },
  { name: 'gate-return-discuss', description: '放弃当前节点，回到 discuss', hint: null, when: 'non-blocked' },
  { name: 'gate-status', description: '查看当前 phase/node、procedure、access 与下一步命令', hint: null, when: 'any' },
  { name: 'gate-note-verify', description: '只读检查 notes tree/format/lifecycle/archived', hint: null, when: 'any' },
  { name: 'gate-note-archive', description: '将 implemented Note 归档到 archived/：加 Archived、移动、封印并报告入站链接', hint: '<implemented-note> [--superseded-by <new-note>]', when: 'any' },
  { name: 'gate-note-board', description: '生成决策看板 board.html（轻量模式，连接本地 notes 目录）', hint: '[输出路径] [标题]', when: 'any' },
  { name: 'gate-note-seal', description: '只给 archived/ 中已有 Note 补写 manifest.json 的 SHA-256 封印；不归档、不改 Note 内容', hint: null, when: 'any' },
]

export function commandSpec(name: string): GateCommandSpec | undefined {
  return GATE_COMMANDS.find(command => command.name === name)
}

export function commandLabel(spec: GateCommandSpec): string {
  return `/${spec.name}`
}
