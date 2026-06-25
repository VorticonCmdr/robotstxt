import { getAllEntries, getEntry, getPreferredAgent } from './cache.js';
import { RobotsMatcher } from 'google-robotstxt-parser';
import { findMatchingLine } from './extract.js';

const matcher = new RobotsMatcher();

// ── Annotation helpers ─────────────────────────────────────────────────────

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const dp = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[a.length][b.length];
}

const CORE_DIRECTIVES = ['user-agent', 'allow', 'disallow', 'sitemap', 'crawl-delay'];
const GOOGLE_IGNORED = new Set([
  'crawl-delay', 'host', 'noindex', 'noarchive', 'nosnippet',
  'noodp', 'noydir', 'clean-param', 'request-rate', 'visit-time',
]);
const IND_MAP = {
  useragent:    { ch: '●', color: '#1a73e8' },
  allow:        { ch: '●', color: '#16a34a' },
  disallow:     { ch: '●', color: '#c0392b' },
  sitemap:      { ch: '●', color: '#999' },
  ignored:      { ch: '▲', color: '#b45309' },
  typo:         { ch: '●', color: '#c0392b' },
  unrecognised: { ch: '!', color: '#b45309' },
};

function classifyLine(text) {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('#')) return { kind: 'empty' };
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx === -1) return { kind: 'unrecognised' };
  const directive = trimmed.slice(0, colonIdx).trim().toLowerCase();
  if (directive === 'user-agent') return { kind: 'useragent' };
  if (directive === 'allow')      return { kind: 'allow' };
  if (directive === 'disallow')   return { kind: 'disallow' };
  if (directive === 'sitemap')    return { kind: 'sitemap' };
  if (GOOGLE_IGNORED.has(directive)) return { kind: 'ignored', directive };
  for (const known of CORE_DIRECTIVES) {
    const d = editDistance(directive, known);
    if (d > 0 && d <= 2) {
      return { kind: 'typo', suggestion: known.replace(/(^|-)(\w)/g, (_, s, c) => s + c.toUpperCase()) };
    }
  }
  return { kind: 'unrecognised' };
}

// ── DOM refs ───────────────────────────────────────────────────────────────

const tabSelect       = document.getElementById('tabSelect');
const hostSearch      = document.getElementById('hostSearch');
const hostDatalist    = document.getElementById('hostDatalist');
const textarea        = document.getElementById('robotstxt'); // hidden backing store
const annotationLines = document.getElementById('annotationLines');
const annErrors       = document.getElementById('annErrors');
const annWarnings     = document.getElementById('annWarnings');
const btnUpdate       = document.getElementById('btnUpdate');
const btnClear        = document.getElementById('btnClear');
const btnClearAll     = document.getElementById('btnClearAll');
const urlInput        = document.getElementById('urlInput');
const agentInput      = document.getElementById('agentInput');
const testerResult    = document.getElementById('testerResult');
const testerInfo      = document.getElementById('testerInfo');

// ── State ──────────────────────────────────────────────────────────────────

let allEntries  = [];
let tabOrigins  = new Set();
let currentHost = null;
let matchedLine = null;
let partialTimer = null;

// ── Cursor helpers ─────────────────────────────────────────────────────────

function focusSpanAt(span, offset) {
  span.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  const node = span.firstChild;
  if (node && node.nodeType === Node.TEXT_NODE) {
    range.setStart(node, Math.min(offset, node.length));
  } else {
    range.setStart(span, 0);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function getCursorState() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const node = range.startContainer;
  const span = (node.nodeType === Node.TEXT_NODE ? node.parentElement : node)
    ?.closest?.('.ann-text');
  if (!span) return null;
  const row = span.closest('.ann-line');
  return { lineIdx: parseInt(row?.dataset.line ?? '1') - 1, offset: range.startOffset };
}

// ── Sync span contents → hidden textarea ──────────────────────────────────

function syncToTextarea() {
  const spans = annotationLines.querySelectorAll('.ann-text');
  textarea.value = Array.from(spans).map(s => s.textContent).join('\n');
}

// ── Partial re-render: update only decorations, leave text alone ───────────

function partialRerender() {
  const rows = annotationLines.querySelectorAll('.ann-line');
  let errors = 0, warnings = 0;
  rows.forEach(row => {
    const textSpan = row.querySelector('.ann-text');
    const lineNum  = parseInt(row.dataset.line);
    if (!textSpan) return;
    const cl = classifyLine(textSpan.textContent);
    if (cl.kind === 'typo') errors++;
    else if (cl.kind === 'ignored' || cl.kind === 'unrecognised') warnings++;

    // indicator
    const indEl = row.querySelector('.ann-ind');
    if (indEl) {
      const ind = IND_MAP[cl.kind];
      indEl.textContent = ind ? ind.ch : '';
      indEl.style.color = ind ? ind.color : '';
    }
    // row classes
    row.classList.toggle('ann-err-line', cl.kind === 'typo');
    row.classList.toggle('ann-matched', lineNum === matchedLine);
    // text color
    textSpan.style.color =
      cl.kind === 'unrecognised' ? '#b45309' :
      cl.kind === 'typo'         ? '#c0392b' : '#222';
    // badge
    row.querySelector('.ann-badge')?.remove();
    const [badgeText, badgeCls] = badgeFor(cl, lineNum);
    if (badgeText) {
      const b = document.createElement('span');
      b.className = `ann-badge ${badgeCls}`;
      b.textContent = badgeText;
      row.appendChild(b);
    }
  });
  setCountBadges(errors, warnings);
}

function badgeFor(cl, lineNum) {
  if (cl.kind === 'typo')         return ['typo', 'badge-error'];
  if (cl.kind === 'ignored')      return ['ignored by Google', 'badge-warn'];
  if (cl.kind === 'unrecognised') return ['unrecognised', 'badge-warn'];
  if (lineNum === matchedLine)
    return cl.kind === 'allow'
      ? ['Allow rule', 'badge-allow-rule']
      : ['Disallow rule', 'badge-disallow-rule'];
  return [null, null];
}

function setCountBadges(errors, warnings) {
  annErrors.textContent  = `● ${errors} Error${errors !== 1 ? 's' : ''}`;
  annErrors.style.display  = errors  ? '' : 'none';
  annWarnings.textContent = `▲ ${warnings} Warning${warnings !== 1 ? 's' : ''}`;
  annWarnings.style.display = warnings ? '' : 'none';
}

// ── Full re-render: replace entire DOM ────────────────────────────────────

function fullRerender(focusState = null) {
  const lines  = textarea.value ? textarea.value.split('\n') : [];
  let errors = 0, warnings = 0;
  const frag = document.createDocumentFragment();

  lines.forEach((line, i) => {
    const lineNum = i + 1;
    const cl = classifyLine(line);
    if (cl.kind === 'typo') errors++;
    else if (cl.kind === 'ignored' || cl.kind === 'unrecognised') warnings++;

    const row = document.createElement('div');
    row.className = 'ann-line';
    row.dataset.line = lineNum;
    if (lineNum === matchedLine)  row.classList.add('ann-matched');
    if (cl.kind === 'typo')       row.classList.add('ann-err-line');

    const numEl = document.createElement('span');
    numEl.className = 'ann-num';
    numEl.textContent = lineNum;
    row.appendChild(numEl);

    const indEl = document.createElement('span');
    indEl.className = 'ann-ind';
    const ind = IND_MAP[cl.kind];
    if (ind) { indEl.textContent = ind.ch; indEl.style.color = ind.color; }
    row.appendChild(indEl);

    const textEl = document.createElement('span');
    textEl.className = 'ann-text';
    textEl.contentEditable = 'plaintext-only';
    textEl.spellcheck = false;
    textEl.setAttribute('data-gramm', 'false'); // disable Grammarly
    textEl.textContent = line;
    if (cl.kind === 'unrecognised') textEl.style.color = '#b45309';
    if (cl.kind === 'typo')         textEl.style.color = '#c0392b';
    textEl.addEventListener('input',   onSpanInput);
    textEl.addEventListener('keydown', onSpanKeydown);
    textEl.addEventListener('paste',   onSpanPaste);
    row.appendChild(textEl);

    const [badgeText, badgeCls] = badgeFor(cl, lineNum);
    if (badgeText) {
      const b = document.createElement('span');
      b.className = `ann-badge ${badgeCls}`;
      b.textContent = badgeText;
      row.appendChild(b);
    }

    frag.appendChild(row);
  });

  annotationLines.innerHTML = '';
  annotationLines.appendChild(frag);
  setCountBadges(errors, warnings);

  if (focusState) {
    const spans = annotationLines.querySelectorAll('.ann-text');
    const target = spans[focusState.lineIdx];
    if (target) focusSpanAt(target, focusState.offset);
  }
  if (matchedLine) {
    annotationLines.querySelector(`[data-line="${matchedLine}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

// ── Editing event handlers ─────────────────────────────────────────────────

function autoSave() {
  if (!currentHost) return;
  chrome.runtime.sendMessage({ type: 'updateEntry', host: currentHost, text: textarea.value });
}

function onSpanInput() {
  syncToTextarea();
  clearTimeout(partialTimer);
  partialTimer = setTimeout(() => { partialRerender(); runTester(); autoSave(); }, 300);
}

function onSpanKeydown(e) {
  const span   = e.currentTarget;
  const rows   = Array.from(annotationLines.querySelectorAll('.ann-line'));
  const rowIdx = rows.indexOf(span.closest('.ann-line'));
  const lines  = textarea.value.split('\n');

  if (e.key === 'Enter') {
    e.preventDefault();
    const cursor = getCursorState();
    const off    = cursor?.offset ?? lines[rowIdx]?.length ?? 0;
    const line   = lines[rowIdx] ?? '';
    lines[rowIdx] = line.slice(0, off);
    lines.splice(rowIdx + 1, 0, line.slice(off));
    textarea.value = lines.join('\n');
    fullRerender({ lineIdx: rowIdx + 1, offset: 0 });
    return;
  }

  if (e.key === 'Backspace') {
    const sel = window.getSelection();
    if (sel?.isCollapsed && sel.anchorOffset === 0 && rowIdx > 0) {
      e.preventDefault();
      const prev      = lines[rowIdx - 1] ?? '';
      const mergeAt   = prev.length;
      lines[rowIdx - 1] = prev + (lines[rowIdx] ?? '');
      lines.splice(rowIdx, 1);
      textarea.value = lines.join('\n');
      fullRerender({ lineIdx: rowIdx - 1, offset: mergeAt });
      return;
    }
  }

  // Arrow navigation across spans
  if (e.key === 'ArrowDown') {
    const sel = window.getSelection();
    if (sel?.isCollapsed && sel.anchorOffset === span.textContent.length) {
      e.preventDefault();
      const next = rows[rowIdx + 1]?.querySelector('.ann-text');
      if (next) focusSpanAt(next, 0);
    }
    return;
  }
  if (e.key === 'ArrowUp') {
    const sel = window.getSelection();
    if (sel?.isCollapsed && sel.anchorOffset === 0) {
      e.preventDefault();
      const prev = rows[rowIdx - 1]?.querySelector('.ann-text');
      if (prev) focusSpanAt(prev, prev.textContent.length);
    }
    return;
  }
}

function onSpanPaste(e) {
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData('text/plain');
  if (!text) return;

  const rows    = Array.from(annotationLines.querySelectorAll('.ann-line'));
  const rowIdx  = rows.indexOf(e.currentTarget.closest('.ann-line'));
  const lines   = textarea.value.split('\n');
  const cursor  = getCursorState();
  const off     = cursor?.offset ?? 0;
  const current = lines[rowIdx] ?? '';
  const pasteLines = text.split('\n');

  if (pasteLines.length === 1) {
    lines[rowIdx] = current.slice(0, off) + text + current.slice(off);
    textarea.value = lines.join('\n');
    fullRerender({ lineIdx: rowIdx, offset: off + text.length });
  } else {
    const first = current.slice(0, off) + pasteLines[0];
    const last  = pasteLines[pasteLines.length - 1] + current.slice(off);
    lines.splice(rowIdx, 1, first, ...pasteLines.slice(1, -1), last);
    textarea.value = lines.join('\n');
    fullRerender({
      lineIdx: rowIdx + pasteLines.length - 1,
      offset:  pasteLines[pasteLines.length - 1].length,
    });
  }
}

// ── URL Tester ─────────────────────────────────────────────────────────────

function runTester() {
  const url   = urlInput.value.trim();
  const agent = agentInput.value.trim() || '*';
  const text  = textarea.value;

  if (!url || !text) {
    testerResult.textContent = '';
    testerResult.className   = '';
    testerInfo.textContent   = '';
    if (matchedLine !== null) { matchedLine = null; partialRerender(); }
    return;
  }

  try { new URL(url); } catch {
    testerResult.textContent  = 'invalid url';
    testerResult.className    = '';
    testerResult.style.cssText = 'color:#aaa;font-size:11px;';
    testerInfo.textContent    = '';
    return;
  }
  testerResult.style.cssText = '';

  const allowed = matcher.oneAgentAllowedByRobots(text, agent, url);
  const newLine = allowed ? null : findMatchingLine(text, agent, url);

  testerResult.textContent = allowed ? 'ALLOWED' : 'BLOCKED';
  testerResult.className   = allowed ? 'tester-allowed' : 'tester-blocked';
  testerInfo.textContent   = newLine
    ? `Line ${newLine} · specific rule${agent !== '*' ? ` for ${agent}` : ''}`
    : allowed ? 'no matching Disallow rule' : '';

  if (newLine !== matchedLine) {
    matchedLine = newLine;
    partialRerender();
    if (matchedLine) {
      annotationLines.querySelector(`[data-line="${matchedLine}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
}

// ── Entries ────────────────────────────────────────────────────────────────

async function loadAllEntries() {
  allEntries = await getAllEntries();
  updateDatalist();
}

function updateDatalist() {
  const filtered = tabOrigins.size > 0
    ? allEntries.filter(({ host }) => tabOrigins.has(host))
    : allEntries;
  hostDatalist.innerHTML = '';
  for (const { host } of filtered) {
    const opt = document.createElement('option');
    opt.value = host;
    hostDatalist.appendChild(opt);
  }
}

async function applyTabFilter(tabId) {
  tabOrigins.clear();
  if (tabId) {
    try {
      const tab = await chrome.tabs.get(Number(tabId));
      if (tab.url) tabOrigins.add(new URL(tab.url).origin);
    } catch {}
  }
  updateDatalist();
  if (tabOrigins.size === 1) {
    const [origin] = tabOrigins;
    const match = allEntries.find(({ host }) => host === origin);
    if (match) { hostSearch.value = match.host; await loadEntry(match.host); }
  }
}

async function loadEntry(host) {
  currentHost = host;
  const entry = await getEntry(host);
  textarea.value = entry ? (entry.text || '') : '';
  matchedLine = null;
  fullRerender();
  runTester();
}

// ── Tab select ─────────────────────────────────────────────────────────────

function isExtensionTab(tab) {
  return !tab.url || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('chrome://');
}

function tabLabel(tab) {
  return tab.title || tab.url || `Tab ${tab.id}`;
}

chrome.tabs.query({ currentWindow: true }, (tabs) => {
  for (const tab of tabs) {
    if (isExtensionTab(tab)) continue;
    const opt = document.createElement('option');
    opt.value = tab.id;
    opt.textContent = tabLabel(tab);
    tabSelect.appendChild(opt);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.title && !changeInfo.url) return;
  const opt = tabSelect.querySelector(`option[value="${tabId}"]`);
  if (isExtensionTab(tab)) {
    opt?.remove();
    return;
  }
  if (opt) {
    opt.textContent = tabLabel(tab);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabSelect.querySelector(`option[value="${tabId}"]`)?.remove();
});

tabSelect.addEventListener('change', () => applyTabFilter(tabSelect.value));
hostSearch.addEventListener('change', () => {
  const host = hostSearch.value.trim();
  if (host) loadEntry(host);
});

// ── Buttons ────────────────────────────────────────────────────────────────

btnUpdate.addEventListener('click', () => {
  if (!currentHost) return;
  btnUpdate.disabled = true;
  btnUpdate.textContent = 'Fetching…';
  chrome.runtime.sendMessage({ type: 'refetchEntry', host: currentHost });
});

// When the SW finishes a real fetch (status !== 999), reload the display.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !currentHost) return;
  const key = `r:${currentHost}`;
  if (!changes[key]) return;
  const entry = changes[key].newValue;
  if (!entry || entry.status === 999) return; // own auto-save write, skip
  textarea.value = entry.text || '';
  matchedLine = null;
  fullRerender();
  runTester();
  btnUpdate.disabled = false;
  btnUpdate.textContent = '(Re)fetch';
});

btnClear.addEventListener('click', async () => {
  if (!currentHost) return;
  chrome.runtime.sendMessage({ type: 'clearEntry', host: currentHost });
  textarea.value = ''; hostSearch.value = ''; currentHost = null; matchedLine = null;
  fullRerender(); await loadAllEntries();
});

btnClearAll.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'clearAll' });
  textarea.value = ''; hostSearch.value = ''; currentHost = null; matchedLine = null;
  allEntries = []; hostDatalist.innerHTML = ''; fullRerender();
});

urlInput.addEventListener('input', runTester);
agentInput.addEventListener('input', runTester);

// ── Init ───────────────────────────────────────────────────────────────────

(async () => {
  await loadAllEntries();
  agentInput.value = await getPreferredAgent();

  // Deep-link: robots.html?host=https://example.com&line=9
  const params   = new URLSearchParams(location.search);
  const deepHost = params.get('host');
  const deepLine = params.get('line') ? parseInt(params.get('line'), 10) : null;

  if (deepHost) { hostSearch.value = deepHost; await loadEntry(deepHost); }
  if (deepLine) { matchedLine = deepLine; partialRerender(); }
})();
