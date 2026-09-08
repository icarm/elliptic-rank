// Parsers for the HTML form's free-text fields. The site prints points as
// "(x, y)" and lists as "[a, b, c]", PARI prints vectors as "[x, y]" and Sage
// prints projective points as "(x : y : 1)", so the form accepts all of those
// as well as the bare "x, y" per line it documents.
//
// Rule throughout: never coerce or silently drop anything. Every character of
// the input is either part of a number, a separator, or a bracket/quote in a
// position the format allows; anything else is an error naming the offending
// piece. (A point line "3, 4, 5, 6" is rejected, not read as (3, 4); a
// bracket in the middle of a number is rejected, not stripped.)

export class PointParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PointParseError'
  }

  static line(lineNumber: number, coordinateCount: number): PointParseError {
    return new PointParseError(
      `point line ${lineNumber} must contain exactly two coordinates; ` +
        `found ${coordinateCount} (put one point per line)`,
    )
  }

  static group(groupNumber: number, coordinateCount: number): PointParseError {
    return new PointParseError(
      `point ${groupNumber} must contain exactly two coordinates (or x : y : 1); found ${coordinateCount}`,
    )
  }
}

export class TokenParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TokenParseError'
  }
}

const EDGE_DECORATION = /^["'\[\](){}]+|["'\[\](){}]+$/g
const DECORATION = /["'\[\](){}]/

// Strip quotes/brackets from the edges of a token. A quote or bracket in the
// middle of a token (e.g. "12[34") is neither a number nor a list decoration:
// error rather than split or strip it.
function bareToken(raw: string, what: string): string {
  const t = raw.replace(EDGE_DECORATION, '')
  if (DECORATION.test(t)) {
    throw new TokenParseError(`${what}: unexpected bracket or quote inside "${raw.slice(0, 40)}"`)
  }
  return t
}

// Split a list of numbers written with any of the usual decorations: commas
// or whitespace between entries; optional brackets around the list (PARI
// "[a, b]", the site's own "[a1, a2, a3, a4, a6]"); optional quotes around
// entries (the JSON API's string numbers). Brackets and quotes are only
// recognized at token edges; anything else passes through to the numeric
// validator, which rejects it.
export function parseTokens(s: string): string[] {
  const out: string[] = []
  for (const raw of s.trim().split(/[\s,]+/)) {
    if (!raw) continue
    const t = bareToken(raw, `entry ${out.length + 1}`)
    if (t) out.push(t)
  }
  return out
}

// Coordinates inside one bracketed group: "x, y", "x y", or Sage's projective
// "x : y : 1", which is accepted only when z is exactly 1.
function groupCoordinates(inner: string, groupNumber: number): [string, string] {
  const parts: string[] = []
  for (const raw of inner.split(/[\s,:]+/)) {
    if (!raw) continue
    const t = bareToken(raw, `point ${groupNumber}`)
    if (t) parts.push(t)
  }
  if (parts.length === 3 && parts[2] === '1') parts.pop()
  if (parts.length !== 2) throw PointParseError.group(groupNumber, parts.length)
  return [parts[0], parts[1]]
}

// Parse witness points. Two formats:
//
//  * one point per line, "x, y" or "x y" (the documented form);
//  * bracketed groups — "(x, y)", "[x, y]", "(x : y : 1)" — anywhere in the
//    text, one point per innermost matching pair, so a whole PARI vector of
//    points "[[x1, y1], [x2, y2]]" or the JSON API's [["x","y"], ...] pastes
//    as-is.
//
// The bracketed form is used whenever the text contains any bracket character
// (a lone closing one included, so it is reported here rather than as a bad
// number later). Everything outside the groups must then be list punctuation
// (properly nested outer square brackets, commas, semicolons, whitespace); a
// number outside a group, a mismatched, unbalanced or misordered bracket, or a
// malformed group is an error, never dropped.
export function parsePoints(s: string): [string, string][] {
  const points: [string, string][] = []
  if (/[\[\]()]/.test(s)) {
    let n = 0
    const rest = s.replace(/\(([^()\[\]]*)\)|\[([^()\[\]]*)\]/g, (_, paren: string | undefined, square: string | undefined) => {
      n++
      points.push(groupCoordinates(paren ?? square ?? '', n))
      return ' '
    })
    if (/[^\[\]\s,;]/.test(rest)) {
      const shown = rest.replace(/\s+/g, ' ').trim()
      throw new PointParseError(
        `could not parse the points: unexpected text "${shown.slice(0, 60)}" outside a (x, y) group; ` +
          'use one point per line, or a bracketed pair per point',
      )
    }
    // The remaining square brackets wrap the vector(s) of points: they must
    // nest properly, so a depth scan never goes negative and ends at zero.
    let depth = 0
    for (const ch of rest) {
      if (ch === '[') depth++
      else if (ch === ']' && --depth < 0) {
        throw new PointParseError('could not parse the points: a "]" closes nothing (unbalanced brackets)')
      }
    }
    if (depth > 0) {
      throw new PointParseError(`could not parse the points: ${depth} "[" never closed (unbalanced brackets)`)
    }
    return points
  }
  const lines = s.split(/\r\n|[\n\r\u2028\u2029]/)
  for (const [i, rawLine] of lines.entries()) {
    const line = rawLine.trim()
    if (!line) continue
    const parts = line.split(/[\s,]+/).filter(Boolean)
    if (parts.length !== 2) throw PointParseError.line(i + 1, parts.length)
    points.push([parts[0], parts[1]])
  }
  return points
}
