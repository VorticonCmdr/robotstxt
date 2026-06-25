// chrome.storage.local helpers.
//
// In MV2 the cache lived in the background page's localStorage, keyed by
// `protocol://host` and transparently shared with popup/robots/options pages
// (same extension origin). MV3 service workers have no localStorage, so the
// cache moves to chrome.storage.local. Host entries are namespaced with an
// `r:` prefix so they can be enumerated without colliding with the `state` /
// `preferredRecordGroup` settings keys.

const CACHE_PREFIX = 'r:';

export function cacheKey(host) {
  return CACHE_PREFIX + host;
}

export function isCacheKey(key) {
  return key.startsWith(CACHE_PREFIX);
}

export function hostFromCacheKey(key) {
  return key.slice(CACHE_PREFIX.length);
}

// entry shape: { text, status, timestamp, ruleIds: number[] }
export async function getEntry(host) {
  const key = cacheKey(host);
  const result = await chrome.storage.local.get(key);
  return result[key] || null;
}

export async function setEntry(host, entry) {
  await chrome.storage.local.set({ [cacheKey(host)]: entry });
}

export async function removeEntry(host) {
  await chrome.storage.local.remove(cacheKey(host));
}

// Returns [{ host, entry }] for every cached host.
export async function getAllEntries() {
  const all = await chrome.storage.local.get(null);
  return Object.keys(all)
    .filter(isCacheKey)
    .map((key) => ({ host: hostFromCacheKey(key), entry: all[key] }));
}

export async function clearAllEntries() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(isCacheKey);
  if (keys.length) await chrome.storage.local.remove(keys);
}

// --- settings ---------------------------------------------------------------

export async function getState() {
  const { state } = await chrome.storage.local.get('state');
  // Default to enabled on first run, matching the MV2 behaviour.
  return state === undefined ? true : state;
}

export async function getPreferredAgent() {
  const { preferredRecordGroup } = await chrome.storage.local.get('preferredRecordGroup');
  return preferredRecordGroup || '*';
}

// --- DNR rule id allocation -------------------------------------------------

// Dynamic rule ids must be unique positive integers. A persisted counter hands
// out non-overlapping ranges across service-worker restarts.
//
// The counter is kept in-memory after the first read so that concurrent callers
// never race: `_nextRuleId += count` is a synchronous increment — no two callers
// can interleave between the read and write the way they could with two awaits.
let _nextRuleIdReady = null;
let _nextRuleId = 0;

export async function allocateRuleIds(count) {
  if (!_nextRuleIdReady) {
    _nextRuleIdReady = chrome.storage.local.get('nextRuleId').then(({ nextRuleId }) => {
      _nextRuleId = nextRuleId || 1;
    });
  }
  await _nextRuleIdReady;
  const start = _nextRuleId;
  _nextRuleId += count; // synchronous — no interleaving possible here
  await chrome.storage.local.set({ nextRuleId: _nextRuleId });
  const ids = [];
  for (let i = 0; i < count; i++) ids.push(start + i);
  return ids;
}
