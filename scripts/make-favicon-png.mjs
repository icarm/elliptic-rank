// Rasterize public/favicon.svg into PNGs:
//   * public/favicon-{16,32,48,180,192,512}.png  — transparent, for <link rel="icon"> etc.
//   * scripts/out/favicon-{256,512,1024}.png      — white background, useful for
//     the GitHub OAuth app icon and other places that want a flat bitmap.
//
//   node scripts/make-favicon-png.mjs
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

const svg = fs.readFileSync('public/favicon.svg')

async function render(size, dest, background) {
  const out = path.join(dest, `favicon-${size}.png`)
  let pipe = sharp(svg, { density: Math.max(72, size * 12) }).resize(size, size, {
    fit: 'contain',
    background: background ?? { r: 0, g: 0, b: 0, alpha: 0 },
  })
  if (background) pipe = pipe.flatten({ background })
  await pipe.png({ compressionLevel: 9 }).toFile(out)
  console.log(`wrote ${out} (${fs.statSync(out).size} bytes)`)
}

// Favicons — transparent.
for (const s of [16, 32, 48, 180, 192, 512]) await render(s, 'public', null)

// OAuth / app-icon variants — flat white background.
fs.mkdirSync('scripts/out', { recursive: true })
for (const s of [256, 512, 1024]) {
  await render(s, 'scripts/out', { r: 255, g: 255, b: 255, alpha: 1 })
}
