import type { GateState } from '../state.js'
import type { StateRuntime } from './store.js'
export interface GateDeps { ctx: any; store: StateRuntime; reviewLimit: number; wake: (invocation: any, state: GateState, text: string, command: string) => void }
