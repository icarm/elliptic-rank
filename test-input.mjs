import assert from 'node:assert/strict'
import { parsePoints, PointParseError } from './src/input.ts'

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

console.log('point form parser OK')
