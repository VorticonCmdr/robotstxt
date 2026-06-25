# robots.txt emulator

A Chrome extension (Manifest V3) that enforces `robots.txt` rules for normal browser traffic. On first visit to any domain it fetches that domain's `robots.txt`, then blocks every request the rules disallow — exactly as a crawler would.

---

## Table of contents

1. [Motivation](#motivation)
2. [Features](#features)
3. [Architecture](#architecture)
   - [Why two mechanisms?](#why-two-mechanisms)
   - [Blocking via declarativeNetRequest](#blocking-via-declarativenetrequest)
   - [Logging via webRequest](#logging-via-webrequest)
   - [The service worker](#the-service-worker)
   - [Storage](#storage)
4. [File map](#file-map)
5. [Development and build](#development-and-build)
6. [Loading the extension](#loading-the-extension)
7. [Usage](#usage)
   - [Popup](#popup)
   - [Live log](#live-log)
   - [robots.txt cache](#robotstxt-cache)
   - [Options](#options)
8. [Known limitations](#known-limitations)

---

## Motivation

`robots.txt` is a convention for web crawlers: site operators declare which paths automated programs should not access. Browsers don't obey it — they are not crawlers. This extension closes that gap: it reads `robots.txt` like a crawler and blocks exactly the paths marked `Disallow`.

Useful when you want to:
- test your own `robots.txt` before a crawler evaluates it,
- understand which parts of a site are off-limits to bots,
- deliberately make your browser behave like a specific bot (e.g. Googlebot).

---

## Features

- **Automatic fetching** of `robots.txt` on first visit to any domain. Results are cached for 24 hours (up to 500 KB per file).
- **Real blocking** via Chrome DNR rules (`declarativeNetRequest`): disallowed URLs are cancelled by the browser before the request reaches the network.
- **Selectable user-agent**: defaults to the `*` group; can be switched to `Googlebot` or any custom agent string in the options.
- **Live log**: shows blocked requests in real time — with tab filter, columns for method, type, reason, and referrer, and a clickable link to the exact `robots.txt` line that triggered the block.
- **robots.txt cache editor**: displays and edits the cached `robots.txt` of every visited domain, with an annotated inline-editable view, tab filter, search field, and URL tester.
- **Blocking checkbox**: blocking can be toggled off in the popup; all DNR rules are removed and instantly reinstalled when re-enabled.
- **Race condition detection**: when a URL should have been blocked but wasn't because `robots.txt` wasn't cached yet, the extension retroactively detects this, logs it as `robots-race`, changes the extension icon, and shows a reload banner on the affected tab.
- **Persistence across browser restarts**: DNR rules survive service worker restarts — no data is lost on wake.

---

## Architecture

### Why two mechanisms?

Manifest V3 removed blocking `webRequest` (`["blocking"]`). Blocking now requires declarative rules (`declarativeNetRequest`, DNR for short), installed *in advance* and evaluated without JavaScript. This has consequences:

| Aspect | Manifest V2 (old) | Manifest V3 (now) |
|--------|-------------------|-------------------|
| Blocking | `webRequest` with `["blocking"]` — per request, in JS | `declarativeNetRequest` — declarative rules, before the request |
| Decision | Single `canVisit(url)` call in the background | Rules installed per domain ahead of requests |
| Logger | Directly in the blocking listener | Separate non-blocking `webRequest` observer |
| Background | Persistent background page | Ephemeral service worker |

The extension therefore uses **two channels in parallel**:

```
Navigation → fetch robots.txt → install DNR rules → Chrome blocks requests
                                                     ↓
                     non-blocking webRequest observer → logger (live log)
```

### Blocking via declarativeNetRequest

`src/dnr.js` translates `robots.txt` paths into DNR rules:

- Each `Disallow:` path becomes a `block` rule.
- Each `Allow:` path becomes an `allow` rule.
- `urlFilter` is used instead of `regexFilter` (RE2) — Chrome caps dynamic regex rules at 1,000; `urlFilter` has no such sub-limit. The `urlFilter` format (`|` = left/right anchor, `*` = wildcard) covers all required robots.txt patterns exactly.
- **Priority** is `1 + pattern length`: longer (more specific) patterns win. At equal priority DNR already favours `allow` over `block`, which mirrors the robots.txt convention (Allow beats Disallow at equal specificity).
- Rules are installed per domain via `chrome.declarativeNetRequest.updateDynamicRules` and survive service worker restarts.
- The dynamic rule cap is 30,000; the extension stays under 28,000 and evicts the least-recently-used domains when necessary.

### Logging via webRequest

`src/background.js` registers a **non-blocking** `webRequest.onBeforeRequest` listener that:

1. Loads the cached `robots.txt` text for the domain.
2. Calls `RobotsMatcher.oneAgentAllowedByRobots(text, agent, url)` from the [`google-robotstxt-parser`](https://www.npmjs.com/package/google-robotstxt-parser) library — the authoritative decision (Google's C++ parser, ported to JS).
3. If the URL should be blocked, `findMatchingLine()` (from `src/extract.js`) determines the exact line number of the triggering `Disallow` rule and sends a `logline` message with all details (URL, method, resource type, reason, line number, referrer) to the live log.

This listener cannot cancel requests (no `["blocking"]`). Actual blocking is done exclusively by DNR. The observer is used only for logging and lazy-fetching unseen domains.

The decision is therefore made **twice**: DNR (approximate, declarative) and the matcher (ground truth, for the logger). Minor divergences are a documented trade-off.

### The service worker

`src/background.js` is the service worker. It:

- Registers **all listeners synchronously at startup** (top-level) so they are active immediately after every SW wake.
- Keeps a small in-memory shadow of `enabled` and `preferredAgent`, reloaded from `chrome.storage.local` on wake via the `settingsReady` promise.
- **Owns all DNR mutations**: pages (popup, cache editor, options) send intent messages; the SW performs storage writes and DNR rule updates atomically.
- Deduplicates concurrent fetches for the same domain using a `fetchPromises` map so all concurrent callers share the same promise and are notified when the fetch completes.

**HTTP status → robots.txt text** (semantics preserved from MV2):

| HTTP status | Result |
|-------------|--------|
| `200` | Body (capped at 500,000 bytes / 500 KB) |
| `5xx` / timeout | `Disallow: /` (block everything) |
| `204`, `4xx`, network error | `Allow: /` (allow everything) |

### Storage

All data lives in `chrome.storage.local`:

| Key | Contents |
|-----|----------|
| `r:<protocol://host>` | `{ text, status, timestamp, ruleIds: number[] }` — one entry per domain |
| `state` | `true` / `false` — extension active or not |
| `preferredRecordGroup` | Selected user-agent, e.g. `*` or `googlebot` |
| `nextRuleId` | Monotonically increasing counter for DNR rule IDs |
| `loggerFocusTab` | Last active tab ID from the popup (for logger tab sync) |

The `r:` prefix separates domain entries from settings keys.

---

## File map

```
manifest.json          Manifest V3 (CRXJS build entry point)
vite.config.js         Vite + CRXJS plugin configuration
package.json           npm dependencies and build scripts

src/
  background.js        Service worker: fetch, navigation→rules, observer→logger, messages
  dnr.js               robots.txt paths → DNR rules (urlFilter); install / evict / clear
  extract.js           Allow/Disallow paths + findMatchingLine() from robots.txt
  cache.js             chrome.storage.local helpers + DNR rule ID allocation
  popup.js             Action popup: blocking checkbox, navigation to other pages
  logger.js            Live block log (logger.html)
  robots.js            Cache viewer / editor (robots.html)
  options.js           User-agent selection + cache clear (options.html)

popup.html             Popup (referenced from manifest.json)
options.html           Options page (referenced from manifest.json)
logger.html            Live log (opened at runtime)
robots.html            Cache editor (opened at runtime)

icons/                 PNG icons in various sizes
dist/                  Build output (load this as the unpacked extension)
```

---

## Development and build

**Prerequisites:** Node.js ≥ 18, npm

```bash
# Install dependencies
npm install

# Production build (creates / updates dist/)
npm run build

# Development server with HMR (Hot Module Replacement)
npm run dev
```

The build uses [Vite](https://vite.dev) with the [@crxjs/vite-plugin](https://crxjs.dev/vite-plugin). The plugin reads `manifest.json` as the build entry point and bundles the service worker and all HTML pages including their npm imports automatically.

`logger.html` and `robots.html` are not referenced from the manifest (they are opened at runtime via `chrome.tabs.create`) and are therefore declared explicitly as `rollupOptions.input` in `vite.config.js`.

---

## Loading the extension

1. Run `npm run build` (once, or after any code change).
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top right).
4. Click **"Load unpacked"** and select the **`dist/`** directory.
5. The extension appears with its robot icon in the toolbar.

After code changes, re-run `npm run build` and click the **reload** button (↺) on the extensions page.

---

## Usage

### Popup

Click the extension icon in the toolbar to open the popup.

| Element | Function |
|---------|----------|
| **Blocking** (checkbox) | Toggle blocking on/off. When disabled all DNR rules are removed; re-enabling reinstalls them immediately. The icon switches between colour (active) and grey (inactive). |
| **live protocol** | Opens the live log in a new tab. The current tab is automatically pre-selected in the log. |
| **robots.txt cache** | Opens the cache editor in a new tab. |
| **options** | Opens the options page in a new tab. |

### Live log

`logger.html` — shows all requests identified as blocked in real time. Dark theme, full window width.

**Table columns:**

| Column | Contents |
|--------|----------|
| Time | Request time (HH:MM:SS) |
| Method | HTTP method (GET, POST, …) |
| URL | Full blocked URL |
| Type | Resource type as a colour-coded badge (document, script, xhr, image, …) |
| Reason | `robots-disallow` (Disallow rule matched), `robots-unavailable` (robots.txt unreachable → everything blocked), or `robots-race` (URL should have been blocked but bypassed due to missing cache — shown in orange) |
| Line | Line number of the triggering Disallow rule in `robots.txt` — clickable, opens the cache editor at that exact line |
| Referrer | Origin of the initiating request |

**Controls:**
- **Clear display**: empties the displayed table (in-memory entries are also cleared).
- **Download JSON**: exports all logged entries as a JSON file.
- **Tab selector** (top right): filters the view to a specific tab. Automatically set to the active tab when the popup is opened.

Newest entries appear at the top. Reloading the page clears the table.

### robots.txt cache

`robots.html` — manages the local `robots.txt` cache with an annotated, directly editable view. Light theme.

**Controls:**

- **Tab selector**: filters the host list to domains visible on the selected tab. "all tabs" shows every cached domain.
- **Search field** (with datalist autocomplete): selects the desired host. With a tab filter, a unique match is loaded automatically.
- **(Re)fetch**: forces a fresh network fetch for the current host; rules are reinstalled when the response arrives. The view updates automatically.
- **Clear selected**: deletes the entry and all its blocking rules. The next visit re-fetches `robots.txt`.
- **Clear all**: deletes all cached entries and all DNR rules.

**Annotated view:**

- Each line shows a line number, a colour-coded indicator, and the line text.
- `Allow` rules are highlighted green, `Disallow` rules red; typos and unrecognised directives get warning badges.
- Lines are **directly editable** (no separate text editor): click any line and type. Enter inserts a new line, Backspace at the start of a line merges it with the previous one. Multi-line paste is handled correctly.
- Indicators and badges update live as you type.
- Every edit is auto-saved 300 ms after the last keystroke.

**URL tester** (bottom bar):

- Enter a URL (e.g. `https://example.com/admin/`) for an instant **ALLOWED** / **BLOCKED** result.
- Optional agent field: test with a different user-agent than the one set in options.
- The triggering line is highlighted green in the annotated view.

**Deep links:**

The page supports direct linking via URL parameters:
- `robots.html?host=https://example.com` — loads that host's entry directly.
- `robots.html?host=https://example.com&line=42` — loads the entry and scrolls to line 42 (used by the live log).

### Options

`options.html` — two settings:

**Preferred user-agent**

Determines which user-agent group from `robots.txt` is evaluated:

- `*` (default): the catch-all group, applies to all bots not named explicitly.
- `googlebot` (preset): Googlebot-specific rules. If a `robots.txt` has no Googlebot section, the `*` group is used as fallback.
- Any custom string can be typed in the field.

Changing the agent immediately triggers a rule rebuild for all cached domains.

**Clear all cached robots.txt**

Deletes all cached entries and DNR rules — identical to "Clear all" in the cache editor.

---

## Known limitations

**First-visit race condition**
MV3 provides no mechanism to pause a request until rules are installed. On the very first visit to a domain the `main_frame` request may arrive before the DNR rules are set up. The extension detects this retroactively: requests that should have been blocked are logged as `robots-race`, the extension icon changes, and a reload banner is shown on the affected tab. All subsequent visits are covered by persisted rules.

**DNR approximation vs. matcher ground truth**
DNR rules are a best-effort translation of `robots.txt` patterns into `urlFilter` expressions. The final decision in the live log is made by `RobotsMatcher.oneAgentAllowedByRobots()` — Google's official implementation. In rare edge cases the DNR block and the matcher result can diverge slightly.

**HTTP/HTTPS only**
`robots.txt` is defined for web traffic. `chrome-extension://`, `file://`, and other schemes are ignored.

**Cache TTL: 24 hours**
Changes to `robots.txt` on the server take effect only after 24 hours or a manual cache clear.

**DNR rule cap**
Chrome allows at most 30,000 dynamic rules in total. The extension reserves 2,000 as headroom and evicts the least-recently-used domains when approaching the cap. For users who visit very many domains with long `robots.txt` files, older entries may be automatically removed from the blocking rule set (the cache entry itself is retained).
