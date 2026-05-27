// Core submission validator for elliptic-rank.
//
// Given an elliptic curve over Q (Weierstrass a-invariants) and a set of
// rational points claimed to be independent, this certifies a lower bound on
// the Mordell-Weil rank:
//
//   1. the curve is nonsingular (a genuine elliptic curve);
//   2. every submitted point lies on the curve (exact rational arithmetic);
//   3. the points are linearly independent in E(Q) tensor R, witnessed by the
//      Neron-Tate height-pairing Gram matrix being positive definite.
//
// (2) automatically quotients out torsion (torsion has canonical height 0), so
// independence of r points proves rank E(Q) >= r without computing the exact
// rank. We also compute the naive height log max(|c4|^3,|c6|^2) of the model.
//
// IMPORTANT: we never call ellglobalred / compute the conductor here — that
// factors the discriminant and is intractable for record-scale curves. None of
// the above needs it. All input numbers are regex-validated and substituted into
// GP expressions; submitter strings are never evaluated as GP code.

import type { Gp } from './pari'

export interface VerifyInput {
  // Weierstrass a-invariants: [a4,a6] (short form) or [a1,a2,a3,a4,a6].
  // Each entry an integer or rational, as a string or number.
  ainvs: (string | number)[]
  // Affine points [x, y], each coordinate an integer or rational.
  points: [string | number, string | number][]
  // Optional: the primes dividing the discriminant. If supplied and valid, the
  // conductor is computed (no factoring needed) and recorded.
  primes?: (string | number)[]
}

export interface PointResult {
  point: [string, string]
  onCurve: boolean
}

export interface IndependenceResult {
  independent: boolean
  rankLowerBound: number
  regulator: string
  minEigenvalue: string
  precisionDigits: number
  stable: boolean
  method: string
}

// Canonical representative of the Q-isomorphism class: the reduced (c4,c6).
// `key` is the dedup identity — same key iff the same curve.
export interface Canonical {
  c4: string
  c6: string
  key: string
}

export interface VerifyResult {
  ok: boolean
  errors: string[]
  curve: {
    ainvs: [string, string, string, string, string]
    c4: string
    c6: string
    discriminant: string
    nonsingular: boolean
  } | null
  canonical: Canonical | null
  points: PointResult[]
  allPointsOnCurve: boolean
  independence: IndependenceResult | null
  height: { naiveLogHeight: string } | null
  // Conductor, computed only when valid primes were supplied; else null.
  conductor: string | null
  // Set when primes were supplied but failed validation (conductor not recorded).
  conductorNote: string | null
}

// Integer or rational literal, e.g. "12", "-3", "800843008889340065933/16".
const NUM_RE = /^[+-]?\d+(?:\/\d+)?$/
const MAX_TOKEN_LEN = 8000
const MAX_POINTS = 64
// Eigenvalue threshold separating "independent" (height pairing positive
// definite) from numerically-zero (dependent). Independent point sets give a
// smallest eigenvalue far above this; dependent sets give ~10^-precision.
const EIGEN_MARGIN = '1e-9'

class InputError extends Error {}

// Validate a single integer/rational token and return its canonical string.
function token(raw: string | number, label: string): string {
  const s = String(raw).trim()
  if (s.length === 0 || s.length > MAX_TOKEN_LEN) throw new InputError(`${label}: bad length`)
  if (!NUM_RE.test(s)) throw new InputError(`${label}: not an integer/rational: ${s.slice(0, 40)}`)
  if (/\/0+$/.test(s)) throw new InputError(`${label}: zero denominator`)
  return s
}

// Evaluate a GP expression, strip the "%n = " echo, and surface PARI errors.
function evalGp(gp: Gp, cmd: string): string {
  const raw = gp(cmd)
  const out = raw.replace(/^%\d+\s*=\s*/, '').trim()
  if (/\*\*\*|error|incorrect|impossible|domain/i.test(raw)) {
    throw new Error(`PARI: ${out.slice(0, 160)}`)
  }
  return out
}

// Parse a PARI real ("1.5329 E-17", "3857298234011609", "-0.15") to a JS number.
function pariFloat(s: string): number {
  return Number(s.replace(/\s+/g, '').replace(/E/i, 'e'))
}

function normalizeAinvs(ainvs: (string | number)[]): [string, string, string, string, string] {
  const t = ainvs.map((a, i) => token(a, `a-invariant[${i}]`))
  if (t.length === 2) return ['0', '0', '0', t[0], t[1]]
  if (t.length === 5) return [t[0], t[1], t[2], t[3], t[4]]
  throw new InputError('ainvs must have length 2 ([a4,a6]) or 5 ([a1,a2,a3,a4,a6])')
}

// Canonical (c4,c6) for the curve `E` already loaded in the gp session.
//
// Two curves over Q are isomorphic iff (c4,c6) = (u^4 c4', u^6 c6') for some
// u in Q*. We reduce to the orbit representative by dividing out the largest u
// (built from small primes) with u^4|c4 and u^6|c6. This is trial division, not
// factoring: it can't hang, and it is complete in practice — minimal models give
// u=1, non-minimal submissions scale by a small u, and any large prime in
// gcd(c4,c6) necessarily has exponent 0 in u so is correctly left untouched.
function reduceC4C6(gp: Gp): Canonical {
  const vec = evalGp(
    gp,
    'my(c4=E.c4,c6=E.c6); forprime(p=2,100000, while(c4%p^4==0 && c6%p^6==0, c4=c4/p^4; c6=c6/p^6)); [c4,c6]',
  )
  const m = vec.match(/^\[(.+),\s*(.+)\]$/)
  if (!m) throw new Error(`unexpected canonical form: ${vec.slice(0, 80)}`)
  const c4 = m[1].trim()
  const c6 = m[2].trim()
  return { c4, c6, key: `${c4}:${c6}` }
}

const MAX_PRIMES = 1024

// Conductor of the curve `E` already loaded in `gp`, from a supplied list of
// candidate primes. Returns the conductor only if the primes are each a
// (BPSW) probable prime AND collectively divide the discriminant down to a unit
// — which proves they include every bad prime, so the conductor is exact. No
// factoring is done; per-prime exponents come from Tate's algorithm
// (elllocalred). Good-reduction primes contribute exponent 0.
function conductorFromPrimes(gp: Gp, primes: string[]): { conductor: string | null; note: string | null } {
  if (primes.length === 0) return { conductor: null, note: null }
  if (primes.length > MAX_PRIMES) return { conductor: null, note: `too many primes (max ${MAX_PRIMES})` }
  evalGp(gp, `cps = [${primes.join(',')}]`)
  const ok = evalGp(
    gp,
    'my(d=abs(E.disc), ok=1);' +
      'for(i=1,#cps, if(!ispseudoprime(cps[i]), ok=0));' +
      'if(ok, for(i=1,#cps, while(d%cps[i]==0, d=d\\cps[i])); if(d!=1, ok=0)); ok',
  )
  if (ok !== '1') {
    return { conductor: null, note: 'supplied primes are not all prime, or do not divide the discriminant' }
  }
  const conductor = evalGp(gp, 'prod(i=1,#cps, cps[i]^elllocalred(E, cps[i])[1])')
  return { conductor, note: null }
}

// Standalone canonical dedup key for a curve, without verifying points.
export function canonicalKey(gp: Gp, ainvs: (string | number)[]): Canonical {
  const a = normalizeAinvs(ainvs)
  evalGp(gp, `E = ellinit([${a.join(',')}])`)
  if (evalGp(gp, '#E') === '0') throw new Error('singular curve (discriminant 0)')
  return reduceC4C6(gp)
}

export function verify(gp: Gp, input: VerifyInput): VerifyResult {
  const result: VerifyResult = {
    ok: false,
    errors: [],
    curve: null,
    canonical: null,
    points: [],
    allPointsOnCurve: false,
    independence: null,
    height: null,
    conductor: null,
    conductorNote: null,
  }

  // --- 1. Parse & validate input (no GP evaluation of raw strings) ---
  let ainvs: [string, string, string, string, string]
  let pts: [string, string][]
  let primes: string[]
  try {
    ainvs = normalizeAinvs(input.ainvs ?? [])
    const rawPts = input.points ?? []
    if (!Array.isArray(rawPts) || rawPts.length === 0) throw new InputError('no points provided')
    if (rawPts.length > MAX_POINTS) throw new InputError(`too many points (max ${MAX_POINTS})`)
    pts = rawPts.map((p, i) => {
      if (!Array.isArray(p) || p.length !== 2) throw new InputError(`point[${i}] must be [x,y]`)
      return [token(p[0], `point[${i}].x`), token(p[1], `point[${i}].y`)] as [string, string]
    })
    primes = (input.primes ?? []).map((p, i) => {
      const s = token(p, `prime[${i}]`)
      if (!/^\d+$/.test(s) || s === '0' || s === '1') throw new InputError(`prime[${i}] must be an integer > 1`)
      return s
    })
  } catch (e) {
    result.errors.push(e instanceof Error ? e.message : String(e))
    return result
  }

  try {
    // --- 2. Build the curve and check it is nonsingular ---
    evalGp(gp, `E = ellinit([${ainvs.join(',')}])`)
    // ellinit returns the empty vector [] for a singular curve.
    const nonsingular = evalGp(gp, '#E') !== '0'
    const c4 = nonsingular ? evalGp(gp, 'E.c4') : '0'
    const c6 = nonsingular ? evalGp(gp, 'E.c6') : '0'
    const disc = nonsingular ? evalGp(gp, 'E.disc') : '0'
    result.curve = { ainvs, c4, c6, discriminant: disc, nonsingular }
    if (!nonsingular) {
      result.errors.push('curve is singular (discriminant 0): not an elliptic curve')
      return result
    }

    // Canonical dedup key: reduced (c4,c6), identifying the Q-isomorphism class.
    result.canonical = reduceC4C6(gp)

    // Naive height log max(|c4|^3, |c6|^2) — cheap, no factoring.
    result.height = {
      naiveLogHeight: evalGp(gp, 'log(vecmax([abs(E.c4)^3, E.c6^2]))*1.0'),
    }

    // Conductor from supplied primes (optional; no factoring).
    const cond = conductorFromPrimes(gp, primes)
    result.conductor = cond.conductor
    result.conductorNote = cond.note

    // --- 3. Check every point lies on the curve (exact) ---
    result.points = pts.map((p) => ({
      point: p,
      onCurve: evalGp(gp, `ellisoncurve(E, [${p[0]},${p[1]}])`) === '1',
    }))
    result.allPointsOnCurve = result.points.every((p) => p.onCurve)
    if (!result.allPointsOnCurve) {
      result.errors.push('not all points lie on the curve')
      return result
    }

    // --- 4. Independence via the Neron-Tate height-pairing regulator ---
    const n = pts.length
    const prec = Math.min(250, Math.max(38, 38 + 2 * n))
    const ptsGp = '[' + pts.map((p) => `[${p[0]},${p[1]}]`).join(',') + ']'
    evalGp(gp, `\\p ${prec}`)
    evalGp(gp, `pts = ${ptsGp}`)
    evalGp(gp, 'M = ellheightmatrix(E, pts)')
    const regulator = evalGp(gp, 'matdet(M)')
    // Smallest eigenvalue of the (symmetric, positive-semidefinite) Gram matrix.
    const minEig = evalGp(gp, 'vecmin(qfjacobi(M)[1])')
    // Numerical rank = number of eigenvalues clearly above the margin.
    const numRank = Number(evalGp(gp, `#select(x -> (x > ${EIGEN_MARGIN}), qfjacobi(M)[1])`))

    // Stability check: recompute the regulator at higher precision; a genuine
    // (precision-independent) positive value should barely move.
    evalGp(gp, `\\p ${prec + 25}`)
    const regulator2 = evalGp(gp, 'matdet(ellheightmatrix(E, pts))')
    const r1 = pariFloat(regulator)
    const r2 = pariFloat(regulator2)
    const stable = r1 > 0 && Math.abs(r1 - r2) <= 1e-6 * Math.abs(r1)

    const independent = pariFloat(minEig) > pariFloat(EIGEN_MARGIN) && stable
    result.independence = {
      independent,
      rankLowerBound: independent ? n : numRank,
      regulator,
      minEigenvalue: minEig,
      precisionDigits: prec,
      stable,
      method:
        `positive-definite Neron-Tate height pairing: min eigenvalue ${minEig} > ${EIGEN_MARGIN}, ` +
        `computed at ${prec} digits and stability-checked at ${prec + 25} digits`,
    }
    if (!independent) {
      result.errors.push(
        `points are not certified independent (only ${numRank} of ${n} independent)`,
      )
      return result
    }

    result.ok = true
    return result
  } catch (e) {
    result.errors.push(e instanceof Error ? e.message : String(e))
    return result
  }
}
