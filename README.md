# Elliptic Curve Rank Leaderboard

Source code for [elliptic-rank.icarm.cloud](https://elliptic-rank.icarm.cloud).

Runs on [Cloudflare Workers](https://developers.cloudflare.com/workers/),
using a WASM build of PARI/GP (2.17.2, built from upstream sources by
`scripts/build-pari-wasm.sh`; the module and its emscripten glue are
committed as `src/gp-sta.wasm` + `src/gp-sta.js`).
