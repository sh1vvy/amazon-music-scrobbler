// popup.js

function $(id) { return document.getElementById(id); }

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  $(`screen-${name}`).classList.remove('hidden');
}

function showError(elId, msg) {
  const el = $(elId);
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideError(elId) {
  $(elId).classList.add('hidden');
}

function timeAgo(ms) {
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderTrack(contentEl, track, subtitle) {
  contentEl.innerHTML = `
    <div class="track-title">${escHtml(track.title)}</div>
    <div class="track-artist">${escHtml(track.artist)}${track.album ? ` · ${escHtml(track.album)}` : ''}</div>
    ${subtitle ? `<div class="track-time">${subtitle}</div>` : ''}
  `;
}

function send(type, data = {}) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type, ...data }, response => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(response);
    });
  });
}

// ─── Love button state ─────────────────────────────────────────

let lovedTrackKey = null;
let isLoved = false;

function trackKey(t) { return `${t.title}::${t.artist}`; }

function updateLoveButton(track) {
  const btn = $('btn-love');
  if (!track) {
    btn.disabled = true;
    return;
  }
  btn.disabled = false;
  const key = trackKey(track);
  if (key !== lovedTrackKey) {
    isLoved = false;
    lovedTrackKey = null;
  }
  btn.classList.toggle('loved', isLoved);
}

// ─── Settings UI sync ──────────────────────────────────────────

let currentSettings = null;

function applyTheme(theme) {
  document.body.dataset.theme = theme || 'auto';
  document.querySelectorAll('#theme-seg .seg-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.value === (theme || 'auto'));
  });
}

function syncSettingsUI(settings) {
  currentSettings = settings;
  $('toggle-scrobble').checked      = settings.scrobblingEnabled;
  $('toggle-notifications').checked = settings.notificationsEnabled;
  const pct = settings.scrobbleThresholdPercent ?? 50;
  $('threshold-slider').value       = pct;
  $('threshold-value').textContent  = `${pct}%`;
  applyTheme(settings.theme);
}

function updateStatusBadge(scrobblingEnabled) {
  const badge = $('status-badge');
  const text  = $('status-text');
  if (scrobblingEnabled) {
    badge.classList.remove('paused');
    text.textContent = 'Active';
  } else {
    badge.classList.add('paused');
    text.textContent = 'Paused';
  }
}

// ─── Render connected screen ───────────────────────────────────

async function refreshConnectedScreen(status) {
  $('username-display').textContent = status.username || '';

  // Settings might come in as part of status
  if (status.settings) {
    syncSettingsUI(status.settings);
    updateStatusBadge(status.settings.scrobblingEnabled);
  }

  // Now playing card
  const npContent = $('now-playing-content');
  const artEl     = $('now-playing-art');
  const phEl      = $('album-art-placeholder');

  if (status.liveTrack) {
    $('now-playing-card').classList.add('active');
    renderTrack(npContent, status.liveTrack);
    updateLoveButton(status.liveTrack);
    if (status.liveTrack.image) {
      artEl.src = status.liveTrack.image;
      artEl.classList.remove('hidden');
      phEl.classList.add('hidden');
    } else {
      artEl.classList.add('hidden');
      phEl.classList.remove('hidden');
    }
  } else {
    $('now-playing-card').classList.remove('active');
    npContent.innerHTML = '<span class="track-empty">Nothing playing</span>';
    artEl.classList.add('hidden');
    phEl.classList.add('hidden');
    updateLoveButton(null);
  }

  // Offline queue indicator
  const qBadge = $('queue-indicator');
  if (status.offlineQueueSize > 0) {
    qBadge.textContent = `${status.offlineQueueSize} queued`;
    qBadge.classList.remove('hidden');
  } else {
    qBadge.classList.add('hidden');
  }

  // Scrobble history
  const historyList = $('history-list');
  const history = status.scrobbleHistory || [];
  if (history.length === 0) {
    historyList.innerHTML = '<span class="track-empty">Nothing scrobbled yet</span>';
  } else {
    historyList.innerHTML = history.map((entry, i) => `
      <div class="history-item${i < history.length - 1 ? ' bordered' : ''}">
        <div class="history-row">
          <div class="history-track-info">
            <div class="history-track">
              <span class="track-title">${escHtml(entry.track.title)}</span>
              <span class="history-time">${timeAgo(entry.at)}</span>
            </div>
            <div class="track-artist">${escHtml(entry.track.artist)}</div>
          </div>
          <button class="btn-rescrobble" data-idx="${i}" title="Re-scrobble" aria-label="Re-scrobble">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/>
              <path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>
            </svg>
          </button>
        </div>
      </div>
    `).join('');

    // Wire up re-scrobble buttons
    historyList.querySelectorAll('.btn-rescrobble').forEach(btn => {
      btn.addEventListener('click', async () => {
        const idx = Number(btn.dataset.idx);
        const entry = history[idx];
        if (!entry) return;
        btn.disabled = true;
        btn.classList.add('busy');
        const res = await send('RE_SCROBBLE', { track: entry.track });
        btn.classList.remove('busy');
        if (res?.ok) {
          btn.classList.add('done');
          setTimeout(() => btn.classList.remove('done'), 1200);
        } else {
          btn.classList.add('failed');
          btn.title = res?.error || 'Failed';
          setTimeout(() => btn.classList.remove('failed'), 1800);
        }
        btn.disabled = false;
      });
    });
  }

  // Last.fm profile link
  if (status.username) {
    const link = $('link-profile');
    link.href = `https://www.last.fm/user/${encodeURIComponent(status.username)}`;
    link.classList.remove('hidden');
  }
}

// ─── Init / polling ────────────────────────────────────────────

let pollTimer = null;

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    const s = await send('GET_STATUS');
    if (s?.authenticated) {
      await refreshConnectedScreen(s);
    } else if (s) {
      clearInterval(pollTimer); pollTimer = null;
      showScreen('auth');
    }
  }, 4000);
}

async function showShortcutHint() {
  try {
    const commands = await chrome.commands.getAll();
    const cmd = commands.find(c => c.name === 'toggle-scrobbling');
    const kbd = $('kbd-toggle');
    if (cmd?.shortcut) {
      kbd.textContent = cmd.shortcut;
      kbd.classList.remove('hidden');
    } else {
      kbd.classList.add('hidden');
    }
  } catch (_) {}
}

async function init() {
  showScreen('loading');

  let status = await send('GET_STATUS');

  // Service worker may still be waking up — retry once
  if (!status?.ok) {
    await new Promise(r => setTimeout(r, 400));
    status = await send('GET_STATUS');
  }

  // Apply theme immediately so we don't flash dark/light during boot
  if (status?.settings?.theme) applyTheme(status.settings.theme);

  if (!status?.hasCredentials) {
    showScreen('setup');
    return;
  }
  if (!status?.authenticated) {
    showScreen('auth');
    return;
  }

  showScreen('connected');
  await refreshConnectedScreen(status);
  showShortcutHint();
  startPolling();
}

// ─── Event handlers ────────────────────────────────────────────

$('btn-save-credentials').addEventListener('click', async () => {
  const apiKey = $('api-key').value.trim();
  const apiSecret = $('api-secret').value.trim();

  if (!apiKey || !apiSecret) {
    showError('setup-error', 'Both fields are required.');
    return;
  }
  if (apiKey.length !== 32) {
    showError('setup-error', 'API key should be 32 characters long.');
    return;
  }

  hideError('setup-error');
  $('btn-save-credentials').disabled = true;
  $('btn-save-credentials').textContent = 'Saving…';

  const res = await send('SAVE_CREDENTIALS', { apiKey, apiSecret });
  if (res?.ok) {
    showScreen('auth');
  } else {
    showError('setup-error', res?.error || 'Failed to save credentials.');
  }

  $('btn-save-credentials').disabled = false;
  $('btn-save-credentials').textContent = 'Save & Continue';
});

$('btn-connect').addEventListener('click', async () => {
  hideError('auth-error');
  $('btn-connect').disabled = true;
  $('btn-connect').textContent = 'Opening Last.fm…';

  const res = await send('START_AUTH');

  if (res?.ok) {
    showScreen('connected');
    const status = await send('GET_STATUS');
    await refreshConnectedScreen(status);
    startPolling();
  } else {
    showError('auth-error', res?.error || 'Authentication failed. Please try again.');
  }

  $('btn-connect').disabled = false;
  $('btn-connect').textContent = 'Connect to Last.fm';
});

$('btn-reset-creds').addEventListener('click', async () => {
  await send('CLEAR_CREDENTIALS');
  showScreen('setup');
});

$('btn-love').addEventListener('click', async () => {
  const btn = $('btn-love');
  const status = await send('GET_STATUS');
  const track = status?.liveTrack;
  if (!track) return;

  btn.disabled = true;
  const newLoved = !isLoved;
  const res = await send(newLoved ? 'LOVE_TRACK' : 'UNLOVE_TRACK', {
    artist: track.artist,
    track: track.title,
  });

  if (res?.ok) {
    isLoved = newLoved;
    lovedTrackKey = trackKey(track);
    btn.classList.toggle('loved', isLoved);
  }
  btn.disabled = false;
});

$('btn-settings').addEventListener('click', () => {
  showScreen('settings');
});

$('btn-back').addEventListener('click', () => {
  showScreen('connected');
});

$('btn-disconnect').addEventListener('click', async () => {
  await send('DISCONNECT');
  showScreen('auth');
});

$('toggle-scrobble').addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  const res = await send('UPDATE_SETTINGS', { settings: { scrobblingEnabled: enabled } });
  if (res?.ok) {
    currentSettings = res.settings;
    updateStatusBadge(enabled);
  }
});

$('toggle-notifications').addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  const res = await send('UPDATE_SETTINGS', { settings: { notificationsEnabled: enabled } });
  if (res?.ok) currentSettings = res.settings;
});

let thresholdSaveTimer = null;
$('threshold-slider').addEventListener('input', (e) => {
  const pct = Number(e.target.value);
  $('threshold-value').textContent = `${pct}%`;
  // Debounce writes so we don't hammer storage during drag
  clearTimeout(thresholdSaveTimer);
  thresholdSaveTimer = setTimeout(async () => {
    const res = await send('UPDATE_SETTINGS', { settings: { scrobbleThresholdPercent: pct } });
    if (res?.ok) currentSettings = res.settings;
  }, 250);
});

document.querySelectorAll('#theme-seg .seg-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const theme = btn.dataset.value;
    applyTheme(theme);
    const res = await send('UPDATE_SETTINGS', { settings: { theme } });
    if (res?.ok) currentSettings = res.settings;
  });
});

// Listen for system theme changes when on 'auto'
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (currentSettings?.theme === 'auto') applyTheme('auto');
});

init();
