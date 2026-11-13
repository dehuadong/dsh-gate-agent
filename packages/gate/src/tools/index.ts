import type { GateDeps } from '../runtime/deps.js'
import { registerStartPhase } from './start-phase.js'
import { registerRecord } from './record.js'
import { registerStatus } from './status.js'
import { registerNoteTools } from './notes.js'
import { registerHelp } from './help.js'
export function registerTools(ctx: any, deps: GateDeps) { registerStartPhase(ctx, deps); registerRecord(ctx, deps); registerStatus(ctx, deps); registerNoteTools(ctx, deps); registerHelp(ctx, deps) }
