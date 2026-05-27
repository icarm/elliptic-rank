// GitHub OAuth login, sessions in KV, and API tokens — modeled on eq677, ported
// to TypeScript. Difference: the session token is sha256-hashed before use as
// the KV key, so a dump of the KV store does not reveal usable session cookies.
// (API tokens are likewise stored only as sha256 hashes in D1.)

import type { Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { User } from './pages'

export interface Bindings {
  DB: D1Database
  SESSIONS: KVNamespace
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
}
export type AppEnv = { Bindings: Bindings; Variables: { user: User | null } }
type Ctx = Context<AppEnv>

export const TOKEN_PREFIX = 'erank_'
const TOKEN_RANDOM_BYTES = 20 // 40 hex chars → 160 bits

const SESSION_COOKIE = 'session'
const STATE_COOKIE = 'oauth_state'
const SESSION_TTL_SEC = 30 * 24 * 60 * 60 // 30 days
const STATE_TTL_SEC = 10 * 60

type SecretEnvKey = 'GITHUB_CLIENT_ID' | 'GITHUB_CLIENT_SECRET'

interface Provider {
  authorize: string
  token: string
  userInfo: string
  scope: string
  clientIdEnv: SecretEnvKey
  clientSecretEnv: SecretEnvKey
  mapUser: (info: any, accessToken: string) => Promise<{
    provider_user_id: string
    email: string | null
    display_name: string | null
    avatar_url: string | null
  }>
}

const PROVIDERS: Record<string, Provider> = {
  github: {
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    userInfo: 'https://api.github.com/user',
    scope: 'read:user user:email',
    clientIdEnv: 'GITHUB_CLIENT_ID',
    clientSecretEnv: 'GITHUB_CLIENT_SECRET',
    mapUser: async (info, accessToken) => ({
      provider_user_id: String(info.id),
      email: info.email || (await githubPrimaryEmail(accessToken)),
      display_name: info.name || info.login || null,
      avatar_url: info.avatar_url || null,
    }),
  },
}

// /user only returns `email` when public; otherwise fetch the primary verified
// address (granted by the user:email scope).
async function githubPrimaryEmail(accessToken: string): Promise<string | null> {
  try {
    const r = await fetch('https://api.github.com/user/emails', {
      headers: {
        authorization: `Bearer ${accessToken}`,
        'user-agent': 'elliptic-rank',
        accept: 'application/json',
      },
    })
    if (!r.ok) return null
    const emails = await r.json()
    if (!Array.isArray(emails)) return null
    const primary =
      emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified) || null
    return primary ? primary.email : null
  } catch {
    return null
  }
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes)
  crypto.getRandomValues(a)
  let s = ''
  for (const b of a) s += b.toString(16).padStart(2, '0')
  return s
}

function originOf(req: Request): string {
  const u = new URL(req.url)
  return `${u.protocol}//${u.host}`
}

function isHttps(req: Request): boolean {
  return req.url.startsWith('https://')
}

// KV key for a session: hash the cookie token so the store holds no usable token.
async function sessionKey(token: string): Promise<string> {
  return `session:${await sha256Hex(token)}`
}

export async function loadCurrentUser(c: Ctx): Promise<User | null> {
  const token = getCookie(c, SESSION_COOKIE)
  if (!token) return null
  return ((await c.env.SESSIONS.get(await sessionKey(token), 'json')) as User | null) || null
}

export async function startOAuth(c: Ctx): Promise<Response> {
  const providerName = c.req.param('provider') ?? ''
  const provider = PROVIDERS[providerName]
  if (!provider) return c.notFound()
  const clientId = c.env[provider.clientIdEnv]
  if (!clientId) return c.json({ error: `${providerName} OAuth not configured` }, 503)
  const state = randomHex(16)
  setCookie(c, STATE_COOKIE, state, {
    httpOnly: true,
    secure: isHttps(c.req.raw),
    sameSite: 'Lax',
    maxAge: STATE_TTL_SEC,
    path: '/',
  })
  const redirectUri = `${originOf(c.req.raw)}/auth/${providerName}/callback`
  const authUrl = new URL(provider.authorize)
  authUrl.searchParams.set('client_id', clientId)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('scope', provider.scope)
  authUrl.searchParams.set('state', state)
  return c.redirect(authUrl.toString(), 302)
}

export async function handleCallback(c: Ctx): Promise<Response> {
  const providerName = c.req.param('provider') ?? ''
  const provider = PROVIDERS[providerName]
  if (!provider) return c.notFound()
  const error = c.req.query('error')
  const code = c.req.query('code')
  const stateParam = c.req.query('state')
  const stateCookie = getCookie(c, STATE_COOKIE)
  deleteCookie(c, STATE_COOKIE, { path: '/' })
  if (error || !code) return c.redirect('/', 302)
  if (!stateParam || !stateCookie || stateParam !== stateCookie) return c.redirect('/', 302)

  const clientId = c.env[provider.clientIdEnv]
  const clientSecret = c.env[provider.clientSecretEnv]
  if (!clientId || !clientSecret) {
    return c.json({ error: `${providerName} OAuth not configured` }, 503)
  }
  const redirectUri = `${originOf(c.req.raw)}/auth/${providerName}/callback`
  const tokenResp = await fetch(provider.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  })
  if (!tokenResp.ok) {
    return c.json({ error: 'token exchange failed', detail: await tokenResp.text() }, 502)
  }
  const tokenData = (await tokenResp.json()) as { access_token?: string }
  if (!tokenData.access_token) return c.json({ error: 'no access token in token response' }, 502)

  const userResp = await fetch(provider.userInfo, {
    headers: {
      authorization: `Bearer ${tokenData.access_token}`,
      'user-agent': 'elliptic-rank',
      accept: 'application/json',
    },
  })
  if (!userResp.ok) {
    return c.json({ error: 'user info fetch failed', detail: await userResp.text() }, 502)
  }
  const info = await userResp.json()
  const mapped = await provider.mapUser(info, tokenData.access_token)
  if (!mapped.provider_user_id) return c.json({ error: 'provider returned no user id' }, 502)

  const existing = await c.env.DB.prepare(
    'SELECT id FROM users WHERE provider = ? AND provider_user_id = ?',
  )
    .bind(providerName, mapped.provider_user_id)
    .first<{ id: number }>()
  let userId: number
  if (existing) {
    userId = existing.id
    // Refresh provider-sourced fields but preserve a user-customized display_name.
    await c.env.DB.prepare(
      'UPDATE users SET email = ?, avatar_url = ?, last_login_at = CURRENT_TIMESTAMP WHERE id = ?',
    )
      .bind(mapped.email, mapped.avatar_url, userId)
      .run()
  } else {
    const ins = await c.env.DB.prepare(
      `INSERT INTO users (provider, provider_user_id, email, display_name, avatar_url, last_login_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    )
      .bind(providerName, mapped.provider_user_id, mapped.email, mapped.display_name, mapped.avatar_url)
      .run()
    userId = ins.meta.last_row_id as number
  }

  const fresh = await c.env.DB.prepare(
    'SELECT id, display_name, email, avatar_url FROM users WHERE id = ?',
  )
    .bind(userId)
    .first<{ id: number; display_name: string | null; email: string | null; avatar_url: string | null }>()
  const sessionUser: User = {
    id: fresh!.id,
    provider: providerName,
    email: fresh!.email,
    display_name: fresh!.display_name,
    avatar_url: fresh!.avatar_url,
  }
  const sessionToken = randomHex(32)
  await c.env.SESSIONS.put(await sessionKey(sessionToken), JSON.stringify(sessionUser), {
    expirationTtl: SESSION_TTL_SEC,
  })
  setCookie(c, SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    secure: isHttps(c.req.raw),
    sameSite: 'Lax',
    maxAge: SESSION_TTL_SEC,
    path: '/',
  })
  return c.redirect('/', 302)
}

export async function updateSessionUser(c: Ctx, partial: Partial<User>): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE)
  if (!token) return
  const key = await sessionKey(token)
  const existing = (await c.env.SESSIONS.get(key, 'json')) as User | null
  if (!existing) return
  await c.env.SESSIONS.put(key, JSON.stringify({ ...existing, ...partial }), {
    expirationTtl: SESSION_TTL_SEC,
  })
}

// Resolve a user from an `Authorization: Bearer <token>` header (API access).
export async function loadUserFromToken(c: Ctx): Promise<User | null> {
  const auth = c.req.header('authorization') || ''
  const m = auth.match(/^Bearer\s+(\S+)$/i)
  if (!m) return null
  const token = m[1]
  if (!token.startsWith(TOKEN_PREFIX)) return null
  const tokenHash = await sha256Hex(token)
  const row = await c.env.DB.prepare(
    `SELECT u.id, u.provider, u.email, u.display_name, u.avatar_url, t.id AS token_id
       FROM api_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
  )
    .bind(tokenHash)
    .first<User & { token_id: number }>()
  if (!row) return null
  const tokenId = row.token_id
  delete (row as Partial<typeof row>).token_id
  c.executionCtx?.waitUntil(
    c.env.DB.prepare('UPDATE api_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(tokenId)
      .run(),
  )
  return row
}

export async function generateApiToken(
  env: Bindings,
  userId: number,
  name: string | null,
): Promise<{ id: number; token: string; prefix: string }> {
  const token = `${TOKEN_PREFIX}${randomHex(TOKEN_RANDOM_BYTES)}`
  const tokenHash = await sha256Hex(token)
  const prefix = token.slice(0, TOKEN_PREFIX.length + 8) // e.g. 'erank_abcdef12'
  const ins = await env.DB.prepare(
    'INSERT INTO api_tokens (user_id, name, token_hash, prefix) VALUES (?, ?, ?, ?)',
  )
    .bind(userId, name, tokenHash, prefix)
    .run()
  return { id: ins.meta.last_row_id as number, token, prefix }
}

export async function logout(c: Ctx): Promise<Response> {
  const token = getCookie(c, SESSION_COOKIE)
  if (token) {
    await c.env.SESSIONS.delete(await sessionKey(token))
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
  }
  return c.redirect('/', 302)
}
