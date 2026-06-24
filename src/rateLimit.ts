import type { Bindings } from './auth'

export const SUBMISSION_RATE_LIMIT = 6
export const SUBMISSION_RATE_PERIOD_SEC = 60

export interface RateLimitResult {
  allowed: boolean
  limit: number
  retryAfter: number
}

// Per-account submission limiter, backed by Cloudflare's native Workers Rate
// Limiting binding. It is intentionally checked before body parsing and PARI
// work.
export async function checkSubmissionRateLimit(
  env: Bindings,
  userId: number,
): Promise<RateLimitResult> {
  const { success } = await env.SUBMISSION_RATE_LIMITER.limit({
    key: `user:${userId}:submit`,
  })
  return {
    allowed: success,
    limit: SUBMISSION_RATE_LIMIT,
    retryAfter: SUBMISSION_RATE_PERIOD_SEC,
  }
}
