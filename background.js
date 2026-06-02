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
  if (!tabs.length) return null;

  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: () => {
        const meta = navigator.mediaSession?.metadata;
        const audio = document.querySelector('audio');
        if (!meta?.title || !meta?.artist) return null;
        return {
          title: meta.title,
          artist: meta.artist,
          album: meta.album || '',
          duration: audio?.duration || 0,
          currentTime: audio?.currentTime || 0,
          isPlaying: audio ? !audio.paused : false,
        };
      },
    });
    return res?.result || null;
  } catch (_) {
    return null;
  }
}

// ── Track state ────────────────────────────────────────────────────────────────

function getLocalState() {
  return new Promise(r =>
    chrome.storage.local.get(
      ['currentTrack', 'currentTrackAt', 'currentScrobbled', 'lastScrobble'],
      r
    )
  );
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
  chrome.alarms.create('scrobble_pending', { delayInSeconds: delaySec });
}

async function tryScrobbleNow() {
  const state = await getLocalState();
  if (!state.currentTrack || state.currentScrobbled) return;

  const { sessionKey } = await getCredentials();
  if (!sessionKey) return;

  const live = await readAmazonTab();

  // If a *different* track is actively playing right now, don't scrobble the stored one
  if (live?.isPlaying &&
      (live.title !== state.currentTrack.title || live.artist !== state.currentTrack.artist)) {
    return;
  }

  // Best estimates: prefer live values, fall back to stored/elapsed
  const duration = (live?.duration > 0 ? live.duration : 0) || state.currentTrack.duration || 0;
  const elapsed  = Math.floor(Date.now() / 1000) - (state.currentTrackAt || 0);
  const position = (live?.currentTime > 0 ? live.currentTime : 0) || elapsed;

  // Last.fm rule: track must be longer than 30 seconds
  if (duration > 0 && duration < 30) return;

  // Must have played to the scrobble threshold (50% or 4 min); 2 min if duration unknown
  const threshold = duration > 30 ? Math.min(duration * 0.5, 240) : 120;
  if (position < threshold && elapsed < threshold) {
    // Too early — reschedule for when we should actually hit the threshold
    const remaining = Math.max(threshold - Math.max(position, elapsed), 30);
    chrome.alarms.create('scrobble_pending', { delayInSeconds: remaining });
    return;
  }

  const scrobbleEntry = { track: state.currentTrack, at: Date.now() };

  await new Promise(r => chrome.storage.local.set({
    currentScrobbled: true,
    lastScrobble: scrobbleEntry,
  }, r));

  try {
    const result = await callScrobble({ ...state.currentTrack, timestamp: state.currentTrackAt });
    if (result?.error) {
      console.error('[Scrobbler] Last.fm error:', result.error, result.message);
      await new Promise(r => chrome.storage.local.set({
        lastScrobble: { ...scrobbleEntry, error: `Last.fm ${result.error}: ${result.message}` },
      }, r));
    }
  } catch (e) {
    console.error('[Scrobbler] Scrobble failed:', e);
    await new Promise(r => chrome.storage.local.set({
      lastScrobble: { ...scrobbleEntry, error: e.message },
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
      chrome.alarms.create('scrobble_pending', { delayInSeconds: remaining });
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

// ── Alarms ────────────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === 'scrobble_pending') await tryScrobbleNow();
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

      // Content script signals a play event — sync immediately
      case 'NOW_PLAYING':
        await syncTabState();
        return { ok: true };

      // Content script signals scrobble threshold met
      case 'SCROBBLE': {
        const state = await getLocalState();
        if (state.currentScrobbled) return { ok: true };
        await tryScrobbleNow();
        return { ok: true };
      }

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
                chrome.alarms.create('scrobble_pending', { delayInSeconds: remaining });
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
        return {
          ok: true,
          hasCredentials: !!(creds.apiKey && creds.apiSecret),
          authenticated: !!creds.sessionKey,
          username: creds.username || null,
          liveTrack: liveTrack || null,
          lastScrobble: freshState.lastScrobble || null,
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

chrome.runtime.onInstalled.addListener(injectIntoExistingTabs);
injectIntoExistingTabs();
