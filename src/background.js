// Service worker for the robots.txt emulator (MV3).
//
// MV3 removed blocking webRequest, so the architecture is split:
//   * declarativeNetRequest dynamic rules do the actual BLOCKING. They are
//     installed per host on navigation, ahead of the host's requests.
//   * a NON-blocking webRequest observer re-checks each request with the
//     google-robotstxt-parser matcher (the ground-truth verdict) purely to feed
//     the live-protocol LOGGER and to lazily fetch robots.txt for unseen hosts.
//
// All listeners are registered synchronously at the top level so they re-attach
// every time the ephemeral worker wakes. No decision state lives in globals
// beyond a small cached settings copy that is reloaded from chrome.storage.

import { RobotsMatcher } from 'google-robotstxt-parser';
import {
  getEntry, setEntry, getAllEntries, removeEntry, clearAllEntries,
  getState, getPreferredAgent,
} from './cache.js';
import {
  rebuildHostRules, clearAllDynamicRules,
} from './dnr.js';
import { findMatchingLine } from './extract.js';
import raceIconUrl from '../icons/icon48race.png?url';

const matcher = new RobotsMatcher();
const DAY_MS = 86400000;
const FETCH_TIMEOUT_MS = 10000;
const ALLOW_ALL = 'User-agent: *\nAllow: /';
const DISALLOW_ALL = 'User-agent: *\nDisallow: /';

// --- cached settings --------------------------------------------------------
// Avoid a storage round-trip on every observed request. Reloaded on wake and
// kept current via messages.
let enabled = true;
let preferredAgent = '*';
const settingsReady = (async () => {
  enabled = await getState();
  preferredAgent = await getPreferredAgent();
})();

// Shared fetch promises per host — all concurrent callers receive the same
// Promise so they can .then() on the real fetch completion (unlike the old
// inFlight Set which caused early-returners to miss the resolved value).
const fetchPromises = new Map();

// Requests that arrived before their host's robots.txt was cached.
// Checked retroactively once the fetch completes to detect race conditions
// where a URL should have been blocked but wasn't.
const raceQueue = new Map();
const RACE_QUEUE_CAP = 30;

// --- fetching ---------------------------------------------------------------

// Fetch robots.txt for `key` (= `protocol://host`) and map the HTTP status to
// robots text, preserving the MV2 semantics:
//   200      -> body (capped at 5120 bytes)
//   5xx      -> disallow everything
//   timeout  -> disallow everything
//   204/4xx/other/network-error -> allow everything (no robots.txt = free crawl)
async function fetchRobots(key) {
  const timestamp = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(key + '/robots.txt', { signal: controller.signal });
    clearTimeout(timer);
    let text;
    if (res.status === 200) {
      text = (await res.text()).slice(0, 500_000);
    } else if (res.status >= 500) {
      text = DISALLOW_ALL;
    } else {
      text = ALLOW_ALL;
    }
    return { text, status: res.status, timestamp };
  } catch (e) {
    clearTimeout(timer);
    const aborted = e.name === 'AbortError';
    return { text: aborted ? DISALLOW_ALL : ALLOW_ALL, status: aborted ? 666 : 667, timestamp };
  }
}

// Ensure the cache + DNR rules for `key` are present and fresh (< 24h). Fetches
// only when stale/missing; reinstalls rules from cached text if they were
// cleared (e.g. after a toggle-off). Returns the cache entry.
// All concurrent callers for the same key share the same Promise so every
// caller can .then() on the real fetch completion.
function ensureFreshRules(key) {
  if (fetchPromises.has(key)) return fetchPromises.get(key);
  const promise = (async () => {
    try {
      let entry = await getEntry(key);
      const stale = !entry || entry.text === undefined || (Date.now() - (entry.timestamp || 0) > DAY_MS);

      if (stale) {
        const fetched = await fetchRobots(key);
        const ruleIds = await rebuildHostRules({
          host: key, key, text: fetched.text, agent: preferredAgent,
          previousRuleIds: entry?.ruleIds || [],
        });
        entry = { ...fetched, ruleIds };
        await setEntry(key, entry);
      } else if (!entry.ruleIds || entry.ruleIds.length === 0) {
        const ruleIds = await rebuildHostRules({
          host: key, key, text: entry.text, agent: preferredAgent, previousRuleIds: [],
        });
        entry = { ...entry, ruleIds };
        await setEntry(key, entry);
      }
      return entry;
    } finally {
      fetchPromises.delete(key);
    }
  })();
  fetchPromises.set(key, promise);
  return promise;
}

// Injected into the affected tab to show a reload banner.
// Must be self-contained (no closure over SW variables).
function raceOverlay(blockedCount) {
  if (document.getElementById('__robotstxt_race_overlay')) return;
  const el = document.createElement('div');
  el.id = '__robotstxt_race_overlay';
  el.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
    'background:#7c2d12', 'color:#fff',
    'font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    'padding:10px 16px', 'display:flex', 'align-items:center', 'gap:10px',
    'box-shadow:0 2px 8px rgba(0,0,0,.4)',
  ].join(';');
  const msg = document.createElement('span');
  msg.style.flex = '1';
  msg.innerHTML = '<strong>⚠ robots.txt emulator:</strong> '
    + blockedCount + ' request' + (blockedCount !== 1 ? 's' : '')
    + ' bypassed blocking (robots.txt was not cached yet). '
    + '<strong>Reload to enforce rules.</strong>';
  const mk = (label, primary) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'border-radius:4px;padding:4px 12px;font-size:13px;'
      + 'cursor:pointer;flex-shrink:0;border:none;'
      + (primary
        ? 'background:#fff;color:#7c2d12;font-weight:700;'
        : 'background:transparent;color:#fff;border:1px solid rgba(255,255,255,.5);');
    return b;
  };
  const reload  = mk('Reload', true);
  const dismiss = mk('✕', false);
  reload.addEventListener('click',  () => window.location.reload());
  dismiss.addEventListener('click', () => el.remove());
  el.append(msg, reload, dismiss);
  document.documentElement.appendChild(el);
}

// After a robots.txt fetch completes, retroactively check requests that
// arrived before the rules were installed. Sends 'robots-race' loglines for
// any URL that should have been blocked, updates the extension icon, and
// injects a reload banner into the affected tab(s).
async function processRaceQueue(key, entry) {
  const queued = raceQueue.get(key);
  raceQueue.delete(key);
  if (!queued || queued.length === 0) return;

  // blocked URLs grouped by tabId for the banner injection
  const blockedPerTab = new Map();

  for (const req of queued) {
    const allowed = matcher.oneAgentAllowedByRobots(entry.text, preferredAgent, req.url);
    if (allowed) continue;

    const line = entry.status === 200
      ? findMatchingLine(entry.text, preferredAgent, req.url)
      : null;

    const sendLog = (tabTitle, tabUrl) => {
      chrome.runtime.sendMessage({
        type: 'logline',
        url: req.url, method: req.method, resourceType: req.type,
        reason: 'robots-race', line,
        referrer: req.initiator || tabUrl || '',
        timestamp: req.timestamp, tabId: req.tabId, tabTitle, tabUrl,
      }).catch(() => {});
    };

    if (req.tabId >= 0) {
      try { const tab = await chrome.tabs.get(req.tabId); sendLog(tab.title, tab.url); }
      catch { sendLog(undefined, undefined); }
      const prev = blockedPerTab.get(req.tabId) || 0;
      blockedPerTab.set(req.tabId, prev + 1);
    } else {
      sendLog(undefined, undefined);
    }
  }

  if (blockedPerTab.size === 0) return;

  chrome.action.setIcon({ path: raceIconUrl });

  for (const [tabId, count] of blockedPerTab) {
    chrome.scripting.executeScript({
      target: { tabId },
      func: raceOverlay,
      args: [count],
    }).catch(() => {}); // tab may have navigated away already
  }
}

// Rebuild every cached host's rules for the current agent (after an agent
// change), or clear them all (on toggle-off).
async function rebuildAllHosts() {
  const entries = await getAllEntries();
  for (const { host, entry } of entries) {
    const ruleIds = await rebuildHostRules({
      host, key: host, text: entry.text, agent: preferredAgent,
      previousRuleIds: entry.ruleIds || [],
    });
    await setEntry(host, { ...entry, ruleIds });
  }
}

async function disableAll() {
  await clearAllDynamicRules();
  // Drop stale rule-id references so rules get reinstalled when re-enabled.
  const entries = await getAllEntries();
  for (const { host, entry } of entries) {
    if (entry.ruleIds && entry.ruleIds.length) await setEntry(host, { ...entry, ruleIds: [] });
  }
}

// --- navigation: install rules ahead of requests ---------------------------

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  await settingsReady;
  if (!enabled) return;
  let url;
  try { url = new URL(details.url); } catch { return; }
  if (!url.protocol.startsWith('http')) return;
  await ensureFreshRules(url.protocol + '//' + url.host);
});

// --- observation: log blocked requests (non-blocking) ----------------------

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    (async () => {
      await settingsReady;
      if (!enabled) return;

      let url;
      try { url = new URL(details.url); } catch { return; }
      if (url.protocol === 'chrome-extension:') return;
      if (!url.protocol.startsWith('http')) return;
      if (url.pathname === '/robots.txt') return;

      const key = url.protocol + '//' + url.host;
      const entry = await getEntry(key);
      if (!entry || entry.text === undefined) {
        // Queue for retroactive race-condition checking once the fetch completes.
        if (!raceQueue.has(key)) raceQueue.set(key, []);
        const q = raceQueue.get(key);
        if (q.length < RACE_QUEUE_CAP) {
          q.push({
            url: details.url, method: details.method, type: details.type,
            tabId: details.tabId, timestamp: Date.now(), initiator: details.initiator,
          });
        }
        ensureFreshRules(key).then(e => { if (e) processRaceQueue(key, e); });
        return;
      }

      const allowed = matcher.oneAgentAllowedByRobots(entry.text, preferredAgent, details.url);
      if (allowed) return;

      const reason = entry.status === 200 ? 'robots-disallow' : 'robots-unavailable';
      const line = entry.status === 200
        ? findMatchingLine(entry.text, preferredAgent, details.url)
        : null;

      const log = (tabTitle, tabUrl) => {
        chrome.runtime.sendMessage({
          type: 'logline',
          url: details.url,
          method: details.method,
          resourceType: details.type,
          reason,
          line,
          referrer: details.initiator || tabUrl || '',
          timestamp: Date.now(),
          tabId: details.tabId,
          tabTitle,
          tabUrl,
        }).catch(() => {}); // logger page may not be open
      };

      if (details.tabId >= 0) {
        try {
          const tab = await chrome.tabs.get(details.tabId);
          log(tab.title, tab.url);
        } catch {
          log(undefined, undefined);
        }
      } else {
        log(undefined, undefined);
      }
    })();
  },
  { urls: ['<all_urls>'] },
); // NOTE: no 'blocking' — MV3 forbids it; this listener only observes.

// --- messages ---------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg) => {
  (async () => {
    await settingsReady;
    if (msg.type === 'state') {
      enabled = !!msg.state;
      await chrome.storage.local.set({ state: enabled });
      if (enabled) {
        await rebuildAllHosts();
      } else {
        await disableAll();
      }
    } else if (msg.type === 'userAgent') {
      preferredAgent = (msg.state || '*');
      await chrome.storage.local.set({ preferredRecordGroup: preferredAgent });
      if (enabled) await rebuildAllHosts();
    } else if (msg.type === 'updateEntry' && msg.host) {
      // Manual edit from the cache editor (robots.html). The SW owns DNR, so it
      // does the storage write and rule rebuild atomically.
      const prev = await getEntry(msg.host);
      const entry = { text: msg.text || '', status: 999, timestamp: Date.now(), ruleIds: [] };
      const ruleIds = await rebuildHostRules({
        host: msg.host, key: msg.host, text: entry.text, agent: preferredAgent,
        previousRuleIds: prev?.ruleIds || [],
      });
      await setEntry(msg.host, { ...entry, ruleIds });
    } else if (msg.type === 'refetchEntry' && msg.host) {
      // Force a fresh network fetch: remove the cached entry so ensureFreshRules
      // sees it as missing and fetches unconditionally.
      await removeEntry(msg.host);
      await ensureFreshRules(msg.host);
    } else if (msg.type === 'clearEntry' && msg.host) {
      const prev = await getEntry(msg.host);
      await rebuildHostRules({
        host: msg.host, key: msg.host, text: '', agent: preferredAgent,
        previousRuleIds: prev?.ruleIds || [],
      });
      await removeEntry(msg.host);
    } else if (msg.type === 'clearAll') {
      await clearAllDynamicRules();
      await clearAllEntries();
    }
  })();
});
