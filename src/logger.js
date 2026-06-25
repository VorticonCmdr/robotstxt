const TYPE_CLASS = {
  main_frame:     'type-document',
  sub_frame:      'type-frame',
  stylesheet:     'type-stylesheet',
  script:         'type-script',
  image:          'type-image',
  font:           'type-font',
  object:         'type-other',
  xmlhttprequest: 'type-xhr',
  ping:           'type-other',
  csp_report:     'type-other',
  media:          'type-media',
  websocket:      'type-xhr',
  other:          'type-other',
};

const TYPE_LABEL = {
  main_frame:     'document',
  sub_frame:      'frame',
  xmlhttprequest: 'xhr',
};

function formatTime(ts) {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 8);
}

function typeLabel(rt) {
  return TYPE_LABEL[rt] || rt || 'other';
}

function typeCls(rt) {
  return TYPE_CLASS[rt] || 'type-other';
}

let entries = [];
let selectedTab = '';
let blockedCount = 0;
const origins = new Set();

const loglines   = document.getElementById('loglines');
const emptyState = document.getElementById('empty-state');
const badgeBlocked = document.getElementById('badge-blocked');
const badgeOrigins = document.getElementById('badge-origins');
const connDot    = document.getElementById('conn-dot');
const tabSelect  = document.getElementById('tabSelect');

function updateBadges() {
  badgeBlocked.textContent = `${blockedCount} blocked`;
  badgeBlocked.classList.toggle('has-entries', blockedCount > 0);
  badgeOrigins.textContent = `${origins.size} origins`;
  badgeOrigins.classList.toggle('has-entries', origins.size > 0);
}

function makeRow(msg) {
  const tr = document.createElement('tr');

  const tdTime = document.createElement('td');
  tdTime.className = 'time';
  tdTime.textContent = formatTime(msg.timestamp);
  tr.appendChild(tdTime);

  const tdMethod = document.createElement('td');
  tdMethod.className = 'method';
  tdMethod.textContent = msg.method || 'GET';
  tr.appendChild(tdMethod);

  const tdUrl = document.createElement('td');
  tdUrl.className = 'url';
  tdUrl.textContent = msg.url;
  tdUrl.title = msg.url;
  tr.appendChild(tdUrl);

  const tdType = document.createElement('td');
  const badge = document.createElement('span');
  badge.className = `type-badge ${typeCls(msg.resourceType)}`;
  badge.textContent = typeLabel(msg.resourceType);
  tdType.appendChild(badge);
  tr.appendChild(tdType);

  const tdReason = document.createElement('td');
  tdReason.className = 'reason';
  const reasonCls = msg.reason === 'robots-disallow'  ? 'reason-disallow'
                  : msg.reason === 'robots-race'      ? 'reason-race'
                  : 'reason-unavailable';
  const reasonLabel = msg.reason === 'robots-race' ? '⚠ robots-race' : (msg.reason || '');
  tdReason.innerHTML = `<span class="${reasonCls}">${reasonLabel}</span>`;
  tr.appendChild(tdReason);

  const tdLine = document.createElement('td');
  tdLine.className = 'line';
  if (msg.line != null) {
    try {
      const host = new URL(msg.url).origin;
      const link = document.createElement('a');
      link.textContent = msg.line;
      link.title = `Open in cache viewer: ${host} line ${msg.line}`;
      link.style.cssText = 'color:#4a9eff;text-decoration:none;cursor:pointer;';
      link.addEventListener('mouseenter', () => { link.style.textDecoration = 'underline'; });
      link.addEventListener('mouseleave', () => { link.style.textDecoration = 'none'; });
      link.addEventListener('click', () => {
        chrome.tabs.create({
          url: `robots.html?host=${encodeURIComponent(host)}&line=${msg.line}`,
        });
      });
      tdLine.appendChild(link);
    } catch {
      tdLine.textContent = msg.line;
    }
  }
  tr.appendChild(tdLine);

  const tdRef = document.createElement('td');
  tdRef.className = 'referrer';
  tdRef.textContent = msg.referrer || '';
  tdRef.title = msg.referrer || '';
  tr.appendChild(tdRef);

  return tr;
}

function appendMsg(msg) {
  if (emptyState.parentNode) emptyState.remove();

  blockedCount++;
  try { origins.add(new URL(msg.url).host); } catch {}
  updateBadges();

  const tr = makeRow(msg);
  // prepend so newest is on top
  loglines.insertBefore(tr, loglines.firstChild);
}

function parseMsg(msg) {
  if (msg.type !== 'logline') return;
  entries.push(msg);
  if (!selectedTab || String(msg.tabId) === String(selectedTab)) {
    appendMsg(msg);
  }
}

function rebuildTable() {
  loglines.innerHTML = '';
  blockedCount = 0;
  origins.clear();
  const filtered = selectedTab
    ? entries.filter((m) => String(m.tabId) === String(selectedTab))
    : entries;
  if (filtered.length === 0) {
    loglines.appendChild(emptyState);
  } else {
    // render newest first
    for (let i = filtered.length - 1; i >= 0; i--) {
      const tr = makeRow(filtered[i]);
      loglines.appendChild(tr);
    }
    blockedCount = filtered.length;
    filtered.forEach((m) => { try { origins.add(new URL(m.url).host); } catch {} });
  }
  updateBadges();
}

// ── tab select ──
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

tabSelect.addEventListener('change', () => {
  selectedTab = tabSelect.value;
  rebuildTable();
});

// ── clear ──
document.getElementById('btn-clear').addEventListener('click', () => {
  entries = [];
  blockedCount = 0;
  origins.clear();
  loglines.innerHTML = '';
  loglines.appendChild(emptyState);
  updateBadges();
});

// ── download JSON ──
document.getElementById('btn-download').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `blocklog-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

function selectTabById(tabId) {
  const strId = String(tabId);
  let opt = tabSelect.querySelector(`option[value="${strId}"]`);
  if (!opt) {
    opt = document.createElement('option');
    opt.value = strId;
    opt.textContent = `Tab ${strId}`;
    tabSelect.appendChild(opt);
    chrome.tabs.get(tabId, (tab) => {
      if (tab) opt.textContent = tab.title || tab.url || `Tab ${strId}`;
    });
  }
  tabSelect.value = strId;
  selectedTab = strId;
  rebuildTable();
}

// ── connection indicator ──
connDot.classList.add('connected');

// Sync tab selection when popup is opened (popup writes to storage).
chrome.storage.local.get('loggerFocusTab', ({ loggerFocusTab }) => {
  if (loggerFocusTab) selectTabById(loggerFocusTab);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.loggerFocusTab) {
    selectTabById(changes.loggerFocusTab.newValue);
  }
});

chrome.runtime.onMessage.addListener(parseMsg);
