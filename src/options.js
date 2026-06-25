const input     = document.getElementById('recordGroup');
const savedMsg  = document.getElementById('savedMsg');
const clearBtn  = document.getElementById('clearAll');

let saveTimer = null;

function save(raw) {
  const value = raw.trim() || '*'; // empty → fallback to *
  if (input.value !== value) input.value = value;
  chrome.storage.local.set({ preferredRecordGroup: value });
  chrome.runtime.sendMessage({ type: 'userAgent', state: value });
  savedMsg.textContent = `Saved: ${value}`;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { savedMsg.textContent = ''; }, 2000);
}

// Load stored value on open; fall back to * if missing or empty.
chrome.storage.local.get('preferredRecordGroup', ({ preferredRecordGroup }) => {
  input.value = preferredRecordGroup || '*';
});

// Save on change (datalist selection) or when input loses focus.
input.addEventListener('change', () => save(input.value));
input.addEventListener('blur',   () => save(input.value));

clearBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'clearAll' });
  clearBtn.textContent = 'Cleared';
  setTimeout(() => { clearBtn.textContent = 'Clear all cached robots.txt'; }, 2000);
});
