export const MECHANICAL_DECISION = 'mechanical' as const

export const NOTE_DECISIONS = ['new', 'update', 'in-place', MECHANICAL_DECISION] as const
export type NoteDecision = (typeof NOTE_DECISIONS)[number]

export function isNoteDecision(value: unknown): value is NoteDecision {
  return typeof value === 'string' && (NOTE_DECISIONS as readonly string[]).includes(value)
}

export const NOTE_DECISION_LIFECYCLE: Record<NoteDecision, 'proposed' | 'implemented' | null> = {
  new: 'proposed',
  update: 'proposed',
  'in-place': 'implemented',
  mechanical: null,
}

export function isMechanicalDecision(value: unknown): boolean {
  return value === MECHANICAL_DECISION
}
