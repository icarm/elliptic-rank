// Families of curves tracked as record pools of their own, alongside the
// torsion subgroups (issue #8). Membership is a property of the Q-isomorphism
// class, read off the c-invariants of the global minimal model (stored in
// curves.c4 / curves.c6), so nothing about it is stored. Every test below
// survives a change of model: c4 and c6 scale by u^4 and u^6, both squares.
//
// The families nest: each lies in the j = 0 curves (c4 = 0) or the j = 1728
// curves (c6 = 0), which no nonsingular curve is both. Within each, the
// family of all such curves comes first, then its special case, so a curve is
// in at most two families. Dependency-free, like ./gate, so tests can import
// it.

export interface Family {
  key: string // URL key (?family=)
  name: string // plain text, e.g. "Mordell curves"
  label: string // the equation as plain text, for <option> and titles
  html: string // the equation as HTML
  j: '0' | '1728' // the j-invariant of its curves, which groups the families
  within: string | null // the key of the family it is a special case of
  rule: string // `has` as HTML, for the API docs
  has: (c4: bigint, c6: bigint) => boolean
}

function isSquare(n: bigint): boolean {
  if (n < 0n) return false
  if (n < 2n) return true
  // Newton's method from above: x > isqrt(n) until it stops decreasing.
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2))
  for (;;) {
    const y = (x + n / x) >> 1n
    if (y >= x) return x * x === n
    x = y
  }
}

export const FAMILIES: readonly Family[] = [
  // j = 0 is exactly the curves y² = x³ + k (k up to sixth powers), for
  // which c6 = −864k.
  {
    key: 'mordell',
    name: 'Mordell curves',
    label: 'y² = x³ + k',
    html: '<span class="eqi">y<sup>2</sup> = x<sup>3</sup> + k</span>',
    j: '0',
    within: null,
    rule: 'c<sub>4</sub> = 0 (j = 0)',
    has: (c4) => c4 === 0n,
  },
  // x³ + y³ = A, the cubic twists of the Fermat cubic, is y² = x³ − 432A²,
  // so c6 = 2⁹·3⁶·A² = 2·(432A)²: exactly the Mordell curves with 2·c6 a
  // square.
  {
    key: 'cubesum',
    name: 'cube-sum curves',
    label: 'x³ + y³ = A',
    html: '<span class="eqi">x<sup>3</sup> + y<sup>3</sup> = A</span>',
    j: '0',
    within: 'mordell',
    rule: 'c<sub>4</sub> = 0 and 2c<sub>6</sub> is a square',
    has: (c4, c6) => c4 === 0n && isSquare(2n * c6),
  },
  // j = 1728 is exactly the quartic twists y² = x³ + Dx (D up to fourth
  // powers), for which c4 = −48D.
  {
    key: 'quartic',
    name: 'quartic twists',
    label: 'y² = x³ + ax',
    html: '<span class="eqi">y<sup>2</sup> = x<sup>3</sup> + ax</span>',
    j: '1728',
    within: null,
    rule: 'c<sub>6</sub> = 0 (j = 1728)',
    has: (_c4, c6) => c6 === 0n,
  },
  // y² = x³ − n²x: the quartic twists with −D, hence 3·c4 = −144D, a square.
  {
    key: 'congruent',
    name: 'congruent-number curves',
    label: 'y² = x³ − n²x',
    html: '<span class="eqi">y<sup>2</sup> = x<sup>3</sup> &minus; n<sup>2</sup>x</span>',
    j: '1728',
    within: 'quartic',
    rule: 'c<sub>6</sub> = 0 and 3c<sub>4</sub> is a square',
    has: (c4, c6) => c6 === 0n && isSquare(3n * c4),
  },
]

export function familyByKey(key: string | null | undefined): Family | null {
  return FAMILIES.find((f) => f.key === key) ?? null
}

// The keys of every family the curve with these c-invariants (decimal
// strings) is in, in FAMILIES order: none, or a j-invariant's family of all
// its curves and possibly that family's special case.
export function curveFamilies(c4: string, c6: string): string[] {
  const a = BigInt(c4)
  const b = BigInt(c6)
  return FAMILIES.filter((f) => f.has(a, b)).map((f) => f.key)
}

// The single family reported by the `family` fields of the JSON export and
// of a declined submission, which predate the nested families and keep their
// original meaning: "mordell", "congruent" or null. New code uses
// curveFamilies.
export function legacyFamily(c4: string, c6: string): string | null {
  return curveFamilies(c4, c6).find((k) => k === 'mordell' || k === 'congruent') ?? null
}
