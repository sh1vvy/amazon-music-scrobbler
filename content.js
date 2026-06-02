// content.js — runs inside the Amazon Music tab
// Handles ALL scrobbling: detection, timing, and Last.fm API calls.
// No dependency on the background service worker staying alive.

(function () {
  // Guard: skip if a live instance is already running.
  // Uses a function so we can detect orphaned instances (extension reloaded).
  if (window.__amScrobblerAlive) {
    try { if (window.__amScrobblerAlive()) return; } catch (_) {}
  }
  window.__amScrobblerAlive = () => {
    try { return !!chrome.runtime.id; } catch (_) { return false; }
  };

  const LASTFM_API = 'https://ws.audioscrobbler.com/2.0/';

  // ── MD5 ──────────────────────────────────────────────────────────────────────

  function md5(input) {
    const bytes = Array.from(new TextEncoder().encode(input));
    let a = 0x67452301, b = 0xEFCDAB89, c = 0x98BADCFE, d = 0x10325476;
    const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
    const K = Array.from({length:64},(_,i)=>(Math.abs(Math.sin(i+1))*0x100000000)>>>0);
    const bitLen = bytes.length * 8;
    const padded = [...bytes, 0x80];
    while (padded.length % 64 !== 56) padded.push(0);
    for (let i=0;i<4;i++) padded.push((bitLen>>>(i*8))&0xff);
    for (let i=0;i<4;i++) padded.push(0);
    const add=(x,y)=>(x+y)>>>0, rol=(v,n)=>((v<<n)|(v>>>(32-n)))>>>0;
    for (let i=0;i<padded.length;i+=64){
      const M=Array.from({length:16},(_,j)=>((padded[i+j*4+3]<<24)|(padded[i+j*4+2]<<16)|(padded[i+j*4+1]<<8)|padded[i+j*4])>>>0);
      let A=a,B=b,C=c,D=d;
      for(let j=0;j<64;j++){
        let F,g;
        if(j<16){F=((B&C)|(~B&D))>>>0;g=j;}
        else if(j<32){F=((D&B)|(~D&C))>>>0;g=(5*j+1)%16;}
        else if(j<48){F=(B^C^D)>>>0;g=(3*j+5)%16;}
        else{F=(C^(B|~D))>>>0;g=(7*j)%16;}
        const T=D;D=C;C=B;B=add(B,rol(add(add(A,F),add(K[j],M[g])),S[j]));A=T;
      }
      a=add(a,A);b=add(b,B);c=add(c,C);d=add(d,D);
    }
    return [a,b,c,d].map(n=>Array.from({length:4},(_,i)=>((n>>>(i*8))&0xff).toString(16).padStart(2,'0')).join('')).join('');
  }

  // ── Last.fm API ───────────────────────────────────────────────────────────────

  function makeSignature(params, secret) {
    return md5(
      Object.keys(params).filter(k=>k!=='format'&&k!=='callback').sort()
        .map(k=>`${k}${params[k]??''}`).join('') + secret
    );
  }

  async function getCreds() {
    return new Promise(r => chrome.storage.sync.get(['apiKey','apiSecret','sessionKey'], r));
  }

  // Read scrobble toggle (default true) — gates all scrobble sends from this script
  async function isScrobblingEnabled() {
    return new Promise(r => chrome.storage.sync.get({ scrobblingEnabled: true },
      ({ scrobblingEnabled }) => r(!!scrobblingEnabled)));
  }

  async function lastfmPost(method, extra = {}) {
    const { apiKey, apiSecret, sessionKey } = await getCreds();
    if (!apiKey || !apiSecret || !sessionKey) return null;
    const p = { method, api_key: apiKey, ...extra, format: 'json', sk: sessionKey };
    p.api_sig = makeSignature(p, apiSecret);
    try {
      const res = await fetch(LASTFM_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(p),
      });
      return res.json();
    } catch (_) { return null; }
  }

  function sendNowPlaying(track) {
    const p = { artist: track.artist, track: track.title };
    if (track.album) p.album = track.album;
    lastfmPost('track.updateNowPlaying', p).catch(() => {});
  }

  function pushToHistory(entry) {
    chrome.storage.local.get('scrobbleHistory', ({ scrobbleHistory = [] }) => {
      const history = Array.isArray(scrobbleHistory) ? scrobbleHistory : [];
      chrome.storage.local.set({
        scrobbleHistory: [entry, ...history].slice(0, 5),
      });
    });
  }

  async function sendScrobble(track) {
    const p = {
      'artist[0]': track.artist,
      'track[0]':  track.title,
      'timestamp[0]': String(track.timestamp || Math.floor(Date.now() / 1000)),
    };
    if (track.album)    p['album[0]']    = track.album;
    if (track.duration) p['duration[0]'] = String(Math.floor(track.duration));
    return lastfmPost('track.scrobble', p);
  }

  // ── Track state ───────────────────────────────────────────────────────────────

  let currentTrack    = null;
  let audioEl         = null;
  let scrobbled       = false;
  let trackStartTs    = null;   // unix seconds when current track started
  let scrobbleTimer   = null;

  function getMetadata() {
    // Amazon Music's new player renders track info as attributes on a custom
    // element inside the transport bar — this is the same approach used by
    // web-scrobbler and is far more reliable than navigator.mediaSession, which
    // content scripts in an isolated world cannot always observe reliably.
    const item = document.querySelector('#transport music-horizontal-item');
    if (item) {
      const title  = item.getAttribute('primary-text');
      const artist = item.getAttribute('secondary-text');
      if (title && artist) {
        return {
          title:  cleanStr(title),
          artist: cleanStr(artist),
          album:  '',
          image:  navigator.mediaSession?.metadata?.artwork?.[0]?.src || '',
          duration: audioEl?.duration || 0,
        };
      }
    }
    // Fallback: MediaSession API (covers edge cases / other Amazon Music layouts)
    const m = navigator.mediaSession?.metadata;
    if (m?.title && m?.artist) {
      return {
        title:    cleanStr(m.title),
        artist:   cleanStr(m.artist),
        album:    m.album || '',
        image:    m.artwork?.[0]?.src || '',
        duration: audioEl?.duration || 0,
      };
    }
    return null;
  }

  // Strip Amazon Music version/content tags that pollute Last.fm history.
  // e.g. "Big Dawgs [Explicit]" → "Big Dawgs", "Song (Clean Version)" → "Song"
  function cleanStr(str) {
    if (!str) return str;
    return str
      .replace(/\s*[\(\[](explicit|clean|explicit version|clean version|radio edit|radio version|album version|original mix)[\)\]]/gi, '')
      .trim();
  }

  function same(a, b) { return a && b && a.title === b.title && a.artist === b.artist; }

  function clearTimer() {
    if (scrobbleTimer) { clearTimeout(scrobbleTimer); scrobbleTimer = null; }
  }

  function startTrack(track) {
    // Before overwriting state, scrobble the previous track if it reached the
    // threshold but the timeupdate/timer hadn't fired yet (happens on skips,
    // especially when the tab was in the background and timers were throttled).
    if (currentTrack && !scrobbled && trackStartTs) {
      const elapsed = Math.floor(Date.now() / 1000) - trackStartTs;
      const dur = currentTrack.duration || 0;
      const threshold = dur > 30 ? Math.min(dur * 0.5, 240) : 120;
      if (elapsed >= threshold) {
        const payload = { ...currentTrack, timestamp: trackStartTs, duration: dur };
        sendScrobble(payload).catch(() => {});
        chrome.storage.local.set({ currentScrobbled: true });
      }
    }

    clearTimer();
    currentTrack = { ...track };
    scrobbled    = false;
    // Back-calculate the real start time using the audio position so the
    // Last.fm timestamp is accurate even when detection was slightly delayed.
    const currentPos = Math.floor(audioEl?.currentTime || 0);
    trackStartTs = Math.floor(Date.now() / 1000) - currentPos;

    // Persist for popup
    chrome.storage.local.set({
      currentTrack,
      currentTrackAt: trackStartTs,
      currentScrobbled: false,
      isPlaying: true,
    });

    // Notify background (popup display only — scrobbling is done here)
    chrome.runtime.sendMessage({ type: 'NOW_PLAYING', track }).catch(() => {});

    sendNowPlaying(track);
    // Scrobble threshold is now detected via the 'timeupdate' event (wired in
    // wire()) which Chrome does not throttle in background tabs, unlike setInterval.
  }

  async function checkScrobble() {
    if (scrobbled || !currentTrack || !audioEl || audioEl.paused) return;
    const dur = audioEl.duration, pos = audioEl.currentTime;
    if (!dur || !isFinite(dur) || dur < 30) return;
    const threshold = Math.min(dur * 0.5, 240);
    if (pos < threshold) return;

    scrobbled = true;

    // Respect the user's scrobble toggle.  We still mark scrobbled=true so we
    // don't re-evaluate every timeupdate, but we don't actually call Last.fm.
    if (!(await isScrobblingEnabled())) return;

    const payload = { ...currentTrack, timestamp: trackStartTs, duration: dur };
    const entry   = { track: payload, at: Date.now() };

    chrome.storage.local.set({ currentScrobbled: true, lastScrobble: entry });

    sendScrobble(payload).then(result => {
      if (result?.error) {
        chrome.storage.local.set({
          lastScrobble: { ...entry, error: `Last.fm ${result.error}: ${result.message}` },
        });
        // Network-y Last.fm errors → ask background to queue for retry
        if (result.error === 16 || result.error === 11) {
          try { chrome.runtime.sendMessage({ type: 'QUEUE_OFFLINE', track: payload }).catch(() => {}); } catch (_) {}
        }
      } else {
        pushToHistory(entry);
        // Ask background to flush any other queued scrobbles now that we're back online
        try { chrome.runtime.sendMessage({ type: 'FLUSH_QUEUE' }).catch(() => {}); } catch (_) {}
      }
    }).catch(() => {
      // Network failure — ask background to queue
      try { chrome.runtime.sendMessage({ type: 'QUEUE_OFFLINE', track: payload }).catch(() => {}); } catch (_) {}
      chrome.storage.local.set({
        lastScrobble: { ...entry, error: 'Network error — queued for retry' },
      });
    });
  }

  // ── Audio element wiring ──────────────────────────────────────────────────────

  function wire(audio) {
    // Combined handler for track changes AND scrobble threshold.
    // timeupdate fires ~250 ms during playback and is NOT throttled in background
    // tabs (unlike setInterval). By checking for metadata changes here we catch
    // skips and natural song transitions even when loadstart doesn't fire (e.g.
    // Amazon Music uses MSE / continuous streaming) and even when the tab is
    // in the background.
    let lastPos = 0;

    audio.addEventListener('timeupdate', () => {
      if (audio.paused) return;
      const pos = audio.currentTime;

      // Detect repeat: position jumped back to near-zero while we already
      // scrobbled this play. Amazon Music's "repeat one" mode often just seeks
      // back to 0 without firing the ended event, so scrobbled stays true.
      if (scrobbled && pos < 3 && lastPos > 10) {
        scrobbled    = false;
        trackStartTs = Math.floor(Date.now() / 1000) - Math.floor(pos);
        chrome.storage.local.set({ currentScrobbled: false, currentTrackAt: trackStartTs });
      }
      lastPos = pos;

      const track = getMetadata();
      if (track && !same(track, currentTrack)) {
        startTrack(track);
      } else {
        checkScrobble();
      }
    });

    // loadstart = new audio source loading (skip or next song)
    audio.addEventListener('loadstart', () => {
      // Give Media Session 400 ms to update before reading metadata
      setTimeout(() => {
        const track = getMetadata();
        if (!track) return;
        if (!same(track, currentTrack)) {
          startTrack(track);
        } else if (currentTrack) {
          // Same track reloaded (e.g. user clicked "previous" and landed on the
          // same song, or the player seeked back to the start).  Reset scrobble
          // state so this listen counts as a fresh play.
          scrobbled    = false;
          trackStartTs = Math.floor(Date.now() / 1000);
          chrome.storage.local.set({ currentScrobbled: false, currentTrackAt: trackStartTs });
        }
      }, 400);
    });

    audio.addEventListener('play', () => {
      const track = getMetadata();
      if (!track) return;
      chrome.storage.local.set({ isPlaying: true });
      if (!same(track, currentTrack)) startTrack(track);
      // No timer to restart — timeupdate handles threshold detection automatically.
    });

    audio.addEventListener('pause', () => {
      chrome.storage.local.set({ isPlaying: false });
    });

    audio.addEventListener('ended', () => {
      // Safety net: if timeupdate somehow missed the threshold, scrobble now.
      if (currentTrack && !scrobbled && trackStartTs) {
        const elapsed = Math.floor(Date.now() / 1000) - trackStartTs;
        const dur = audio.duration || currentTrack.duration || 0;
        const threshold = dur > 30 ? Math.min(dur * 0.5, 240) : 120;
        if (elapsed >= threshold) {
          const payload = { ...currentTrack, timestamp: trackStartTs, duration: dur };
          const entry   = { track: payload, at: Date.now() };
          chrome.storage.local.set({ currentScrobbled: true, lastScrobble: entry });
          sendScrobble(payload).then(r => { if (!r?.error) pushToHistory(entry); }).catch(() => {});
        }
      }
      clearTimer();
      currentTrack = null;
      scrobbled    = false;
      chrome.storage.local.set({ isPlaying: false });
    });
  }

  // ── Player DOM observer ───────────────────────────────────────────────────────
  // Watch #transport for attribute mutations on music-horizontal-item.
  // Amazon Music sets primary-text/secondary-text when the track changes, so
  // this fires immediately — no polling lag, works in background tabs.

  let playerObserverAttached = false;
  let playerObserverDebounce = null;

  function observePlayer() {
    if (playerObserverAttached) return;
    const transport = document.querySelector('#transport');
    if (!transport) return;
    playerObserverAttached = true;

    new MutationObserver(() => {
      // Debounce: Amazon Music fires many mutations per track change
      if (playerObserverDebounce) return;
      playerObserverDebounce = setTimeout(() => {
        playerObserverDebounce = null;
        const track = getMetadata();
        if (track && !same(track, currentTrack)) startTrack(track);
      }, 200);
    }).observe(transport, {
      attributes: true,
      // No attributeFilter — catch element replacement (childList) too
      subtree: true,
      childList: true,
    });

    // *** Critical: read state NOW — the attribute may already be set ***
    // The observer only fires on future changes; without this, the currently
    // playing track when the observer first attaches is never detected.
    const track = getMetadata();
    if (track && !same(track, currentTrack)) startTrack(track);
  }

  function findAudio() {
    observePlayer(); // attach player observer as soon as #transport exists
    const audio = document.querySelector('audio');
    if (audio && audio !== audioEl) {
      audioEl = audio;
      wire(audio);
      if (!audio.paused) {
        const track = getMetadata();
        if (track && !same(track, currentTrack)) startTrack(track);
      }
    }
  }

  new MutationObserver(findAudio).observe(document.documentElement, { childList: true, subtree: true });

  // Polling fallback (2 s) — primarily to catch audio element replacement
  // (Amazon Music occasionally swaps the <audio> node).  Track-change detection
  // and scrobble checks are handled by the timeupdate listener above, which is
  // not throttled in background tabs.  This interval IS throttled but that's
  // fine — finding a new audio node is a rare, recoverable event.
  setInterval(() => {
    findAudio();
    // Extra safety net: if timeupdate somehow missed a track change, catch it here.
    if (audioEl && !audioEl.paused) {
      const track = getMetadata();
      if (track && !same(track, currentTrack)) startTrack(track);
    }
  }, 2000);

  findAudio();

  // Returns false when the extension context has been invalidated (extension
  // reloaded/updated). Used to stop background tasks on stale instances.
  function contextAlive() {
    try { return !!chrome.runtime.id; } catch (_) { return false; }
  }

  // Ask background to run executeScript-based detection on load.
  // Periodic re-sync is handled by the background's track_poll alarm (every 30 s)
  // so we don't need a setInterval here — that would throw on every tick after
  // the extension is reloaded while the tab is still open.
  try {
    chrome.runtime.sendMessage({ type: 'REQUEST_SYNC' }).catch(() => {});
  } catch (_) {}

  // ── Sync track state written by the background ───────────────────────────────
  // background.js is woken by tabs.onUpdated (title change) when the user skips
  // a track.  It reads the new track via executeScript / readAmazonTab() and
  // writes it to chrome.storage.local.  We mirror that here so the in-memory
  // currentTrack never stays stale — this is the key fix for the wrong-track
  // scrobble: if timeupdate's own metadata detection missed the change, the
  // storage listener will catch it within milliseconds of the background writing.

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if (changes.currentTrack) {
      const newTrack = changes.currentTrack.newValue;
      if (newTrack && !same(newTrack, currentTrack)) {
        // Background detected a track we missed — adopt its state.
        // Don't call startTrack() here: background already sent now-playing
        // to Last.fm and set the alarm; just update in-memory state so
        // checkScrobble uses the right track.
        clearTimer();
        currentTrack = { ...newTrack };
        scrobbled    = false;
        trackStartTs = changes.currentTrackAt?.newValue
          ?? Math.floor(Date.now() / 1000);
      }
    }

    // Mirror the scrobbled flag to prevent double-scrobbling.
    // Background may scrobble via alarm; content script must not scrobble again.
    if (changes.currentScrobbled?.newValue === true) {
      scrobbled = true;
    }
  });

  // ── Respond to popup queries ──────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _, sendResponse) => {
    if (msg.type === 'GET_CURRENT_TRACK') {
      sendResponse({ track: currentTrack, isPlaying: audioEl ? !audioEl.paused : false });
    }
  });
})();
