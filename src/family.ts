// Families of curves tracked as record pools of their own, alongside the
// torsion subgroups (issue #8). Membership is a property of the Q-isomorphism
// class, read off the c-invariants of the global minimal model (stored in
// curves.c4 / curves.c6), so nothing about it is stored. The families are
// disjoint (a nonsingular curve cannot have c4 = c6 = 0), so a curve belongs
// to at most one. Dependency-free, like ./gate, so tests can import it.

export interface Family {
  key: string // URL key (?family=)
  name: string // plain text, e.g. "Mordell curves"
  label: string // the equation as plain text, for <option> and titles
  html: string // the equation as HTML
}

export const FAMILIES: readonly Family[] = [
  {
    key: 'mordell',
    name: 'Mordell curves',
    label: 'y² = x³ + k',
    html: '<span class="eqi">y<sup>2</sup> = x<sup>3</sup> + k</span>',
  },
  {
    key: 'congruent',
    name: 'congruent-number curves',
    label: 'y² = x³ − n²x',
    html: '<span class="eqi">y<sup>2</sup> = x<sup>3</sup> &minus; n<sup>2</sup>x</span>',
  },
]

export function familyByKey(key: string | null | undefined): Family | null {
  return FAMILIES.find((f) => f.key === key) ?? null
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

// The family key of the curve with these c-invariants (decimal strings), or
// null. j = 0 (c4 = 0) is exactly the Mordell curves y² = x³ + k. j = 1728
// (c6 = 0) is y² = x³ + Dx with c4 = −48D up to fourth powers, and the
// congruent-number curves y² = x³ − n²x are those where −D, hence 3·c4, is a
// square.
export function curveFamily(c4: string, c6: string): string | null {
  if (c4 === '0') return 'mordell'
  if (c6 === '0' && isSquare(3n * BigInt(c4))) return 'congruent'
  return null
}
