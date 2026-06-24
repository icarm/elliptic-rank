// Render public/og.png — the social-preview (Open Graph) card: the favicon's
// elliptic curve, centered on the site background, at the standard 1200x630.
//
//   node scripts/make-og-image.mjs
import fs from 'node:fs'
import sharp from 'sharp'

const W = 1200, H = 630
const BG = '#f7fbfa' // --bg from public/style.css
const S = 560 // rendered size of the 32x32 curve artwork

const favicon = fs.readFileSync('public/favicon.svg', 'utf8')
const inner = favicon.match(/<g[\s\S]*<\/g>/)?.[0]
if (!inner) throw new Error('could not find <g> artwork in public/favicon.svg')

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <g transform="translate(${(W - S) / 2}, ${(H - S) / 2}) scale(${S / 32})">${inner}</g>
</svg>`

await sharp(Buffer.from(svg), { density: 300 }).png({ compressionLevel: 9 }).toFile('public/og.png')
console.log(`wrote public/og.png (${fs.statSync('public/og.png').size} bytes)`)
