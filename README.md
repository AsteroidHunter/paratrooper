# Paratrooper

An agent you message from your phone that edits a repo for you and ships the
change as a reviewable PR. Use case #1: the polaroid pinboard on
**theonetrueakash.com** — send a photo, link, or song plus a caption, have a
conversation about what to change, and the agent creates / archives / replaces
a "pin," places it sensibly (no overlaps), commits to a branch, screenshots the
board, and asks you to publish.

```
 Phone (PWA, "Add to Home Screen")
   │  WebSocket  +  web push (closed-app)
   ▼
 Render — WEB service     ── holds the socket, serves the PWA, gates auth,
   │   (FastAPI)              runs /publish (MERGE AUTHORITY lives here)
   │  job via Render Key Value queue
   ▼
 Render — WORKER service  ── Claude Agent SDK (headless) + placement engine +
   (Python)                  Playwright screenshot + git. Pushes BRANCHES only.
   ▼
 GitHub (website repo) ──► branch + PR ──► (you tap Publish) ──► web merges
```

## Layout

| Path | What |
|------|------|
| `src/paratrooper/placement/` | **Phase 2** — deterministic placement + sizing engine (scipy/numpy/PIL). Alpha-aware occupancy → EDT feasibility → balance/rhythm objective → grid search. No vision model; the chat loop is the aesthetic judge. |
| `src/paratrooper/agent/` | **Phase 3** — Claude Agent SDK worker: tools, system prompt, `main`-boundary hook, two-tier memory, paths config, site-repo checkout. |
| `src/paratrooper/web/` | **Phase 4** — FastAPI web service: PWA host, token auth, image upload, SQLite threads, WebSocket + Key Value queue, message batching, `/publish` merge authority. |
| `pwa/` | **Phase 4** — TypeScript PWA chat client (vite). |
| `render.yaml` | **Phase 5** — Render blueprint: web + worker + keyvalue + persistent disk. |
| `config/` | Paths config (folders only): `inbox`, `pins_dir`, `archive_dir`. |
| `tests/` | Engine unit tests on synthetic boards. |

## Secrets

Secrets are **environment variables, never a config file**: the shared app
bearer token, GitHub PAT/App, `CLAUDE_CODE_OAUTH_TOKEN`, Spotify id/secret,
VAPID keypair. See `.env.example`.

## Dev

```bash
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"        # placement engine + tests
.venv/bin/pytest                          # run the engine tests
```

Install service extras as needed: `.venv/bin/pip install -e ".[agent,web,dev]"`.
