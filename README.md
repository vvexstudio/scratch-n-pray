# Scratch & Pray

A satirical scratch-off lottery for basic needs. Tell the city what you need, buy a ticket, scratch the foil. 1 in 10 tickets actually solves your problem. The other 9 are monkey's paws.

## Run

```bash
npm run dev     # node --watch server.js → http://localhost:5177
```

No dependencies. Needs Node 18+ and `OPENAI_API_KEY` in `.env`.

## Pipeline

```
prayer ─▶ RNG (crypto.randomInt, 1 in SP_JACKPOT_ODDS) ─▶ text model writes prize JSON ─▶ image model paints ticket art ─▶ UI
```

1. **`POST /api/pray`** (`server.js` locally, `functions/api/pray.js` on Cloudflare; both call `lib/pipeline.js`): `{ prayer }`. The server rolls the jackpot, so the client can't cheat.
2. **Prize writer**: `SP_TEXT_MODEL` with a strict JSON schema returns `category, game_name, headline, prize, description, fine_print, real_help, crisis, symbols, card_theme`. The tone rules live in `SYSTEM_PROMPT`.
3. **Ticket art**: `SP_IMAGE_MODEL` at 1024×1536 renders an ornate border with an empty central window. The prompt asks for the window at about 41–78% of the height.
4. **UI** (`public/index.html`): finds the blank window in the art (`findWindow`, which looks for a flat or transparent region, because the model moves it around), puts the prize panel and a canvas foil layer there, and auto-reveals once about 55% of the foil is scratched. Includes scratch sound, haptics, confetti on a jackpot, a "for real, though" line pointing to a real resource, and 988 when `crisis` is true.

Every ticket is saved to `generated/<id>.json` and `.png`.

## Dev knobs

| URL param | Effect |
|---|---|
| `?force=win` / `?force=lose` | Override the RNG |
| `?art=0` | Skip image generation (fast and cheap text-only iteration) |
| `?replay=<id>` | Re-render a saved ticket from `generated/`, no API calls |

| Env | Default |
|---|---|
| `SP_TEXT_MODEL` | `gpt-5.4-mini` |
| `SP_IMAGE_MODEL` | `gpt-image-1.5` |
| `SP_IMAGE_QUALITY` | `medium` (`low` is faster and cheaper) |
| `SP_JACKPOT_ODDS` | `10` |
| `PORT` | `5177` |

It's a PWA (manifest and service worker), so on a phone you can use "Add to Home Screen". The phone has to reach the server over LAN or a tunnel.

## Deploy (Cloudflare Pages)

Live at **https://scratch-n-pray.pages.dev**. The UI is static files from `public/`. The API is Pages Functions in `functions/`, which uses the same `lib/pipeline.js` as the local server. Config lives in `wrangler.toml`.

```bash
npm run deploy                 # manual deploy; pushes to main deploy automatically via GitHub Actions
npm run cf:dev                 # local Cloudflare build on :8788 (simulated R2, key from .dev.vars)
```

- **Secret:** `OPENAI_API_KEY`, set once with `npx wrangler pages secret put OPENAI_API_KEY --project-name scratch-n-pray`.
- **R2:** `scratch-n-pray` holds the public ticket art and records (served at `/generated/*`). `scratch-n-pray-raw` is private: request logs with a hashed IP under `log/<day>/`, plus the rate-limit and budget counters under `limits/<day>/`.
- **Guard rails:** 3 tickets per minute and 12 per day per IP. Estimated spend is counted against `DAILY_BUDGET_USD`. Once it passes the cap, tickets come without art. At 1.2× the cap, the booth closes until midnight UTC. The counters live in R2, so they're approximate under heavy concurrency, which is fine for a demo.
