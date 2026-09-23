// Post-login return-path validation: only same-origin paths may come out,
// resolved the way a browser resolves a Location header.
import { safeReturnPath } from '../src/auth.ts'

let failed = 0
function check(input, expected) {
  const got = safeReturnPath(input)
  const ok = got === expected
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${JSON.stringify(input)} -> ${JSON.stringify(got)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`)
}

// Accepted: ordinary same-site paths, with query and fragment.
check('/', '/')
check('/profile', '/profile')
check('/?from=12#submit', '/?from=12#submit')
check('/curves?sort=naive&dir=desc', '/curves?sort=naive&dir=desc')

// Rejected: empty, relative, absolute, protocol-relative, login loops.
check(null, null)
check(undefined, null)
check('', null)
check('profile', null)
check('https://evil.com/', null)
check('//evil.com', null)
check('//evil.com/path', null)
check('/auth/github', null)
check('/auth/github/callback?code=x', null)

// Rejected: backslash variants, which browsers read as `//host`.
check('/\\evil.com', null)
check('/\\\\evil.com', null)
check('/\\/evil.com', null)
check('\\/evil.com', null)
check('/\\evil.com/path?x=1', null)

if (failed) {
  console.error(`${failed} FAILED`)
  process.exit(1)
}
console.log('ALL PASS')
