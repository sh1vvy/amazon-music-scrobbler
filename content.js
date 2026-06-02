// content.js — runs on Amazon Music pages

(function () {
  // Guard against duplicate execution.
  // Uses a liveness-check function so we can detect when a previous instance became
  // orphaned (extension was reloaded) — chrome.runtime.id throws on orphaned contexts.
  if (window.__amScrobblerAlive) {
    try {
      if (window.__amScrobblerAlive()) return; // live instance already running, skip
    } catch (_) {
      // Previous instance's extension context is invalidated → fall through and reinitialize
    }
  }
  window.__amScrobblerAlive = () => {
    try { return !!chrome.runtime.id; } catch (_) { return false; }
  };

  let currentTrack = null;
  let audioEl = null;
  let scrobbled = false;
  let nowPlayingReported = false;
  let trackStartTimestamp = null;

  function getMetadata() {
    const meta = navigator.mediaSession?.metadata;
    if (meta?.title && meta?.artist) {
      return {
        title: meta.title,
        artist: meta.artist,
        album: meta.album || '',
        duration: audioEl?.duration || 0,
      };
    }
    return scrapeFromDOM();
  }

  function scrapeFromDOM() {
    const titleSelectors = [
      '[data-testid="track-title"]', '[class*="trackTitle"]',
      '[class*="track-title"]', '[class*="TrackTitle"]',
    ];
    const artistSelectors = [
      '[data-testid="track-artist"]', '[class*="artistName"]',
      '[class*="artist-name"]', '[class*="ArtistName"]',
    ];
    let title = null, artist = null;
    for (const sel of titleSelectors) {
      const el = document.querySelector(sel);
      if (el?.textContent?.trim()) { title = el.textContent.trim(); break; }
    }
    for (const sel of artistSelectors) {
      const el = document.querySelector(sel);
      if (el?.textContent?.trim()) { artist = el.textContent.trim(); break; }
    }
    if (!title || !artist) return null;
    return { title, artist, album: '', duration: audioEl?.duration || 0 };
  }

  function isSameTrack(a, b) {
    if (!a || !b) return false;
    return a.title === b.title && a.artist === b.artist;
  }

  function onNewTrack(track) {
    currentTrack = { ...track };
    scrobbled = false;
    nowPlayingReported = false;
    trackStartTimestamp = Math.floor(Date.now() / 1000);
    reportNowPlaying(track);
  }

  function reportNowPlaying(track) {
    nowPlayingReported = true;
    chrome.runtime.sendMessage({ type: 'NOW_PLAYING', track }).catch(() => {});
  }

  function checkScrobbleThreshold() {
    if (scrobbled || !currentTrack || !audioEl) return;
    const duration = audioEl.duration;
    const position = audioEl.currentTime;
    if (!duration || !isFinite(duration) || duration < 30) return;
    const threshold = Math.min(duration * 0.5, 240);
    if (position >= threshold) {
      scrobbled = true;
      chrome.runtime.sendMessage({
        type: 'SCROBBLE',
        track: { ...currentTrack, timestamp: trackStartTimestamp },
      }).catch(() => {});
    }
  }

  function attachAudioListeners(audio) {
    audio.addEventListener('play', () => {
      const track = getMetadata();
      if (!track) return;
      if (!isSameTrack(track, currentTrack)) {
        onNewTrack(track);
      } else if (!nowPlayingReported) {
        reportNowPlaying(track);
      }
    });

    audio.addEventListener('timeupdate', () => {
      if (audio.paused) return;
      const track = getMetadata();
      if (!track) return;
      if (!isSameTrack(track, currentTrack)) {
        onNewTrack(track);
        return;
      }
      checkScrobbleThreshold();
    });

    audio.addEventListener('ended', () => {
      currentTrack = null;
      scrobbled = false;
      nowPlayingReported = false;
      trackStartTimestamp = null;
    });
  }

  function findAndAttachAudio() {
    const audio = document.querySelector('audio');
    if (audio && audio !== audioEl) {
      audioEl = audio;
      attachAudioListeners(audio);
      if (!audio.paused) {
        const track = getMetadata();
        if (track && !isSameTrack(track, currentTrack)) {
          onNewTrack(track);
        }
      }
    }
  }

  // Watch for audio element being added dynamically
  const domObserver = new MutationObserver(findAndAttachAudio);
  domObserver.observe(document.documentElement, { childList: true, subtree: true });

  // Poll every second as fallback — catches Media Session updates we might miss
  setInterval(() => {
    findAndAttachAudio();
    if (audioEl && !audioEl.paused) {
      const track = getMetadata();
      if (track && !isSameTrack(track, currentTrack)) {
        onNewTrack(track);
      }
    }
  }, 1000);

  // Respond to popup's direct queries
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'GET_CURRENT_TRACK') {
      sendResponse({ track: currentTrack, isPlaying: audioEl ? !audioEl.paused : false });
    }
  });

  findAndAttachAudio();
})();
