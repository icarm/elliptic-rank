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
// rank. We also compute the GLOBAL MINIMAL MODEL invariants (c4,c6), recovered
// without knowing the bad primes — see `minimalC4C6`. These give both the
// canonical Q-isomorphism key and the naive height
// log max(|c4|^3,|c6|^2), matching the EW/LMFDB/Cremona convention.
//
// IMPORTANT: we never call ellglobalred or do an unbounded conductor search —
// that factors the discriminant and is intractable for record-scale curves. The
// conductor/Faltings data is computed only from supplied bad primes, or from a
// quick bounded trial-division pass when it happens to recover all bad primes.
// All input numbers are regex-validated and substituted into GP expressions;
// submitter strings are never evaluated as GP code.

import type { Gp } from './pari'

export interface VerifyInput {
  // Weierstrass a-invariants: [a4,a6] (short form) or [a1,a2,a3,a4,a6].
  // Each entry an integer or rational, as a string or number.
  ainvs: (string | number)[]
  // Affine points [x, y], each coordinate an integer or rational.
  points: [string | number, string | number][]
  // Optional: the primes dividing the discriminant. If supplied and valid, the
  // conductor is computed (no factoring needed) and recorded. If omitted, the
  // verifier may still fill conductor data when bounded trial division recovers
  // all bad primes quickly.
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

// Canonical representative of the Q-isomorphism class: the global minimal
// (c4,c6). `key` is the dedup identity — same key iff the same curve.
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
  // Computed only when valid primes were supplied or quick automatic recovery
  // found all bad primes; else null.
  conductor: string | null
  minimalDiscriminant: string | null
  faltingsHeight: string | null
  // Set when primes were supplied but failed validation (nothing recorded).
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

// Global-minimal-model (c4,c6) for the curve `E` already loaded in the gp
// session. Used for both the canonical key and naive height. PARI's
// minimal-model routine computes this directly and does not require the
// conductor or a list of bad primes.
function minimalC4C6(gp: Gp): Canonical {
  const vec = evalGp(gp, 'my(Em=ellminimalmodel(E)); [Em.c4, Em.c6]')
  const m = vec.match(/^\[(.+),\s*(.+)\]$/)
  if (!m) throw new Error(`unexpected minimal model form: ${vec.slice(0, 80)}`)
  const c4 = m[1].trim()
  const c6 = m[2].trim()
  return { c4, c6, key: `${c4}:${c6}` }
}

const MAX_PRIMES = 1024

// Trial-division bound for automatic bad-prime detection. Trial division to this
// bound costs at most ~25ms even on a several-hundred-digit discriminant.
const AUTO_FACTOR_BOUND = '10^7'

// Attempt to recover the complete set of bad primes for the curve `E` (already
// loaded in `gp`) by trial-dividing |disc| up to AUTO_FACTOR_BOUND. Returns the
// primes iff this fully factors the discriminant — i.e. every cofactor left
// after trial division is a (probable) prime or a perfect power of one — and
// null otherwise.
//
// This is bounded trial division, NOT factoring: it never invokes ECM/MPQS, so
// it cannot hang on a hard semiprime — it simply gives up (returns null),
// leaving the primes to be supplied manually. See the file header on why
// factoring is otherwise avoided.
function autoBadPrimes(gp: Gp): string[] | null {
  const out = evalGp(
    gp,
    `my(d=abs(E.disc), f=factor(d,${AUTO_FACTOR_BOUND}), ps=List(), ok=1, r);` +
      'for(i=1, #f~, my(b=f[i,1]);' +
      '  if(ispseudoprime(b), listput(ps,b),' +
      '     if(ispower(b,,&r) && ispseudoprime(r), listput(ps,r), ok=0)));' +
      'if(ok, Vec(ps), 0)',
  )
  if (out === '0') return null
  const inner = out.replace(/^\[|\]$/g, '').trim()
  if (inner === '') return null // |disc| = 1: no bad primes (cannot occur over Q)
  return inner.split(',').map((s) => s.trim())
}

interface Invariants {
  conductor: string | null
  minDisc: string | null
  faltings: string | null
  note: string | null
}

// Invariants of the curve `E` (already loaded in `gp`) that otherwise require
// factoring the discriminant, computed instead from a supplied list of candidate
// primes — but only if the primes are each a (BPSW) probable prime AND together
// divide the discriminant down to a unit, which proves they include every bad
// prime. No factoring is done. Per-prime Tate's algorithm (elllocalred) gives
// the conductor exponents f_p and the local minimal-model scalings u_p; with
// U = prod p^v_p(u_p):
//   conductor = prod p^f_p
//   minimal discriminant = disc / U^12
//   Faltings height = -1/2 log(area(period lattice) * U^2)   [LMFDB normalization]
function invariantsFromPrimes(gp: Gp, primes: string[]): Invariants {
  const none: Invariants = { conductor: null, minDisc: null, faltings: null, note: null }
  if (primes.length === 0) return none
  if (primes.length > MAX_PRIMES) return { ...none, note: `too many primes (max ${MAX_PRIMES})` }
  evalGp(gp, `cps = [${primes.join(',')}]`)
  // Two distinct failure modes, reported separately: a supplied value is not
  // prime, or the (prime) values are incomplete and leave an unaccounted factor
  // of the discriminant. The original combined message wrongly said primes "do
  // not divide the discriminant" even when each one did but the set was missing
  // a prime.
  const allPrime = evalGp(gp, 'my(ok=1); for(i=1,#cps, if(!ispseudoprime(cps[i]), ok=0)); ok')
  if (allPrime !== '1') {
    return { ...none, note: 'supplied values are not all prime' }
  }
  // Residual after dividing out every supplied prime; 1 iff they account for the
  // entire discriminant. Extraneous primes (not dividing the discriminant) are
  // harmless — they contribute a trivial conductor factor.
  const leftover = evalGp(gp, 'my(d=abs(E.disc)); for(i=1,#cps, while(d%cps[i]==0, d=d\\cps[i])); d')
  if (leftover !== '1') {
    const shown = leftover.length > 40 ? `${leftover.slice(0, 40)}…` : leftover
    return {
      ...none,
      note: `supplied primes are incomplete: they leave an unaccounted factor ${shown} of the discriminant`,
    }
  }
  evalGp(gp, 'lr = vector(#cps, i, elllocalred(E, cps[i]))')
  evalGp(gp, 'Umin = prod(i=1, #cps, cps[i]^valuation(lr[i][3][1], cps[i]))')
  const conductor = evalGp(gp, 'prod(i=1, #cps, cps[i]^lr[i][1])')
  const minDisc = evalGp(gp, 'E.disc / Umin^12')
  const faltings = evalGp(gp, 'my(A=abs(imag(conj(E.omega[1])*E.omega[2]))); -(1/2)*log(A*Umin^2)')
  return { conductor, minDisc, faltings, note: null }
}

// Standalone canonical dedup key for a curve, without verifying points.
export function canonicalKey(gp: Gp, ainvs: (string | number)[]): Canonical {
  const a = normalizeAinvs(ainvs)
  evalGp(gp, `E = ellinit([${a.join(',')}])`)
  if (evalGp(gp, '#E') === '0') throw new Error('singular curve (discriminant 0)')
  return minimalC4C6(gp)
}

// Standalone global-minimal-model naive height log max(|c4|^3,|c6|^2) for a
// curve, without verifying points. Same value `verify` records; useful for
// auditing/recomputing stored heights. Throws on a singular curve.
export function naiveLogHeight(gp: Gp, ainvs: (string | number)[]): string {
  const a = normalizeAinvs(ainvs)
  evalGp(gp, `E = ellinit([${a.join(',')}])`)
  if (evalGp(gp, '#E') === '0') throw new Error('singular curve (discriminant 0)')
  const m = minimalC4C6(gp)
  return evalGp(gp, `log(vecmax([abs(${m.c4})^3, (${m.c6})^2]))*1.0`)
}

// Result of backfilling the factoring-gated invariants for an already-recorded
// curve from a supplied list of bad primes.
export interface PrimesResult {
  ok: boolean
  conductor: string | null
  minimalDiscriminant: string | null
  faltingsHeight: string | null
  // Set when primes were supplied but failed validation, or input was rejected.
  note: string | null
  errors: string[]
}

// Compute the conductor, minimal discriminant, and Faltings height for an
// already-recorded curve from a supplied list of its bad primes — without
// re-verifying points and without factoring. The a-invariants come from a
// trusted stored curve; the primes are validated exactly as in `verify` (each a
// probable prime, together dividing the discriminant to a unit). `ok` is true
// iff the invariants were computed; otherwise `note`/`errors` say why not.
export function verifyPrimes(
  gp: Gp,
  ainvs: (string | number)[],
  rawPrimes: (string | number)[],
): PrimesResult {
  const out: PrimesResult = {
    ok: false,
    conductor: null,
    minimalDiscriminant: null,
    faltingsHeight: null,
    note: null,
    errors: [],
  }
  let a: [string, string, string, string, string]
  let primes: string[]
  try {
    a = normalizeAinvs(ainvs)
    primes = rawPrimes.map((p, i) => {
      const s = token(p, `prime[${i}]`)
      if (!/^\d+$/.test(s) || s === '0' || s === '1')
        throw new InputError(`prime[${i}] must be an integer > 1`)
      return s
    })
    if (primes.length === 0) throw new InputError('no primes provided')
  } catch (e) {
    out.errors.push(e instanceof Error ? e.message : String(e))
    return out
  }
  try {
    evalGp(gp, `E = ellinit([${a.join(',')}])`)
    if (evalGp(gp, '#E') === '0') {
      out.errors.push('curve is singular (discriminant 0)')
      return out
    }
    const inv = invariantsFromPrimes(gp, primes)
    out.conductor = inv.conductor
    out.minimalDiscriminant = inv.minDisc
    out.faltingsHeight = inv.faltings
    out.note = inv.note
    out.ok = inv.conductor != null
    return out
  } catch (e) {
    out.errors.push(e instanceof Error ? e.message : String(e))
    return out
  }
}

// Like `verifyPrimes`, but recovers the bad primes automatically by bounded
// trial division instead of taking them from the caller. `ok` is true iff the
// discriminant fully factored within the budget and the invariants were
// computed; otherwise `note` explains that manual entry is needed.
export function autoPrimes(gp: Gp, ainvs: (string | number)[]): PrimesResult {
  const out: PrimesResult = {
    ok: false,
    conductor: null,
    minimalDiscriminant: null,
    faltingsHeight: null,
    note: null,
    errors: [],
  }
  let a: [string, string, string, string, string]
  try {
    a = normalizeAinvs(ainvs)
  } catch (e) {
    out.errors.push(e instanceof Error ? e.message : String(e))
    return out
  }
  try {
    evalGp(gp, `E = ellinit([${a.join(',')}])`)
    if (evalGp(gp, '#E') === '0') {
      out.errors.push('curve is singular (discriminant 0)')
      return out
    }
    const primes = autoBadPrimes(gp)
    if (!primes) {
      out.note =
        'could not factor the discriminant within the quick budget — please enter the primes manually'
      return out
    }
    const inv = invariantsFromPrimes(gp, primes)
    out.conductor = inv.conductor
    out.minimalDiscriminant = inv.minDisc
    out.faltingsHeight = inv.faltings
    out.note = inv.note
    out.ok = inv.conductor != null
    return out
  } catch (e) {
    out.errors.push(e instanceof Error ? e.message : String(e))
    return out
  }
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
    minimalDiscriminant: null,
    faltingsHeight: null,
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

    // Canonical dedup key: global minimal (c4,c6), identifying the
    // Q-isomorphism class.
    result.canonical = minimalC4C6(gp)

    // Naive height log max(|c4|^3, |c6|^2) of the GLOBAL MINIMAL MODEL — the
    // convention used by EW 2004 / LMFDB / Cremona, so the value is comparable
    // to the literature records on the board. This prevents non-minimal
    // submissions from changing the recorded height. (Substituted strings are
    // PARI integer output, not submitter input.)
    const minModel = result.canonical
    result.height = {
      naiveLogHeight: evalGp(
        gp,
        `log(vecmax([abs(${minModel.c4})^3, (${minModel.c6})^2]))*1.0`,
      ),
    }

    // Conductor / minimal discriminant / Faltings height from the bad primes.
    // If none were supplied, try to recover them by bounded trial division — a
    // best-effort that completes in milliseconds and gives up (rather than
    // factoring a hard composite) when it cannot fully factor the discriminant.
    if (primes.length === 0) {
      const auto = autoBadPrimes(gp)
      if (auto) primes = auto
    }
    const inv = invariantsFromPrimes(gp, primes)
    result.conductor = inv.conductor
    result.minimalDiscriminant = inv.minDisc
    result.faltingsHeight = inv.faltings
    result.conductorNote = inv.note

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
