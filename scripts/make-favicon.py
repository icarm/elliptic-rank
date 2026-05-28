#!/usr/bin/env python3
# Regenerate public/favicon.svg by sampling the elliptic curve y^2 = x^3 - x.
# The curve has two real components — the oval on [-1, 0] and the open branch
# from x = 1 onward — and the favicon plots both.
import math, sys

# math (x, y) -> svg pixel.  x in [-1.5, 2.5], y in [-3, 3] mapped to a 32x32 box.
sx = lambda x: (x + 1.5) * 8
sy = lambda y: 16 - y * 16 / 3

# Closed oval: x = -1 to 0 along y > 0, then 0 back to -1 along y < 0.
N = 50
upper = [(-1 + i / N, math.sqrt(max(0.0, (-1 + i / N) ** 3 - (-1 + i / N)))) for i in range(N + 1)]
oval_pts = (
    [(sx(x), sy(y)) for x, y in upper]
    + [(sx(x), sy(-y)) for x, y in reversed(upper)]
)
oval_d = "M " + " L ".join(f"{a:.2f},{b:.2f}" for a, b in oval_pts) + " Z"

# Open branch: from x = 1 upward; stop when |y| exceeds the viewBox.
YMAX = 3.0
top, bot = [], []
i = 0
while True:
    x = 1 + i * 0.005
    rhs = x ** 3 - x
    if rhs < 0:
        i += 1
        continue
    y = math.sqrt(rhs)
    if y > YMAX:
        break
    top.append((sx(x), sy(y)))
    bot.append((sx(x), sy(-y)))
    i += 1
branch_d = (
    "M "
    + " L ".join(f"{a:.2f},{b:.2f}" for a, b in reversed(top))
    + " L "
    + " L ".join(f"{a:.2f},{b:.2f}" for a, b in bot)
)

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <g fill="none" stroke="#2a6df4" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="{oval_d}"/>
    <path d="{branch_d}"/>
  </g>
</svg>
'''

out = "public/favicon.svg"
with open(out, "w") as f:
    f.write(svg)
print(f"wrote {out} ({len(svg)} bytes)", file=sys.stderr)
