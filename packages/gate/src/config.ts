export const DEFAULT_REVIEW_LIMIT = 5
export const SCHEMASTERY = Symbol.for('schemastery')

/** Deployment-level knobs for this plugin installation. */
export const Config = {
  [SCHEMASTERY]: true,
  type: 'object',
  meta: { default: {} },
  dict: {
    reviewLimit: {
      [SCHEMASTERY]: true,
      type: 'number',
      meta: { default: DEFAULT_REVIEW_LIMIT, min: 1, max: 20, step: 1 },
    },
  },
  '~standard': {
    version: 1,
    vendor: 'dsh-gate-agent',
    validate(value: any) {
      if (value === undefined || value === null) return { value: {} }
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: 'gate config must be an object' }] }
      }
      const unknown = Object.keys(value).filter(key => key !== 'reviewLimit')
      if (unknown.length > 0) {
        return { issues: [{ message: `unknown gate config keys: ${unknown.join(', ')}` }] }
      }
      const out: { reviewLimit?: number } = {}
      if (value.reviewLimit !== undefined) {
        if (!Number.isInteger(value.reviewLimit) || value.reviewLimit < 1 || value.reviewLimit > 20) {
          return { issues: [{ message: 'reviewLimit must be an integer from 1 to 20' }] }
        }
        out.reviewLimit = value.reviewLimit
      }
      return { value: out }
    },
  },
}
