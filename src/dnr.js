// Translates robots.txt Allow/Disallow paths into declarativeNetRequest dynamic
// rules and keeps the dynamic rule set in sync.
//
// DNR is a *best-effort* block layer: rules are derived from the cached
// robots.txt and installed per host ahead of its requests. The observational
// webRequest logger reports the library's ground-truth verdict, so the two can
// diverge slightly — see plan trade-offs. Precedence (longest-match wins, allow
// beats disallow on a tie) is approximated by mapping pattern specificity to
// DNR rule priority; DNR already favours `allow` over `block` at equal priority.

import { extractRules } from './extract.js';
import { allocateRuleIds, getAllEntries, setEntry, removeEntry } from './cache.js';

// Stay under the 30k dynamic-rule cap with headroom for the rules we are about
// to add.
const MAX_DYNAMIC_RULES = 28000;

const RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
  'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other',
];

// Convert a robots.txt path pattern to a DNR urlFilter string.
// urlFilter uses | as left/right anchor and * as wildcard — the same semantics
// as robots.txt wildcards, so no escaping is needed. regexFilter is avoided
// entirely because Chrome caps dynamic regex rules at 1 000 (far below the
// 30k total-rule limit).
function pathToUrlFilter(key, pattern) {
  const hasEnd = pattern.endsWith('$');
  const p = hasEnd ? pattern.slice(0, -1) : pattern;
  // Left-anchor at the full origin so the filter is host-scoped.
  return '|' + key + p + (hasEnd ? '|' : '');
}

// Build DNR rules for one host. `ids` must contain one pre-allocated id per
// (disallow + allow) pattern, in that order.
export function buildRules(key, extracted, ids) {
  const rules = [];
  let i = 0;
  for (const pattern of extracted.disallow) {
    rules.push({
      id: ids[i++],
      priority: 1 + pattern.length,
      action: { type: 'block' },
      condition: { urlFilter: pathToUrlFilter(key, pattern), resourceTypes: RESOURCE_TYPES },
    });
  }
  for (const pattern of extracted.allow) {
    rules.push({
      id: ids[i++],
      priority: 1 + pattern.length,
      action: { type: 'allow' },
      condition: { urlFilter: pathToUrlFilter(key, pattern), resourceTypes: RESOURCE_TYPES },
    });
  }
  return rules;
}

async function dynamicRuleCount() {
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  return rules.length;
}

// Drop the oldest cached hosts (and their rules) until there is room for
// `incoming` more rules.
async function evictIfNeeded(incoming, keepHost) {
  let current = await dynamicRuleCount();
  if (current + incoming <= MAX_DYNAMIC_RULES) return;

  const entries = (await getAllEntries())
    .filter(({ host }) => host !== keepHost)
    .sort((a, b) => (a.entry.timestamp || 0) - (b.entry.timestamp || 0));

  const removeRuleIds = [];
  for (const { host, entry } of entries) {
    if (current + incoming <= MAX_DYNAMIC_RULES) break;
    const ids = entry.ruleIds || [];
    if (ids.length) {
      removeRuleIds.push(...ids);
      current -= ids.length;
    }
    await removeEntry(host);
  }
  if (removeRuleIds.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
  }
}

// Rebuild the dynamic rules for one host from its cached robots.txt text.
// Removes the host's previous rules, evicts old hosts if near the cap, installs
// the fresh rules, and returns the new rule ids (to be stored on the entry).
export async function rebuildHostRules({ host, key, text, agent, previousRuleIds = [] }) {
  const extracted = extractRules(text, agent);
  const count = extracted.allow.length + extracted.disallow.length;

  if (count === 0) {
    if (previousRuleIds.length) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: previousRuleIds });
    }
    return [];
  }

  await evictIfNeeded(count, host);

  const ids = await allocateRuleIds(count);
  const rules = buildRules(key, extracted, ids);
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: previousRuleIds,
    addRules: rules,
  });
  return ids;
}

// Remove every dynamic rule (used when the extension is toggled off / cache
// fully cleared).
export async function clearAllDynamicRules() {
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  if (rules.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: rules.map((r) => r.id),
    });
  }
}
