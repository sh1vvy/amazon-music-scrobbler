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
  return `${hr}h ago`;
}

function renderTrack(contentEl, track, subtitle) {
  contentEl.innerHTML = `
    <div class="track-title">${escHtml(track.title)}</div>
    <div class="track-artist">${escHtml(track.artist)}${track.album ? ` · ${escHtml(track.album)}` : ''}</div>
    ${subtitle ? `<div class="track-time">${subtitle}</div>` : ''}
  `;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function send(type, data = {}) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type, ...data }, response => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(response);
    });
  });
}

async function refreshConnectedScreen(status) {
  $('username-display').textContent = `Signed in as ${status.username}`;

  // liveTrack is read directly from the tab by the background (no content script needed)
  const npContent = $('now-playing-content');
  if (status.liveTrack) {
    $('now-playing-card').classList.add('active');
    renderTrack(npContent, status.liveTrack);
  } else {
    $('now-playing-card').classList.remove('active');
    npContent.innerHTML = '<span class="track-empty">Nothing playing</span>';
  }

  const lsContent = $('last-scrobble-content');
  if (status.lastScrobble?.error) {
    lsContent.innerHTML = `<span class="track-empty" style="color:#e8534a">${escHtml(status.lastScrobble.error)}</span>`;
  } else if (status.lastScrobble) {
    renderTrack(lsContent, status.lastScrobble.track, timeAgo(status.lastScrobble.at));
  } else {
    lsContent.innerHTML = '<span class="track-empty">Nothing scrobbled yet</span>';
  }
}

async function init() {
  showScreen('loading');

  let status = await send('GET_STATUS');

  // Service worker may still be waking up — retry once
  if (!status?.ok) {
    await new Promise(r => setTimeout(r, 400));
    status = await send('GET_STATUS');
  }

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

  // Poll while popup is open
  const poll = setInterval(async () => {
    const s = await send('GET_STATUS');
    if (s.authenticated) {
      await refreshConnectedScreen(s);
    } else {
      clearInterval(poll);
      showScreen('auth');
    }
  }, 4000);
}

// ── Event Handlers ────────────────────────────────────────────────────────────

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

$('btn-disconnect').addEventListener('click', async () => {
  await send('DISCONNECT');
  showScreen('auth');
});

init();
