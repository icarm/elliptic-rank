import assert from 'node:assert/strict'
import { parsePoints, parseTokens, PointParseError, TokenParseError } from '../src/input.ts'

const thirtyLines = Array.from({ length: 30 }, (_, i) => `${i + 1}, ${i + 2}`).join('\n')
assert.equal(parsePoints(thirtyLines).length, 30)

assert.deepEqual(
  parsePoints('1, 2\r\n3 4\r5,6\u20287 8\u20299, 10'),
  [['1', '2'], ['3', '4'], ['5', '6'], ['7', '8'], ['9', '10']],
)

assert.throws(
  () => parsePoints('1, 2\n3, 4, 5, 6'),
  (e) =>
    e instanceof PointParseError &&
    e.message === 'point line 2 must contain exactly two coordinates; found 4 (put one point per line)',
)
assert.throws(
  () => parsePoints('1, 2\n3'),
  (e) =>
    e instanceof PointParseError &&
    e.message === 'point line 2 must contain exactly two coordinates; found 1 (put one point per line)',
)

// --- bracketed forms ---

// The curve page's witness list, one "(x, y)" per line, rationals included.
assert.deepEqual(
  parsePoints('(-3635871/4, -314862269/8)\n(-856990, -350938406)\n(894450, -1211674470)'),
  [['-3635871/4', '-314862269/8'], ['-856990', '-350938406'], ['894450', '-1211674470']],
)
// A PARI vector of points on one line.
assert.deepEqual(parsePoints('[[49421, 200114], [49493, 333458], [49513, 362258]]'), [
  ['49421', '200114'],
  ['49493', '333458'],
  ['49513', '362258'],
])
// The JSON API's string-number form, with arbitrary whitespace.
assert.deepEqual(parsePoints('[["49421","200114"],\n ["49493", "333458"]]'), [
  ['49421', '200114'],
  ['49493', '333458'],
])
// Sage's projective spelling with z = 1; z != 1 is not an affine point.
assert.deepEqual(parsePoints('(49421 : 200114 : 1)\n(1/2 : -3/8 : 1)'), [
  ['49421', '200114'],
  ['1/2', '-3/8'],
])
assert.throws(
  () => parsePoints('(1 : 2 : 3)'),
  (e) => e instanceof PointParseError && e.message === 'point 1 must contain exactly two coordinates (or x : y : 1); found 3',
)
// Wrong arity inside a group names the group, not a line.
assert.throws(
  () => parsePoints('(1, 2)\n(3, 4, 5, 6)'),
  (e) => e instanceof PointParseError && e.message === 'point 2 must contain exactly two coordinates (or x : y : 1); found 4',
)
// Trailing separators and semicolons between groups are fine.
assert.deepEqual(parsePoints('(1, 2); (3, 4),'), [['1', '2'], ['3', '4']])

// --- nothing is ever silently dropped or coerced ---

// Numbers outside any group when brackets are in use, shown verbatim.
assert.throws(
  () => parsePoints('(1, 2)\n3, 4'),
  (e) => e instanceof PointParseError && e.message.includes('unexpected text "3, 4"'),
)
// A bracket inside a number breaks the group; the leftover is shown verbatim, not stripped.
assert.throws(
  () => parsePoints('(12[34, 5)'),
  (e) => e instanceof PointParseError && e.message.includes('unexpected text "(12[34, 5)"'),
)
assert.throws(
  () => parsePoints('[12(34, 5]'),
  (e) => e instanceof PointParseError && e.message.includes('unexpected text "[12(34, 5]"'),
)
// A quote inside a number within a well-formed group is an error, not stripped.
assert.throws(
  () => parsePoints('(1"2, 5)'),
  (e) => e instanceof TokenParseError && e.message.includes('point 1: unexpected bracket or quote inside "1"2"'),
)
// A mismatched pair "(x, y]" is not a group, so its contents are stray text.
assert.throws(
  () => parsePoints('(1, 2]'),
  (e) => e instanceof PointParseError && e.message.includes('unexpected text "(1, 2]"'),
)
// A truncated paste: unclosed outer vector, or a half-written point.
assert.throws(
  () => parsePoints('[[1, 2], [3, 4]'),
  (e) => e instanceof PointParseError && e.message.includes('unbalanced brackets (1 "[" vs 0 "]")'),
)
assert.throws(
  () => parsePoints('[[1, 2], [3,'),
  (e) => e instanceof PointParseError && e.message.includes('unexpected text'),
)
// An empty group is a point with zero coordinates.
assert.throws(
  () => parsePoints('(1, 2)\n()'),
  (e) => e instanceof PointParseError && e.message === 'point 2 must contain exactly two coordinates (or x : y : 1); found 0',
)

// --- parseTokens: a-invariants and primes ---
assert.deepEqual(parseTokens('0, 0, 1, -6349808647, 193146346911036'), ['0', '0', '1', '-6349808647', '193146346911036'])
assert.deepEqual(parseTokens('[0, 0, 1, -6349808647, 193146346911036]'), ['0', '0', '1', '-6349808647', '193146346911036'])
assert.deepEqual(parseTokens('["0","0","1","-6349808647","193146346911036"]'), ['0', '0', '1', '-6349808647', '193146346911036'])
assert.deepEqual(parseTokens('(2, 3, 211)'), ['2', '3', '211'])
assert.deepEqual(parseTokens(' 2 3   211 '), ['2', '3', '211'])
assert.deepEqual(parseTokens(''), [])
// Decorations only at token edges; inside a number they are an error.
assert.throws(
  () => parseTokens('0, 0, 1, -63498[08647, 193146346911036'),
  (e) => e instanceof TokenParseError && e.message === 'entry 4: unexpected bracket or quote inside "-63498[08647"',
)
assert.throws(
  () => parseTokens('["0","0","1","-6349808647","1931"46346911036"]'),
  (e) => e instanceof TokenParseError && e.message.includes('entry 5'),
)

console.log('point form parser OK')
