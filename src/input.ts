export class PointParseError extends Error {
  constructor(lineNumber: number, coordinateCount: number) {
    super(
      `point line ${lineNumber} must contain exactly two coordinates; ` +
        `found ${coordinateCount} (put one point per line)`,
    )
    this.name = 'PointParseError'
  }
}

// Parse one affine point per line. Accept the common plain-text line endings,
// but reject malformed lines instead of silently discarding extra coordinates.
export function parsePoints(s: string): [string, string][] {
  const points: [string, string][] = []
  const lines = s.split(/\r\n|[\n\r\u2028\u2029]/)
  for (const [i, rawLine] of lines.entries()) {
    const line = rawLine.trim()
    if (!line) continue
    const parts = line.split(/[\s,]+/).filter(Boolean)
    if (parts.length !== 2) throw new PointParseError(i + 1, parts.length)
    points.push([parts[0], parts[1]])
  }
  return points
}
