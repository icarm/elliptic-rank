// Core submission validator for elliptic-rank.
//
// Given an elliptic curve over Q (Weierstrass a-invariants) and a set of
// rational points claimed to be independent, this certifies a lower bound on
// the Mordell-Weil rank:
//
//   1. the curve is nonsingular (a genuine elliptic curve);
//   2. every submitted point lies on the curve (exact rational arithmetic);
//   3. the points are linearly independent modulo torsion, certified EXACTLY by
//      the 2-descent quadratic-character method of Cremona's "On the
//      computation of Mordell-Weil and 2-Selmer groups of elliptic curves"
//      (https://johncremona.github.io/papers/filter.pdf, section 2; the method
//      goes back to Brumer). See `GP_CERT` below for the algorithm and why it
//      is a rigorous certificate. No floating-point arithmetic is involved in
//      the accept/reject decision; the Neron-Tate regulator is still computed,
//      but only as an informational (stored/displayed) diagnostic.
//
// Independence of r points modulo torsion proves rank E(Q) >= r without
// computing the exact rank. We also compute the GLOBAL MINIMAL MODEL invariants (c4,c6), recovered
// without knowing the primes of bad reduction — see `minimalC4C6`. These give both the
// canonical Q-isomorphism key and the naive height
// log max(|c4|^3,|c6|^2), matching the EW/LMFDB/Cremona convention.
//
// IMPORTANT: we never call ellglobalred or do an unbounded conductor search —
// that factors the discriminant and is intractable for record-scale curves. The
// conductor/Faltings data is computed only from supplied primes of bad
// reduction, or from a quick bounded trial-division pass when it happens to
// recover all such primes.
// All input numbers are regex-validated and substituted into GP expressions;
// submitter strings are never evaluated as GP code.
// Accepted submissions are returned in the global minimal model: points are
// transported through PARI's minimal-model change of variables before storage.

import type { Gp } from './pari'

type Ainvs = [string, string, string, string, string]
type Point = [string, string]

export interface VerifyInput {
  // Weierstrass a-invariants: [a4,a6] (short form) or [a1,a2,a3,a4,a6].
  // Each entry an integer or rational, as a string or number.
  ainvs: (string | number)[]
  // Affine points [x, y], each coordinate an integer or rational.
  points: [string | number, string | number][]
  // Optional: the primes of bad reduction. If supplied and valid, the
  // conductor is computed (no factoring needed) and recorded. If omitted, the
  // verifier may still fill conductor data when bounded trial division recovers
  // all primes of bad reduction quickly.
  primes?: (string | number)[]
}

export interface PointResult {
  point: Point
  onCurve: boolean
}

// The exact proof data behind an accepted rank bound: quadratic-character
// images of the points (and torsion generators) at `primes` form an F_2 matrix
// of rank `matrixRank` whose torsion rows have rank `torsionRank`;
// matrixRank - torsionRank = #points certifies independence modulo torsion.
export interface IndependenceCertificate {
  primes: string[]
  matrixRank: number
  torsionRank: number
  // Point replacements P -> R with 2R = P + torsion performed before the
  // matrix reached full rank (0 for a typical submission). Halving preserves
  // the rank of the span, so the certificate applies to the submitted points.
  halvings: number
  // Torsion subgroup structure of the curve, e.g. "[]" (trivial) or "[2, 2]".
  torsion: string
}

export interface IndependenceResult {
  independent: boolean
  rankLowerBound: number
  // Exact certificate proving the bound; null when independence could not be
  // certified (rankLowerBound is then the certified partial bound).
  certificate: IndependenceCertificate | null
  // Informational: the Neron-Tate height-pairing determinant of the submitted
  // points (approximate; not part of the proof) and the digits it was
  // computed at.
  regulator: string
  precisionDigits: number
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
    ainvs: Ainvs
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
  // Conductor is the one prime-gated invariant: computed only when valid primes
  // were supplied or quick automatic recovery found all primes of bad reduction.
  conductor: string | null
  // The verified primes of bad reduction (sorted ascending), present iff the
  // conductor is: the supplied/recovered primes minus any extraneous good ones.
  badPrimes: string[] | null
  // Stable Faltings height of the global minimal model — computed from its period
  // lattice alone (no primes needed), so always present for a verified curve.
  faltingsHeight: string | null
  // Torsion subgroup structure — invariant factors as a JSON array string,
  // e.g. "[]" (trivial), "[2,2]", "[12]". Intrinsic to the Q-isomorphism class;
  // computed exactly by elltors during certification (the certificate needs it),
  // so present whenever the certificate stage ran.
  torsion: string | null
  // Set when primes were supplied but failed validation (conductor not recorded).
  conductorNote: string | null
}

// Integer or rational literal, e.g. "12", "-3", "800843008889340065933/16".
const NUM_RE = /^[+-]?\d+(?:\/\d+)?$/
const MAX_NUMERIC_PART_DIGITS = 512
const MAX_POINTS = 64
// Cap on point replacements (P -> R with 2R = P + torsion) while searching for
// a certifiable working set. Each halving divides a canonical height by ~4;
// legitimate submissions need 0, and even a point submitted as 2^40*G is
// beyond the coordinate size limits, so hitting the cap means "reject".
const MAX_HALVINGS = 40

// --- Exact independence certificate ---------------------------------------
//
// GP implementation of the independence-proving algorithm of Cremona,
// "On the computation of Mordell-Weil and 2-Selmer groups of elliptic curves"
// (filter.pdf, section 2), attributed to Brumer; also Silverman's xedni paper,
// appendix D. All arithmetic is exact (integers mod p and rational points).
//
// Setting: F is an integral short Weierstrass model y^2 = f(x) = x^3 + Ax + B
// (we use [0,0,0,-27c4,-54c6] of the global minimal model). For a good prime
// p (p not dividing 6*disc, so p > 3, good reduction, f separable mod p) where
// f has k >= 1 roots mod p (k = 1 or 3), there are group homomorphisms
//
//   eps_p : E(Q)/2E(Q) -> (Z/2)^min(k,2)
//
// given per root theta of f mod p by writing x(P) = u/w^2 in lowest terms and
// taking the quadratic character of (u - theta*w^2) mod p — or of f'(theta)
// when p divides u - theta*w^2 (points reducing to the identity get character
// 0 automatically: their class is psi(u) and the p-adic kernel of reduction is
// 2-divisible for odd good p). Homomorphy is the only property we use.
//
// Certificate: stack the eps_p images of the n candidate points AND of the
// even-order generators of the (exactly computed) torsion subgroup into a
// matrix over F_2. If rank(all rows) - rank(torsion rows) = n, the points are
// independent modulo torsion, hence rank E(Q) >= n. Proof: a relation
// sum n_i P_i in torsion (n_i not all 0) can be halved until some n_i is odd
// (twice a torsion point's preimage is torsion), and then reducing mod 2E(Q)
// gives sum_{n_i odd} [P_i] = [S] with S torsion; every torsion class [S] lies
// in the F_2-span of the even-order generators' classes (odd-order torsion is
// 2-divisible within torsion), so applying eps makes the point rows dependent
// on the torsion rows — contradicting the rank condition. Note the certificate
// direction needs NO injectivity of eps and no minimum number of primes: more
// primes only ever help. Including the torsion rows closes a gap in the
// paper's simplified exposition (independence of eps-images alone does not
// rule out all-even-coefficient relations such as 2P - 2(P+T) = 0 for
// 2-torsion T).
//
// When the rank condition fails, a kernel vector of the matrix names a
// candidate relation Q = sum_{c_i=1} P_i with eps(Q) in the torsion span:
//   - if Q is torsion (or the identity), the points are PROVABLY dependent
//     modulo torsion: reject with the relation;
//   - if Q + tau = 2R for some torsion tau (exact division by 2 via
//     erk_half2 below), replace one involved point by R and retry. This leaves
//     the Q-span of the working set unchanged (2R = Q + tau gives R in the
//     span tensor Q, and the replaced point is recovered from 2R minus the
//     others), so both later verdicts transfer to the submitted points. The
//     choice of replaced index affects only convergence, never soundness.
//     Following the paper's height-descent argument, we replace the LARGEST
//     point (by exact bit-size of the x-coordinate, a naive-height proxy that
//     keeps this code float-free) among those in the relation NOT equivalent
//     to R up to sign and torsion. Both criteria dodge oscillations: the
//     relation P3 = P1 - P2 gives Q = 2P1 and R = P1, where replacing P1 by
//     itself would loop forever, while P8 = 3P1 - P2 gives Q = 4P1 and
//     R = 2P1, where replacing the small point P1 by 2P1 creates a zero row
//     that immediately halves back. Replacing the largest non-equivalent
//     point instead makes the set contain a repeated point up to sign/torsion
//     within a few rounds, which the degeneracy check below converts into a
//     proof of dependence. (If R matches every point in the relation, any
//     choice makes the degeneracy check fire, which is also correct:
//     work[j] = +-R + tau combined with 2R = Q + tau' is a genuine integer
//     relation with an odd coefficient.)
//   - otherwise the relation is spurious (eps just cannot see the difference
//     yet) and more primes are guaranteed (Chebotarev) to kill it.
// After each replacement, a pairwise check catches working sets that have
// degenerated into an exact dependence (difference or sum of two points
// torsion), which likewise proves the submitted points dependent.
//
// erk_cert returns [status, primes, rankAll, rankTors, halvings, relation]
// with status 1 = certified independent, -1 = proven dependent (relation =
// 1-based indices of an involved subset), 0 = inconclusive within budget
// (never observed for honest input; a safe reject).
const GP_CERT: string[] = [
  'erk_psi(a, p) = (1 - kronecker(a, p)) / 2;',
  // Exact division by 2 on the short model y^2 = x^3 + Ax + B: R with 2R = T,
  // or 0 if none. x(2R) = xT is the quartic below (the doubling formula with
  // y^2 eliminated); its rational roots are the x-coordinates of all R with
  // 2R = +-T, and trying both y's covers the sign. Complete because nfroots
  // returns every rational root; sound because 2R = T is re-checked exactly.
  // We do NOT use ellisdivisible here: since PARI 2.15 its strategy for
  // division by 2 over Q can attempt an unbounded CRT reconstruction of R
  // whose 10-prime local gate almost never fails on the points this
  // certificate produces (character-kernel elements are locally 2-divisible
  // at most primes by construction), which stalls for minutes or exhausts
  // the PARI stack on points with large coordinates (e.g. curve #159).
  'erk_half2(F, T) = {my(A = F.a4, B = F.a6, xT = T[1], ' +
    "pol = 4*(xT)*('x^3 + A*'x + B) - ('x^4 - 2*A*'x^2 - 8*B*'x + A^2), " +
    'rts = nfroots(, pol)); ' +
    'for(i = 1, #rts, my(ys = ellordinate(F, rts[i])); ' +
    'for(j = 1, #ys, my(R = [rts[i], ys[j]]); ' +
    'if(ellmul(F, R, 2) == T, return(R)))); 0;}',
  'erk_eps(A, pts, p, rs) = {my(k = min(#rs, 2), m = matrix(#pts, k)); ' +
    'for(i = 1, #pts, if(#pts[i] == 1, next); ' +
    'my(u = numerator(pts[i][1]), w2 = denominator(pts[i][1])); ' +
    'for(j = 1, k, my(th = rs[j], a = (u - th*w2) % p); ' +
    'if(a == 0, a = (3*th^2 + A) % p); ' +
    'm[i, j] = erk_psi(a, p))); m}',
  'erk_cert(F, pts0, maxhalve) = {' +
    'my(A = F.a4, B = F.a6, D = F.disc, n = #pts0, tor = elltors(F), ' +
    '   tg = [], tors = [[0]], work = pts0, halved = 0, t); ' +
    'for(i = 1, #tor[2], if(tor[2][i] % 2 == 0, tg = concat(tg, [tor[3][i]]))); ' +
    'for(i = 1, #tor[2], my(g = tor[3][i], cur = List()); ' +
    '  for(k = 0, tor[2][i] - 1, my(gk = ellmul(F, g, k)); ' +
    '    for(j = 1, #tors, listput(cur, elladd(F, tors[j], gk)))); ' +
    '  tors = Vec(cur)); ' +
    't = #tg; ' +
    'while(1, ' +
    '  my(all = concat(work, tg), rows = vector(n + t, i, []), used = List(), ' +
    '     p = 3, ncols = 0, target = n + t + 10, rall = 0, rt = 0, acted = 0); ' +
    '  while(!acted, ' +
    '    while(ncols < target && p < 10^6, ' +
    '      p = nextprime(p + 1); ' +
    '      if(D % p == 0, next); ' +
    '      my(rs = lift(Vec(polrootsmod(\'x^3 + A*\'x + B, p)))); ' +
    '      if(#rs == 0, next); ' +
    '      my(blk = erk_eps(A, all, p, rs)); ' +
    '      for(i = 1, n + t, rows[i] = concat(rows[i], blk[i, ])); ' +
    '      listput(used, p); ' +
    '      ncols += min(#rs, 2)); ' +
    '    my(M = Mod(matrix(n + t, ncols, i, j, rows[i][j]), 2)); ' +
    '    rall = matrank(M); ' +
    '    rt = if(t, matrank(Mod(matrix(t, ncols, i, j, rows[n + i][j]), 2)), 0); ' +
    '    if(rall - rt == n, return([1, Vec(used), rall, rt, halved, []])); ' +
    '    my(K = lift(matker(M~))); ' +
    '    for(j = 1, matsize(K)[2], ' +
    '      my(v = K[, j], c = select(i -> v[i] == 1, [1..n])); ' +
    '      if(#c == 0, next); ' +
    '      my(Q = [0]); ' +
    '      for(i = 1, #c, Q = elladd(F, Q, work[c[i]])); ' +
    '      if(#Q == 1 || ellorder(F, Q), return([-1, Vec(used), rall, rt, halved, c])); ' +
    '      my(R = 0, hit = 0); ' +
    '      for(k = 1, #tors, my(H = erk_half2(F, elladd(F, Q, tors[k]))); if(H, R = H; hit = 1; break)); ' +
    '      if(hit, ' +
    '        halved++; ' +
    '        if(halved > maxhalve, return([0, Vec(used), rall, rt, halved, []])); ' +
    '        my(ri = 0, rh = -1); ' +
    '        for(i = 1, #c, ' +
    '          my(s = ellsub(F, work[c[i]], R), a2 = elladd(F, work[c[i]], R)); ' +
    '          if(#s == 1 || #a2 == 1 || ellorder(F, s) || ellorder(F, a2), next); ' +
    '          my(h = exponent(max(1, abs(numerator(work[c[i]][1])))) + exponent(max(1, denominator(work[c[i]][1])))); ' +
    '          if(h > rh, rh = h; ri = c[i])); ' +
    '        if(!ri, ri = c[1]); ' +
    '        work[ri] = R; ' +
    '        for(i = 1, n, if(i != ri, ' +
    '          my(s = ellsub(F, work[i], R), a2 = elladd(F, work[i], R)); ' +
    '          if(#s == 1 || #a2 == 1 || ellorder(F, s) || ellorder(F, a2), ' +
    '            return([-1, Vec(used), rall, rt, halved, vecsort([i, ri])])))); ' +
    '        acted = 1; break)); ' +
    '    if(!acted, ' +
    '      if(p >= 10^6 || ncols >= 640, return([0, Vec(used), rall, rt, halved, []])); ' +
    '      target += n + t + 10)));}',
]

function installCertHelpers(gp: Gp): void {
  for (const def of GP_CERT) evalGp(gp, def)
}

class InputError extends Error {}

// Validate a single integer/rational token and return its canonical string.
function token(raw: string | number, label: string): string {
  // JSON numbers beyond 2^53 were already rounded by JSON.parse, so the digits
  // here would silently differ from what the client wrote.
  if (typeof raw === 'number' && !Number.isSafeInteger(raw)) {
    throw new InputError(
      `${label}: number is not a safe integer; pass integers beyond 2^53 (and all rationals) as strings`,
    )
  }
  const s = String(raw).trim().replace(/\u2212/g, '-')
  if (s.length === 0) throw new InputError(`${label}: bad length`)
  if (!NUM_RE.test(s)) throw new InputError(`${label}: not an integer/rational: ${s.slice(0, 40)}`)
  if (/\/0+$/.test(s)) throw new InputError(`${label}: zero denominator`)
  const parts = s.replace(/^[+-]/, '').split('/')
  if (parts.some((p) => p.length > MAX_NUMERIC_PART_DIGITS)) {
    throw new InputError(`${label}: too many digits (max ${MAX_NUMERIC_PART_DIGITS})`)
  }
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

function parseGpVector(out: string, label: string): string[] {
  const m = out.match(/^\[(.*)\]$/s)
  if (!m) throw new Error(`unexpected ${label} form: ${out.slice(0, 80)}`)
  const inner = m[1].trim()
  return inner === '' ? [] : inner.split(',').map((s) => s.trim())
}

function parseGpAinvs(out: string): Ainvs {
  const v = parseGpVector(out, 'a-invariants')
  if (v.length !== 5) throw new Error(`unexpected a-invariants length: ${out.slice(0, 80)}`)
  return [v[0], v[1], v[2], v[3], v[4]]
}

function parseGpPoint(out: string): Point {
  const v = parseGpVector(out, 'point')
  if (v.length !== 2) throw new Error(`unexpected point length: ${out.slice(0, 80)}`)
  return [v[0], v[1]]
}

function normalizeAinvs(ainvs: (string | number)[]): Ainvs {
  const t = ainvs.map((a, i) => token(a, `a-invariant[${i}]`))
  if (t.length === 2) return ['0', '0', '0', t[0], t[1]]
  if (t.length === 5) return [t[0], t[1], t[2], t[3], t[4]]
  throw new InputError('ainvs must have length 2 ([a4,a6]) or 5 ([a1,a2,a3,a4,a6])')
}

interface MinimalModel extends Canonical {
  ainvs: Ainvs
  discriminant: string
}

// Global minimal model for the curve `E` already loaded in the gp session.
// PARI also stores the change of variables in `EminChange`; `ellchangepoint(P,
// EminChange)` maps a point on `E` to this minimal model.
function minimalModel(gp: Gp): MinimalModel {
  evalGp(gp, 'Emin = ellminimalmodel(E, &EminChange);')
  const ainvs = parseGpAinvs(evalGp(gp, '[Emin.a1, Emin.a2, Emin.a3, Emin.a4, Emin.a6]'))
  const c4 = evalGp(gp, 'Emin.c4')
  const c6 = evalGp(gp, 'Emin.c6')
  const discriminant = evalGp(gp, 'Emin.disc')
  return { ainvs, c4, c6, discriminant, key: `${c4}:${c6}` }
}

// Global-minimal-model (c4,c6) for the curve `E` already loaded in the gp
// session. Used for both the canonical key and naive height.
function minimalC4C6(gp: Gp): Canonical {
  const m = minimalModel(gp)
  return { c4: m.c4, c6: m.c6, key: m.key }
}

const MAX_PRIMES = 256

// Validate a supplied list of primes of bad reduction: each entry an integer
// > 1 (primality itself is checked later, in GP). Returns canonical decimal
// strings (no sign, no leading zeros), deduplicated: `conductorFromPrimes`
// multiplies p^f_p over the list, so a repeated bad prime would otherwise
// contribute its conductor factor twice.
function normalizePrimes(rawPrimes: (string | number)[]): string[] {
  if (rawPrimes.length > MAX_PRIMES) throw new InputError(`too many primes (max ${MAX_PRIMES})`)
  const primes = new Set<string>()
  rawPrimes.forEach((p, i) => {
    const t = token(p, `prime[${i}]`)
    if (!/^\d+$/.test(t)) throw new InputError(`prime[${i}] must be an integer > 1`)
    const s = t.replace(/^0+(?=\d)/, '')
    if (s === '0' || s === '1') throw new InputError(`prime[${i}] must be an integer > 1`)
    primes.add(s)
  })
  return [...primes]
}

// Trial-division bound for automatic bad-prime detection. Trial division to this
// bound costs at most ~25ms even on a several-hundred-digit discriminant.
const AUTO_FACTOR_BOUND = '10^7'

// Attempt to recover the complete set of primes of bad reduction for
// the curve `E` (already loaded in `gp`) by trial-dividing |disc| up to AUTO_FACTOR_BOUND. Returns the
// primes iff this fully factors the minimal discriminant — i.e. every cofactor left
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
  if (inner === '') return null // |disc| = 1: no discriminant primes (cannot occur over Q)
  return inner.split(',').map((s) => s.trim())
}


// The conductor of the curve `E` (already loaded in `gp`, in its global minimal
// model) — the one invariant that needs the primes of bad reduction, computed
// from a supplied list rather than by factoring the discriminant. The primes are
// accepted only if each is a (BPSW) probable prime AND together they divide the
// minimal discriminant down to a unit, which proves they include every bad
// prime. Per-prime Tate's algorithm (elllocalred) gives the conductor exponents
// f_p, and conductor = prod p^f_p. (Minimal discriminant and Faltings height do
// NOT need the primes — the model is already minimal — so they are recorded at
// submission, not here.)
function conductorFromPrimes(
  gp: Gp,
  primes: string[],
): { conductor: string | null; badPrimes: string[] | null; note: string | null } {
  if (primes.length === 0) return { conductor: null, badPrimes: null, note: null }
  if (primes.length > MAX_PRIMES)
    return { conductor: null, badPrimes: null, note: `too many primes (max ${MAX_PRIMES})` }
  evalGp(gp, `cps = [${primes.join(',')}]`)
  // Two distinct failure modes, reported separately: a supplied value is not
  // prime, or the (prime) values are incomplete and leave an unaccounted factor
  // of the minimal discriminant.
  const allPrime = evalGp(gp, 'my(ok=1); for(i=1,#cps, if(!ispseudoprime(cps[i]), ok=0)); ok')
  if (allPrime !== '1') {
    return { conductor: null, badPrimes: null, note: 'supplied values are not all prime' }
  }
  // Residual after dividing out every supplied prime; 1 iff they account for the
  // entire minimal discriminant. Extraneous primes (not of bad reduction) are
  // harmless — they contribute a trivial conductor factor.
  const leftover = evalGp(gp, 'my(d=abs(E.disc)); for(i=1,#cps, while(d%cps[i]==0, d=d\\cps[i])); d')
  if (leftover !== '1') {
    const shown = leftover.length > 40 ? `${leftover.slice(0, 40)}…` : leftover
    return {
      conductor: null,
      badPrimes: null,
      note: `supplied primes of bad reduction are incomplete: they leave an unaccounted factor ${shown} of the minimal discriminant`,
    }
  }
  // The canonical bad-prime set: the supplied primes that actually divide the
  // minimal discriminant (extraneous good primes are dropped, not recorded),
  // sorted ascending. Nonempty: leftover == 1 and |disc| > 1 over Q. The
  // conductor product runs over exactly these (good primes contribute p^0).
  evalGp(gp, 'bps = vecsort(select(p -> E.disc % p == 0, cps))')
  const badPrimes = parseGpVector(evalGp(gp, 'bps'), 'bad primes')
  const conductor = evalGp(gp, 'prod(i=1, #bps, bps[i]^elllocalred(E, bps[i])[1])')
  return { conductor, badPrimes, note: null }
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
// curve from a supplied list of primes of bad reduction.
export interface PrimesResult {
  ok: boolean
  conductor: string | null
  // The verified primes of bad reduction (sorted ascending), present iff the
  // conductor is.
  badPrimes: string[] | null
  // Set when primes were supplied but failed validation, or input was rejected.
  note: string | null
  errors: string[]
}

// Compute the conductor for an already-recorded curve from a supplied list of
// primes of bad reduction — without re-verifying points and without factoring.
// The a-invariants come from a trusted stored curve (already the global minimal
// model); the primes are validated exactly as in `verify` (each a probable
// prime, together dividing the minimal discriminant to a unit). `ok` is true iff
// the conductor was computed; otherwise `note`/`errors` say why not. (The
// discriminant and Faltings height are recorded at submission, not here.)
export function verifyPrimes(
  gp: Gp,
  ainvs: (string | number)[],
  rawPrimes: (string | number)[],
): PrimesResult {
  const out: PrimesResult = {
    ok: false,
    conductor: null,
    badPrimes: null,
    note: null,
    errors: [],
  }
  let a: [string, string, string, string, string]
  let primes: string[]
  try {
    a = normalizeAinvs(ainvs)
    primes = normalizePrimes(rawPrimes)
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
    const cond = conductorFromPrimes(gp, primes)
    out.conductor = cond.conductor
    out.badPrimes = cond.badPrimes
    out.note = cond.note
    out.ok = cond.conductor != null
    return out
  } catch (e) {
    out.errors.push(e instanceof Error ? e.message : String(e))
    return out
  }
}

// Like `verifyPrimes`, but recovers the primes of bad reduction automatically by
// bounded trial division instead of taking them from the caller. `ok` is true
// iff the minimal discriminant fully factored within the budget and the
// conductor was computed; otherwise `note` explains that manual entry is needed.
export function autoPrimes(gp: Gp, ainvs: (string | number)[]): PrimesResult {
  const out: PrimesResult = {
    ok: false,
    conductor: null,
    badPrimes: null,
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
        'could not find the primes of bad reduction within the quick budget — please enter them manually'
      return out
    }
    const cond = conductorFromPrimes(gp, primes)
    out.conductor = cond.conductor
    out.badPrimes = cond.badPrimes
    out.note = cond.note
    out.ok = cond.conductor != null
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
    badPrimes: null,
    faltingsHeight: null,
    torsion: null,
    conductorNote: null,
  }

  // --- 1. Parse & validate input (no GP evaluation of raw strings) ---
  let ainvs: Ainvs
  let pts: Point[]
  let primes: string[]
  try {
    ainvs = normalizeAinvs(input.ainvs ?? [])
    const rawPts = input.points ?? []
    if (!Array.isArray(rawPts) || rawPts.length === 0) throw new InputError('no points provided')
    if (rawPts.length > MAX_POINTS) throw new InputError(`too many points (max ${MAX_POINTS})`)
    pts = rawPts.map((p, i) => {
      if (!Array.isArray(p) || p.length !== 2) throw new InputError(`point[${i}] must be [x,y]`)
      return [token(p[0], `point[${i}].x`), token(p[1], `point[${i}].y`)] as Point
    })
    primes = normalizePrimes(input.primes ?? [])
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
    evalGp(gp, 'Einput = E;')

    // Canonical storage/dedup model: the global minimal model, identifying the
    // Q-isomorphism class by (c4,c6).
    const minModel = minimalModel(gp)
    result.canonical = { c4: minModel.c4, c6: minModel.c6, key: minModel.key }

    // Naive height log max(|c4|^3, |c6|^2) of the GLOBAL MINIMAL MODEL — the
    // convention used by EW 2004 / LMFDB / Cremona, so the value is comparable
    // to the literature records on the board. This prevents non-minimal
    // submissions from changing the recorded height. (Substituted strings are
    // PARI integer output, not submitter input.)
    result.height = {
      naiveLogHeight: evalGp(
        gp,
        `log(vecmax([abs(${minModel.c4})^3, (${minModel.c6})^2]))*1.0`,
      ),
    }
    evalGp(gp, 'E = Emin;')

    // Stable Faltings height (LMFDB normalization): -1/2 log of the period
    // lattice covolume of the global minimal model. No primes needed, so it is
    // recorded for every curve.
    result.faltingsHeight = evalGp(
      gp,
      'my(A=abs(imag(conj(Emin.omega[1])*Emin.omega[2]))); -(1/2)*log(A)',
    )

    // Conductor — the one prime-gated invariant. If no primes were supplied, try
    // to recover them by bounded trial division: a best-effort that completes in
    // milliseconds and gives up (rather than factoring a hard composite) when it
    // cannot fully factor the minimal discriminant.
    if (primes.length === 0) {
      const auto = autoBadPrimes(gp)
      if (auto) primes = auto
    }
    const cond = conductorFromPrimes(gp, primes)
    result.conductor = cond.conductor
    result.badPrimes = cond.badPrimes
    result.conductorNote = cond.note
    evalGp(gp, 'E = Einput;')

    // --- 3. Check every point lies on the curve (exact) ---
    result.points = pts.map((p) => ({
      point: p,
      onCurve: evalGp(gp, `ellisoncurve(E, [${p[0]},${p[1]}])`) === '1',
    }))
    result.allPointsOnCurve = result.points.every((p) => p.onCurve)
    if (!result.allPointsOnCurve) {
      for (const [i, p] of result.points.entries()) {
        if (!p.onCurve) {
          result.errors.push(`point[${i}] = [${p.point[0]}, ${p.point[1]}] does not lie on the curve`)
        }
      }
      return result
    }

    // --- 4. Independence: exact 2-descent quadratic-character certificate ---
    // (see GP_CERT above). The regulator is still computed first, but purely
    // as an informational diagnostic (it is stored and displayed with the
    // curve); it plays no role in the accept/reject decision.
    const n = pts.length
    const prec = Math.min(250, Math.max(38, 38 + 2 * n))
    const ptsGp = '[' + pts.map((p) => `[${p[0]},${p[1]}]`).join(',') + ']'
    evalGp(gp, `\\p ${prec}`)
    evalGp(gp, `pts = ${ptsGp}`)
    const regulator = evalGp(gp, 'matdet(ellheightmatrix(E, pts))')

    // The exact certificate runs on the short model F: y^2 = x^3 - 27c4 x - 54c6
    // of the (integral) global minimal model; the submitted points are
    // transported through exact rational changes of variables and re-checked.
    installCertHelpers(gp)
    // [u,r,s,t] with u=1/6, r=-b2/12, s=-a1/2, t=-(a3+r*a1)/2 sends any model to
    // y^2 = x^3 - 27c4 x - 54c6 (the classical X=36x+3b2, Y=108(2y+a1x+a3)).
    evalGp(
      gp,
      'erkV = [1/6, -Emin.b2/12, -Emin.a1/2, -(Emin.a3 - Emin.b2*Emin.a1/12)/2];',
    )
    evalGp(gp, 'erkF = ellinit(ellchangecurve(Emin, erkV));')
    // The certificate's character maps assume a short model y^2 = x^3 + Ax + B
    // with integral A, B: assert it rather than trust the algebra above.
    if (
      evalGp(
        gp,
        'erkF.a1 == 0 && erkF.a2 == 0 && erkF.a3 == 0 && ' +
          'type(erkF.a4) == "t_INT" && type(erkF.a6) == "t_INT"',
      ) !== '1'
    ) {
      throw new Error('internal: transformation to a short Weierstrass model failed')
    }
    evalGp(
      gp,
      `erkPts = vector(${n}, i, ellchangepoint(ellchangepoint(pts[i], EminChange), erkV));`,
    )
    if (evalGp(gp, `sum(i = 1, ${n}, ellisoncurve(erkF, erkPts[i])) == ${n}`) !== '1') {
      throw new Error('internal: points failed to transport to the short model')
    }
    evalGp(gp, `erkRes = erk_cert(erkF, erkPts, ${MAX_HALVINGS});`)
    const status = evalGp(gp, 'erkRes[1]')
    const certPrimes = parseGpVector(evalGp(gp, 'erkRes[2]'), 'certificate primes')
    const matrixRank = Number(evalGp(gp, 'erkRes[3]'))
    const torsionRank = Number(evalGp(gp, 'erkRes[4]'))
    const halvings = Number(evalGp(gp, 'erkRes[5]'))
    const torsion = evalGp(gp, 'elltors(erkF)[2]')
    // erkF is Q-isomorphic to the minimal model, so this is the curve's torsion
    // structure; normalized to compact JSON for storage.
    result.torsion = JSON.stringify(parseGpVector(torsion, 'torsion structure').map(Number))

    const independent = status === '1'
    // Certified lower bound even on failure: point rows contribute
    // matrixRank - torsionRank dimensions beyond the torsion span.
    const exactLB = independent ? n : Math.max(0, matrixRank - torsionRank)
    result.independence = {
      independent,
      rankLowerBound: exactLB,
      certificate: independent
        ? { primes: certPrimes, matrixRank, torsionRank, halvings, torsion }
        : null,
      regulator,
      precisionDigits: prec,
      method: independent
        ? `exact 2-descent certificate (Cremona/Brumer): quadratic-character images at ` +
          `${certPrimes.length} good primes give an F_2 matrix of rank ${matrixRank} ` +
          `(torsion rows: rank ${torsionRank}), proving the ${n} points independent modulo ` +
          `torsion${halvings ? ` after ${halvings} halving step(s)` : ''}; ` +
          `Neron-Tate regulator at ${prec} digits recorded as a diagnostic`
        : `exact 2-descent certificate not attained: ${exactLB} of ${n} points certified ` +
          `independent modulo torsion over ${certPrimes.length} good primes`,
    }
    if (!independent) {
      if (status === '-1') {
        const rel = parseGpVector(evalGp(gp, 'erkRes[6]'), 'dependence relation').map(
          (s) => Number(s) - 1,
        )
        result.errors.push(
          `points are provably dependent modulo torsion (a dependence involves ` +
            `point indices [${rel.join(', ')}]); only ${exactLB} of ${n} certified independent`,
        )
      } else {
        // Status 0: a budget ran out; nothing was proven about the points
        // either way. erk_cert increments past maxhalve exactly when the
        // halving budget fired, so halvings distinguishes the two budgets.
        const reason =
          halvings > MAX_HALVINGS
            ? `the halving budget was exhausted (${MAX_HALVINGS} point replacements)`
            : `the character budget was exhausted (${certPrimes.length} good primes)`
        result.errors.push(
          `certification inconclusive: ${reason} with only ${exactLB} of ${n} points ` +
            `certified independent; no dependence was proven — try submitting fewer ` +
            `points or points of smaller height`,
        )
      }
      return result
    }

    result.curve = {
      ainvs: minModel.ainvs,
      c4: minModel.c4,
      c6: minModel.c6,
      discriminant: minModel.discriminant,
      nonsingular: true,
    }
    result.points = pts.map((p) => ({
      point: parseGpPoint(evalGp(gp, `ellchangepoint([${p[0]},${p[1]}], EminChange)`)),
      onCurve: true,
    }))
    result.ok = true
    return result
  } catch (e) {
    result.errors.push(e instanceof Error ? e.message : String(e))
    return result
  }
}
