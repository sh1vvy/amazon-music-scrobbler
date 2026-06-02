// background.js — service worker

const LASTFM_API = 'https://ws.audioscrobbler.com/2.0/';

const AMAZON_MUSIC_PATTERNS = [
  'https://music.amazon.com/*',
  'https://music.amazon.co.uk/*',
  'https://music.amazon.de/*',
  'https://music.amazon.fr/*',
  'https://music.amazon.ca/*',
  'https://music.amazon.co.jp/*',
  'https://music.amazon.com.au/*',
  'https://music.amazon.in/*',
];

// ── MD5 ──────────────────────────────────────────────────────────────────────

function md5(input) {
  const bytes = Array.from(new TextEncoder().encode(input));
  let a = 0x67452301, b = 0xEFCDAB89, c = 0x98BADCFE, d = 0x10325476;

  const S = [
    7,12,17,22, 7,12,17,22, 7,12,17,22, 7,12,17,22,
    5, 9,14,20, 5, 9,14,20, 5, 9,14,20, 5, 9,14,20,
    4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23,
    6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21,
  ];
  const K = Array.from({ length: 64 }, (_, i) =>
    (Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0
  );

  const bitLen = bytes.length * 8;
  const padded = [...bytes, 0x80];
  while (padded.length % 64 !== 56) padded.push(0);
  for (let i = 0; i < 4; i++) padded.push((bitLen >>> (i * 8)) & 0xff);
  for (let i = 0; i < 4; i++) padded.push(0);

  const add = (x, y) => (x + y) >>> 0;
  const rol = (v, n) => ((v << n) | (v >>> (32 - n))) >>> 0;

  for (let i = 0; i < padded.length; i += 64) {
    const M = Array.from({ length: 16 }, (_, j) =>
      ((padded[i+j*4+3] << 24) | (padded[i+j*4+2] << 16) |
       (padded[i+j*4+1] << 8)  |  padded[i+j*4]) >>> 0
    );
    let A = a, B = b, C = c, D = d;

    for (let j = 0; j < 64; j++) {
      let F, g;
      if      (j < 16) { F = ((B & C) | (~B & D)) >>> 0; g = j; }
      else if (j < 32) { F = ((D & B) | (~D & C)) >>> 0; g = (5*j+1) % 16; }
      else if (j < 48) { F =  (B ^ C ^ D)         >>> 0; g = (3*j+5) % 16; }
      else             { F =  (C ^ (B | ~D))       >>> 0; g = (7*j)   % 16; }

      const T = D;
      D = C; C = B;
      B = add(B, rol(add(add(A, F), add(K[j], M[g])), S[j]));
      A = T;
    }
    a = add(a, A); b = add(b, B); c = add(c, C); d = add(d, D);
  }

  return [a, b, c, d]
    .map(n => Array.from({ length: 4 }, (_, i) =>
      ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, '0')
    ).join(''))
    .join('');
}

// ── Settings ──────────────────────────────────────────────────────────────────
// Stored in chrome.storage.sync so they roam across devices.
// Defaults: scrobbling on, notifications off, theme auto.

const DEFAULT_SETTINGS = {
  scrobblingEnabled:        true,
  notificationsEnabled:     false,
  theme:                    'auto', // 'auto' | 'dark' | 'light'
  scrobbleThresholdPercent: 50,     // percent of track that must play before scrobbling
};

function getSettings() {
  return new Promise(r => chrome.storage.sync.get(DEFAULT_SETTINGS, r));
}

// ── Notifications ─────────────────────────────────────────────────────────────

// ── Toolbar icon indicator ────────────────────────────────────────────────────
// Chrome's badge is huge — it fills most of the icon and overpowers it.  Instead
// we draw the base icon and a small play/check overlay directly into a canvas
// and swap the toolbar icon via chrome.action.setIcon().  This gives us
// pixel-level control: the indicator can be a small corner overlay, not a
// dominant colored block.

const ICON_SIZES   = [16, 32, 48, 128];
const ICON_CACHE   = {};                       // state → {16:ImageData, 32, 48, 128}
let   baseBitmap   = null;                     // cached base icon bitmap

async function loadBaseBitmap() {
  if (baseBitmap) return baseBitmap;
  const blob = await fetch(chrome.runtime.getURL('icons/icon128.png')).then(r => r.blob());
  baseBitmap = await createImageBitmap(blob);
  return baseBitmap;
}

function drawCircle(ctx, x, y, r, fill) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

// Small corner indicator: thin dark ring + colored fill + white glyph.
// Radius is ~20% of icon — visible but doesn't dominate.

function drawCornerBadge(ctx, size, color, drawGlyph) {
  const r  = size * 0.22;
  const cx = size - r - size * 0.03;
  const cy = size - r - size * 0.03;
  // Thin dark outline for contrast against any icon background
  drawCircle(ctx, cx, cy, r + Math.max(1, size * 0.02), 'rgba(0,0,0,0.55)');
  drawCircle(ctx, cx, cy, r, color);
  drawGlyph(cx, cy, r);
}

function drawCheckOverlay(ctx, size, color) {
  drawCornerBadge(ctx, size, color, (cx, cy, r) => {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth   = Math.max(1.2, size * 0.045);
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.45, cy + r * 0.05);
    ctx.lineTo(cx - r * 0.10, cy + r * 0.40);
    ctx.lineTo(cx + r * 0.50, cy - r * 0.30);
    ctx.stroke();
  });
}

async function generateIcon(state) {
  if (ICON_CACHE[state]) return ICON_CACHE[state];
  const base = await loadBaseBitmap();
  const result = {};
  for (const size of ICON_SIZES) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx    = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(base, 0, 0, size, size);
    if (state === 'scrobbled') drawCheckOverlay(ctx, size, '#34c759');
    // else 'idle' → just the base icon, no overlay
    result[size] = ctx.getImageData(0, 0, size, size);
  }
  ICON_CACHE[state] = result;
  return result;
}

async function updateBadge() {
  try {
    const { currentScrobbled, currentTrack } =
      await new Promise(r => chrome.storage.local.get(
        ['currentScrobbled', 'currentTrack'], r));

    // Only two states: scrobbled (green check) or idle (plain icon).
    const state = (currentTrack && currentScrobbled) ? 'scrobbled' : 'idle';

    const imageData = await generateIcon(state);
    await chrome.action.setIcon({ imageData });
    // Always clear badge text in case the old badge-based version left one behind
    await chrome.action.setBadgeText({ text: '' });
  } catch (e) {
    console.warn('[Scrobbler] updateBadge failed:', e);
  }
}

// Refresh icon when scrobble state changes (track change resets, scrobble flips it)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.currentTrack || changes.currentScrobbled)) {
    updateBadge();
  }
});

async function notifyScrobbled(track) {
  const { notificationsEnabled } = await getSettings();
  if (!notificationsEnabled) return;
  try {
    chrome.notifications.create('', {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Scrobbled to Last.fm',
      message: `${track.title} — ${track.artist}`,
      silent: true,
    });
  } catch (_) {}
}

// ── Credentials ───────────────────────────────────────────────────────────────

function getCredentials() {
  return new Promise(resolve =>
    chrome.storage.sync.get(['apiKey', 'apiSecret', 'sessionKey', 'username'], resolve)
  );
}

// ── Last.fm API ───────────────────────────────────────────────────────────────

function makeSignature(params, apiSecret) {
  const str = Object.keys(params)
    .filter(k => k !== 'format' && k !== 'callback')
    .sort()
    .map(k => `${k}${params[k] ?? ''}`)
    .join('') + apiSecret;
  return md5(str);
}

async function lastfmPost(method, extraParams = {}) {
  const { apiKey, apiSecret, sessionKey } = await getCredentials();
  if (!apiKey || !apiSecret) throw new Error('API credentials not set');

  const params = { method, api_key: apiKey, ...extraParams, format: 'json' };
  if (sessionKey && method !== 'auth.getSession') params.sk = sessionKey;
  params.api_sig = makeSignature(params, apiSecret);

  const res = await fetch(LASTFM_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  return res.json();
}

// ── Auth ───────────────────────────────────────────────────────────────────────

async function startAuth() {
  const { apiKey } = await getCredentials();
  if (!apiKey) throw new Error('API key not set');

  const redirectUrl = chrome.identity.getRedirectURL('lastfm');
  const authUrl = `https://www.last.fm/api/auth/?api_key=${apiKey}&cb=${encodeURIComponent(redirectUrl)}`;

  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, async responseUrl => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!responseUrl) return reject(new Error('Auth cancelled'));

      const token = new URL(responseUrl).searchParams.get('token');
      if (!token) return reject(new Error('No token in callback'));

      try {
        const data = await lastfmPost('auth.getSession', { token });
        if (data.error) return reject(new Error(data.message || 'Session error'));

        const sessionKey = data.session.key;
        const username = data.session.name;
        await new Promise(r => chrome.storage.sync.set({ sessionKey, username }, r));
        resolve({ username, sessionKey });
      } catch (e) {
        reject(e);
      }
    });
  });
}

// ── Last.fm track calls ────────────────────────────────────────────────────────

async function callUpdateNowPlaying(track) {
  const p = { artist: track.artist, track: track.title };
  if (track.album) p.album = track.album;
  if (track.duration) p.duration = Math.floor(track.duration);
  return lastfmPost('track.updateNowPlaying', p);
}

async function callScrobble(track) {
  // Last.fm requires array-indexed params for scrobble even for single tracks
  const p = {
    'artist[0]': track.artist,
    'track[0]': track.title,
    'timestamp[0]': String(track.timestamp || Math.floor(Date.now() / 1000)),
  };
  if (track.album)    p['album[0]']    = track.album;
  if (track.duration) p['duration[0]'] = String(Math.floor(track.duration));
  return lastfmPost('track.scrobble', p);
}

// ── Direct tab state reading ───────────────────────────────────────────────────
// Reads Media Session + audio state directly from the Amazon Music tab.
// This works regardless of whether the content script is injected.

async function readAmazonTab() {
  const tabs = await chrome.tabs.query({ url: AMAZON_MUSIC_PATTERNS });
  if (!tabs.length) {
    // No Amazon Music tab — nothing is playing.  Make sure the badge reflects that.
    chrome.storage.local.set({ isPlaying: false });
    return null;
  }

  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: () => {
        // Amazon Music new player: track info lives in DOM attributes, not mediaSession.
        // This matches the approach used by web-scrobbler for Amazon Music.
        const audio = document.querySelector('audio');
        const item  = document.querySelector('#transport music-horizontal-item');
        let title, artist;
        if (item) {
          title  = item.getAttribute('primary-text');
          artist = item.getAttribute('secondary-text');
        }
        // Fallback to MediaSession if DOM approach yields nothing
        if (!title || !artist) {
          const meta = navigator.mediaSession?.metadata;
          title  = meta?.title;
          artist = meta?.artist;
        }
        if (!title || !artist) return null;
        // Strip Amazon explicit/clean/version tags so Last.fm matches the canonical track
        const clean = s => s.replace(/\s*[\(\[](explicit|clean|explicit version|clean version|radio edit|radio version|album version|original mix)[\)\]]/gi, '').trim();
        // Album art lives in navigator.mediaSession.metadata.artwork (512px JPEG)
        const image = navigator.mediaSession?.metadata?.artwork?.[0]?.src || '';
        return {
          title:  clean(title),
          artist: clean(artist),
          album:  '',
          image,
          duration: audio?.duration || 0,
          currentTime: audio?.currentTime || 0,
          isPlaying: audio ? !audio.paused : false,
        };
      },
    });
    const live = res?.result || null;
    // Mirror isPlaying to storage so the toolbar badge always reflects real
    // audio state.  Content script's own setIsPlaying writes can be unreliable
    // (timing of play/pause events on Amazon Music's MSE stream), so this
    // background path — which reads audio.paused directly via executeScript —
    // is the canonical source of truth for the badge.
    if (live) chrome.storage.local.set({ isPlaying: !!live.isPlaying });
    return live;
  } catch (_) {
    return null;
  }
}

// ── Track state ────────────────────────────────────────────────────────────────

function getLocalState() {
  return new Promise(r =>
    chrome.storage.local.get(
      ['currentTrack', 'currentTrackAt', 'currentScrobbled', 'lastScrobble', 'scrobbleHistory'],
      r
    )
  );
}

async function pushToHistory(entry) {
  const state = await new Promise(r => chrome.storage.local.get('scrobbleHistory', r));
  const history = Array.isArray(state.scrobbleHistory) ? state.scrobbleHistory : [];
  await new Promise(r => chrome.storage.local.set({
    scrobbleHistory: [entry, ...history].slice(0, 5),
  }, r));
}

// ── Offline queue ─────────────────────────────────────────────────────────────
// When a scrobble fails (network down, Last.fm API unreachable), we stash the
// payload here and retry on each subsequent successful scrobble + every track_poll.

async function queueOfflineScrobble(track) {
  const { offlineQueue = [] } = await new Promise(r => chrome.storage.local.get('offlineQueue', r));
  // Avoid duplicates by (title, artist, timestamp)
  const exists = offlineQueue.some(t =>
    t.title === track.title && t.artist === track.artist && t.timestamp === track.timestamp);
  if (exists) return;
  await new Promise(r => chrome.storage.local.set({
    offlineQueue: [...offlineQueue, track].slice(-50), // cap at 50 to avoid storage bloat
  }, r));
}

async function flushOfflineQueue() {
  const { offlineQueue = [] } = await new Promise(r => chrome.storage.local.get('offlineQueue', r));
  if (offlineQueue.length === 0) return;

  const { sessionKey } = await getCredentials();
  if (!sessionKey) return;

  const remaining = [];
  for (const track of offlineQueue) {
    try {
      const result = await callScrobble(track);
      if (result?.error) {
        remaining.push(track); // keep for next try
      } else {
        await pushToHistory({ track, at: Date.now(), recovered: true });
      }
    } catch (_) {
      remaining.push(track); // network still down
    }
  }
  await new Promise(r => chrome.storage.local.set({ offlineQueue: remaining }, r));
}

async function onNewTrack(track) {
  const startTimestamp = Math.floor(Date.now() / 1000);

  await new Promise(r => chrome.storage.local.set({
    currentTrack: track,
    currentTrackAt: startTimestamp,
    currentScrobbled: false,
  }, r));

  const { sessionKey } = await getCredentials();
  if (!sessionKey) return;

  try { await callUpdateNowPlaying(track); } catch (_) {}

  // Always schedule a check — duration may still be loading when this fires,
  // so tryScrobbleNow uses elapsed time as a fallback.
  const delaySec = track.duration > 30
    ? Math.min(track.duration * 0.5, 240)
    : 60; // fallback: check after 60s if duration wasn't loaded yet
  chrome.alarms.create('scrobble_pending', { delayInMinutes: delaySec / 60 });
}

async function tryScrobbleNow() {
  const state = await getLocalState();
  if (!state.currentTrack || state.currentScrobbled) return;

  const { sessionKey } = await getCredentials();
  if (!sessionKey) return;

  // Honor the user's scrobble toggle + threshold
  const { scrobblingEnabled, scrobbleThresholdPercent } = await getSettings();
  if (!scrobblingEnabled) return;
  const thresholdFraction = (scrobbleThresholdPercent || 50) / 100;

  const live = await readAmazonTab();

  const elapsed   = Math.floor(Date.now() / 1000) - (state.currentTrackAt || 0);
  const storedDur = state.currentTrack.duration || 0;

  // Is a DIFFERENT track actively playing right now?
  const differentTrack = live?.isPlaying &&
    (live.title !== state.currentTrack.title || live.artist !== state.currentTrack.artist);

  if (differentTrack) {
    // A different track is playing — this happens when a song auto-transitions
    // or when the skip wasn't detected until the next popup open.
    // We still want to scrobble the stored track if it played long enough.
    // BUT: if elapsed is far larger than the stored duration the song was
    // probably paused for a long time before being skipped — skip the scrobble.
    if (storedDur > 0 && elapsed > storedDur * 1.5) return;
  }

  // When a different track is now playing, live.currentTime belongs to that
  // other track — use elapsed wall-clock time as the position proxy instead.
  const duration = (!differentTrack && live?.duration > 0 ? live.duration : 0) || storedDur;
  const position = (!differentTrack && live?.currentTime > 0 ? live.currentTime : 0) || elapsed;

  // Last.fm rule: track must be longer than 30 seconds
  if (duration > 0 && duration < 30) return;

  // Must have played to the user-configured threshold (default 50%, capped at 4 min)
  const threshold = duration > 30 ? Math.min(duration * thresholdFraction, 240) : 120;
  if (position < threshold && elapsed < threshold) {
    if (!differentTrack) {
      // Still on the same track and too early — reschedule the alarm.
      const remaining = Math.max(threshold - Math.max(position, elapsed), 30);
      chrome.alarms.create('scrobble_pending', { delayInMinutes: remaining / 60 });
    }
    // If a different track is already playing we can't reschedule — just drop.
    return;
  }

  const scrobbleEntry = { track: state.currentTrack, at: Date.now() };

  await new Promise(r => chrome.storage.local.set({
    currentScrobbled: true,
    lastScrobble: scrobbleEntry,
  }, r));

  const scrobbleTrack = { ...state.currentTrack, timestamp: state.currentTrackAt };
  try {
    const result = await callScrobble(scrobbleTrack);
    if (result?.error) {
      console.error('[Scrobbler] Last.fm error:', result.error, result.message);
      // 16 = service offline, 11 = service temporarily unavailable → queue
      if (result.error === 16 || result.error === 11) {
        await queueOfflineScrobble(scrobbleTrack);
      }
      await new Promise(r => chrome.storage.local.set({
        lastScrobble: { ...scrobbleEntry, error: `Last.fm ${result.error}: ${result.message}` },
      }, r));
    } else {
      await pushToHistory(scrobbleEntry);
      await notifyScrobbled(scrobbleEntry.track);
      // Successful scrobble — opportunistically flush any queued ones
      flushOfflineQueue().catch(() => {});
    }
  } catch (e) {
    // Network error / fetch threw — queue for retry
    console.error('[Scrobbler] Scrobble failed:', e);
    await queueOfflineScrobble(scrobbleTrack);
    await new Promise(r => chrome.storage.local.set({
      lastScrobble: { ...scrobbleEntry, error: 'Network error — queued for retry' },
    }, r));
  }
}

// Called whenever we want to sync the current tab state with our tracking
async function syncTabState() {
  const live = await readAmazonTab();
  if (!live) return;

  const state = await getLocalState();
  const isNew = !state.currentTrack ||
    state.currentTrack.title !== live.title ||
    state.currentTrack.artist !== live.artist;

  if (isNew) {
    // Before logging the new track, try to scrobble the previous one
    // (covers the case where the alarm fired late or was set with duration=0)
    if (state.currentTrack && !state.currentScrobbled) {
      const elapsed = Math.floor(Date.now() / 1000) - (state.currentTrackAt || 0);
      const dur = state.currentTrack.duration || 0;
      const threshold = dur > 30 ? Math.min(dur * 0.5, 240) : 120;
      if (elapsed >= threshold) await tryScrobbleNow();
    }
    await onNewTrack({
      title: live.title,
      artist: live.artist,
      album: live.album,
      duration: live.duration,
    });
    return;
  }

  // If duration was 0 when the track started, update it now and reschedule alarm
  if (live.duration > 30 && !(state.currentTrack?.duration > 30)) {
    await new Promise(r => chrome.storage.local.set(
      { currentTrack: { ...state.currentTrack, duration: live.duration } }, r
    ));
    const elapsed = Math.floor(Date.now() / 1000) - (state.currentTrackAt || 0);
    const remaining = Math.min(live.duration * 0.5, 240) - elapsed;
    if (remaining > 5) {
      chrome.alarms.create('scrobble_pending', { delayInMinutes: remaining / 60 });
    } else if (!state.currentScrobbled) {
      await tryScrobbleNow();
    }
    return;
  }

  // Inline threshold check (backup if alarm misfires)
  if (!state.currentScrobbled && live.duration > 30 && live.currentTime > 0) {
    const threshold = Math.min(live.duration * 0.5, 240);
    if (live.currentTime >= threshold) await tryScrobbleNow();
  }
}

// Note: keepAlive port removed from content script — the REQUEST_SYNC heartbeat
// (sendMessage every 10 s) wakes the service worker and is sufficient.

// ── Alarms ────────────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === 'scrobble_pending') await tryScrobbleNow();
  if (alarm.name === 'track_poll') {
    await syncTabState();
    await flushOfflineQueue(); // periodic retry
  }
});

// ── Tab events → sync state ───────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const isAmazon = AMAZON_MUSIC_PATTERNS.some(p =>
    tab.url?.startsWith(p.replace('/*', ''))
  );
  if (!isAmazon) return;
  // Trigger on title change OR when page finishes loading
  if (changeInfo.title || changeInfo.status === 'complete') {
    await syncTabState();
  }
});

// Sync when user switches to an Amazon Music tab
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    const isAmazon = AMAZON_MUSIC_PATTERNS.some(p =>
      tab.url?.startsWith(p.replace('/*', ''))
    );
    if (isAmazon) await syncTabState();
  } catch (_) {}
});

// ── Message handling ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handle = async () => {
    switch (msg.type) {

      // Content script detected a new track — use its data directly (faster + more reliable)
      case 'NOW_PLAYING': {
        const track = msg.track;
        if (track?.title && track?.artist) {
          const state = await getLocalState();
          const isNew = !state.currentTrack ||
            state.currentTrack.title !== track.title ||
            state.currentTrack.artist !== track.artist;
          if (isNew) {
            if (state.currentTrack && !state.currentScrobbled) {
              const elapsed = Math.floor(Date.now() / 1000) - (state.currentTrackAt || 0);
              const dur = state.currentTrack.duration || 0;
              const threshold = dur > 30 ? Math.min(dur * 0.5, 240) : 120;
              if (elapsed >= threshold) await tryScrobbleNow();
            }
            await onNewTrack(track);
          }
        } else {
          await syncTabState();
        }
        return { ok: true };
      }

      // Content script signals scrobble threshold met
      case 'SCROBBLE': {
        const state = await getLocalState();
        if (state.currentScrobbled) return { ok: true };
        await tryScrobbleNow();
        return { ok: true };
      }

      case 'QUEUE_OFFLINE':
        if (msg.track) await queueOfflineScrobble(msg.track);
        return { ok: true };

      case 'FLUSH_QUEUE':
        flushOfflineQueue().catch(() => {});
        return { ok: true };

      case 'GET_SETTINGS':
        return { ok: true, settings: await getSettings() };

      case 'UPDATE_SETTINGS': {
        const current = await getSettings();
        const next = { ...current, ...(msg.settings || {}) };
        await new Promise(r => chrome.storage.sync.set(next, r));
        return { ok: true, settings: next };
      }

      case 'RE_SCROBBLE': {
        // User wants to resend a past scrobble (e.g. Last.fm didn't receive it)
        const t = msg.track;
        if (!t?.title || !t?.artist) return { ok: false, error: 'Missing track info' };
        const payload = {
          title:     t.title,
          artist:    t.artist,
          album:     t.album || '',
          duration:  t.duration || 0,
          timestamp: Math.floor(Date.now() / 1000), // new timestamp = now
        };
        try {
          const result = await callScrobble(payload);
          if (result?.error) return { ok: false, error: result.message };
          await pushToHistory({ track: payload, at: Date.now(), manual: true });
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e.message || 'Network error' };
        }
      }

      case 'LOVE_TRACK': {
        const result = await lastfmPost('track.love', { artist: msg.artist, track: msg.track });
        if (result?.error) return { ok: false, error: result.message };
        return { ok: true };
      }

      case 'UNLOVE_TRACK': {
        const result = await lastfmPost('track.unlove', { artist: msg.artist, track: msg.track });
        if (result?.error) return { ok: false, error: result.message };
        return { ok: true };
      }

      case 'REQUEST_SYNC':
        await syncTabState();
        return { ok: true };

      case 'START_AUTH': {
        try {
          return { ok: true, ...(await startAuth()) };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      }

      case 'SAVE_CREDENTIALS':
        await new Promise(r =>
          chrome.storage.sync.set({ apiKey: msg.apiKey, apiSecret: msg.apiSecret }, r)
        );
        return { ok: true };

      case 'GET_STATUS': {
        const creds = await getCredentials();
        const state = await getLocalState();

        // Read live state directly from tab — no content script needed
        const liveTrack = await readAmazonTab();

        // Process track state whenever Media Session has metadata (even if briefly paused)
        if (liveTrack) {
          const isNew = !state.currentTrack ||
            state.currentTrack.title !== liveTrack.title ||
            state.currentTrack.artist !== liveTrack.artist;

          if (isNew) {
            // Scrobble previous track before switching
            if (state.currentTrack && !state.currentScrobbled) {
              const elapsed = Math.floor(Date.now() / 1000) - (state.currentTrackAt || 0);
              const dur = state.currentTrack.duration || 0;
              const threshold = dur > 30 ? Math.min(dur * 0.5, 240) : 120;
              if (elapsed >= threshold) await tryScrobbleNow();
            }
            await onNewTrack({
              title: liveTrack.title,
              artist: liveTrack.artist,
              album: liveTrack.album,
              duration: liveTrack.duration,
            });
          } else {
            // Update stored duration if audio metadata loaded after track was first seen
            if (liveTrack.duration > 30 && !(state.currentTrack?.duration > 30)) {
              await new Promise(r => chrome.storage.local.set(
                { currentTrack: { ...state.currentTrack, duration: liveTrack.duration } }, r
              ));
              const elapsed = Math.floor(Date.now() / 1000) - (state.currentTrackAt || 0);
              const remaining = Math.min(liveTrack.duration * 0.5, 240) - elapsed;
              if (remaining > 5) {
                chrome.alarms.create('scrobble_pending', { delayInMinutes: remaining / 60 });
              } else if (!state.currentScrobbled) {
                await tryScrobbleNow();
              }
            }
            // Inline threshold check when actively playing (backup while popup is open)
            if (liveTrack.isPlaying && !state.currentScrobbled &&
                liveTrack.duration > 30 && liveTrack.currentTime > 0) {
              if (liveTrack.currentTime >= Math.min(liveTrack.duration * 0.5, 240)) {
                await tryScrobbleNow();
              }
            }
          }
        }

        const freshState = await getLocalState();
        const settings = await getSettings();
        const { offlineQueue = [] } = await new Promise(r =>
          chrome.storage.local.get('offlineQueue', r));
        return {
          ok: true,
          hasCredentials: !!(creds.apiKey && creds.apiSecret),
          authenticated: !!creds.sessionKey,
          username: creds.username || null,
          liveTrack: liveTrack || null,
          lastScrobble: freshState.lastScrobble || null,
          scrobbleHistory: freshState.scrobbleHistory || [],
          settings,
          offlineQueueSize: offlineQueue.length,
        };
      }

      case 'DISCONNECT':
        await new Promise(r => chrome.storage.sync.remove(['sessionKey', 'username'], r));
        await new Promise(r => chrome.storage.local.clear(r));
        chrome.alarms.clearAll();
        return { ok: true };

      case 'CLEAR_CREDENTIALS':
        await new Promise(r => chrome.storage.sync.clear(r));
        await new Promise(r => chrome.storage.local.clear(r));
        chrome.alarms.clearAll();
        return { ok: true };

      default:
        return { ok: false, error: `Unknown message type: ${msg.type}` };
    }
  };

  handle().then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
  return true;
});

// ── Startup: inject content script into already-open tabs ─────────────────────

async function injectIntoExistingTabs() {
  const tabs = await chrome.tabs.query({ url: AMAZON_MUSIC_PATTERNS });
  for (const tab of tabs) {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {});
  }
}

// On every service worker startup, recover any scrobble that was missed while asleep
async function recoverMissedScrobble() {
  const state = await getLocalState();
  if (!state.currentTrack || state.currentScrobbled || !state.currentTrackAt) return;
  const elapsed = Math.floor(Date.now() / 1000) - state.currentTrackAt;
  const dur = state.currentTrack.duration || 0;
  const threshold = dur > 30 ? Math.min(dur * 0.5, 240) : 120;
  if (elapsed >= threshold) {
    await tryScrobbleNow();
  } else {
    // Alarm may have been cleared when worker was terminated — reschedule
    const remaining = Math.max(threshold - elapsed, 30);
    chrome.alarms.create('scrobble_pending', { delayInMinutes: remaining / 60 });
  }
}

chrome.runtime.onInstalled.addListener(injectIntoExistingTabs);
injectIntoExistingTabs();
recoverMissedScrobble();

// Sync current tab state on every service worker startup.
// This catches the case where the worker was killed mid-song.
syncTabState().catch(() => {});

// Retry any scrobbles that were queued while offline
flushOfflineQueue().catch(() => {});

// Initial badge paint
updateBadge();

// ── Keyboard shortcut: toggle scrobbling ──────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-scrobbling') return;
  const settings = await getSettings();
  const next = !settings.scrobblingEnabled;
  await new Promise(r => chrome.storage.sync.set({ scrobblingEnabled: next }, r));
  updateBadge();
  // Briefly notify so the user sees the new state even without opening the popup
  try {
    chrome.notifications.create('', {
      type:    'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title:   next ? 'Scrobbling on' : 'Scrobbling paused',
      message: next ? 'Listening for plays.' : 'Plays will not be sent to Last.fm.',
      silent:  true,
    });
  } catch (_) {}
});

// Repeating alarm: re-sync every 30 s (Chrome's minimum alarm period).
// This ensures track detection catches up even if all other mechanisms fail.
chrome.alarms.get('track_poll', alarm => {
  if (!alarm) chrome.alarms.create('track_poll', { periodInMinutes: 0.5 });
});
