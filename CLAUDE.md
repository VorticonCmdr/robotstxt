# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A **Manifest V3** Chrome extension that enforces `robots.txt` rules for human browser traffic:
it fetches each visited domain's `robots.txt`, and blocks requests the rules disallow.

## Build & Load

There is a build step (Vite + `@crxjs/vite-plugin`):

```bash
npm install
npm run build      # builds into dist/
npm run dev        # dev server with HMR
```

Load the **`dist/`** directory as an unpacked extension at `chrome://extensions` (Developer mode).
`manifest.json` (project root) is the CRXJS build entry; it is rewritten into `dist/manifest.json`.
`dist/` and `node_modules/` are gitignored.

## Architecture (the important part)

MV3 removed blocking `webRequest`, so blocking and observation are split across two mechanisms.
The decision model is *"install per-domain block rules ahead of the requests"*, not *"decide per
request"* as the old MV2 version did.

```
webNavigation.onBeforeNavigate → fetch robots.txt → translate to DNR dynamic rules → install
declarativeNetRequest dynamic rules  →  actually BLOCK matching requests
webRequest.onBeforeRequest (NON-blocking) → re-check with the matcher → send 'logline' → logger
```

- **Blocking = `declarativeNetRequest` dynamic rules.** `src/extract.js` enumerates the active
  agent's Allow/Disallow paths; `src/dnr.js` turns each into a DNR rule (block/allow, host pinned
  via an anchored `regexFilter`, specificity → rule `priority` so longest-match and allow-over-
  disallow win). Rules are installed per host on navigation and persist across SW restarts.
- **Decision logic = the [`google-robotstxt-parser`](https://www.npmjs.com/package/google-robotstxt-parser)
  library.** `RobotsMatcher.oneAgentAllowedByRobots(text, agent, url)` is the **authoritative**
  verdict, used by the observational logger. DNR rules are a best-effort approximation of it (they
  can diverge slightly — this is the documented trade-off of MV3). The same library's low-level
  `parseRobotsTxt`/`RobotsParseHandler` powers `src/extract.js`.
- **Logging = non-blocking `webRequest`.** `onRuleMatchedDebug` is dev-only, so the live logger is
  fed by an observer that re-runs the matcher and posts the unchanged `logline` message.

### Service worker constraints
`src/background.js` registers all listeners synchronously at the top level (they re-attach on every
wake). No decision state in globals except a small cached `enabled`/`preferredAgent` copy reloaded
from storage via `settingsReady`. The robots.txt cache lives in `chrome.storage.local` (host
entries are `r:`-prefixed: `{text, status, timestamp, ruleIds}`), since the SW has no
`localStorage`. The SW **owns all DNR mutations** — pages only read storage and send mutation
intents (`updateEntry`, `clearEntry`, `clearAll`, `state`, `userAgent`).

## File Map

| File | Role |
|---|---|
| `src/background.js` | Service worker: fetch, navigation→rules, observation→log, messages |
| `src/dnr.js` | robots paths → DNR rules; install/evict/clear (28k-rule cap, LRU eviction) |
| `src/extract.js` | Extract per-agent Allow/Disallow paths via the library's parser |
| `src/cache.js` | `chrome.storage.local` helpers + DNR rule-id allocation |
| `src/popup.js` | Action popup: toggle active/inactive, open other pages |
| `src/logger.js` | Live "block protocol" (logger.html), filterable by tab |
| `src/robots.js` | Cache viewer/editor (robots.html) |
| `src/options.js` | Pick user-agent group (options.html); clear cache |
| `*.html` (root) | Pages; load their `/src/*.js` as `<script type="module">` |

`popup.html`/`options.html` are referenced from the manifest; `logger.html`/`robots.html` are
opened at runtime via `chrome.tabs.create` and so are declared as extra inputs in `vite.config.js`.

## Status → robots-text mapping (preserved from MV2)
In `src/background.js` `fetchRobots`: `200` → body (capped 5120B); `5xx`/timeout → disallow-all;
`204`/`4xx`/other/network-error → allow-all. Cache TTL is 24h.

## Known trade-offs
- Decision runs twice (DNR blocks, matcher logs) — accepted for full logger parity.
- First-visit main_frame race: the very first request to an uncached host may land before its rules
  install; repeat visits are covered by persisted dynamic rules.
- jQuery/Bootstrap 3/Mustache are retained as npm deps (imported in pages), not rewritten.
