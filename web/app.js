'use strict';
// Static IPTV player. No backend: the browser fetches the playlist and plays
// each stream directly from its origin, so hosting costs nothing and carries
// no video traffic.

const el = (id) => document.getElementById(id);
const video = el('video');

const state = {
  channels: [],
  filtered: [],
  group: 'all',
  query: '',
  current: null,
  hls: null,
  failed: new Set(),
  health: {},        // url -> true/false, measured by THIS browser
  scanning: false,
  hideDead: true,
};

function escapeHtml(s) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => map[c]);
}

function showOverlay(title, detail, spinning) {
  const o = el('overlay');
  o.classList.remove('hidden');
  const spin = spinning ? '<div class="spinner"></div>' : '';
  o.innerHTML =
    '<div>' + spin + '<strong>' + escapeHtml(title) + '</strong>' +
    escapeHtml(detail || '') + '</div>';
}

function hideOverlay() {
  el('overlay').classList.add('hidden');
}

// ---------------------------------------------------------------------------
// loading channels
//
// SNAPSHOT ships with the build so the site works instantly and offline-ish.
// We then try to refresh from the live playlist, because stream URLs rotate
// and some carry expiring tokens. Selection is re-applied to whatever we get.
// ---------------------------------------------------------------------------
const ATTR_RE = /([\w-]+)="([^"]*)"/g;

function splitExtinf(line) {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ',' && !inQuotes) {
      return { attrs: line.slice(0, i), title: line.slice(i + 1).trim() };
    }
  }
  return { attrs: line, title: '' };
}

function parseM3U(text) {
  const out = [];
  let pending = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const { attrs, title } = splitExtinf(line);
      const a = {};
      ATTR_RE.lastIndex = 0;
      let m;
      while ((m = ATTR_RE.exec(attrs)) !== null) a[m[1].toLowerCase()] = m[2];
      pending = {
        name: title || a['tvg-name'] || 'Unnamed',
        logo: a['tvg-logo'] || null,
        group: a['group-title'] || 'Ungrouped',
      };
      continue;
    }
    if (line.startsWith('#')) continue;
    if (pending) {
      out.push({ ...pending, url: line });
      pending = null;
    }
  }
  return out;
}

function applySelection(all) {
  const wanted = new Set(window.SELECTION || []);
  if (!wanted.size) return all;
  const seen = new Set();
  const out = [];
  for (const c of all) {
    // https only: a hosted site is https, and browsers block mixed content.
    if (!c.url.startsWith('https://')) continue;
    if (!wanted.has(c.name)) continue;
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push(c);
  }
  return out;
}

async function refreshFromSource() {
  if (!window.SOURCE_URL) return;
  try {
    const res = await fetch(window.SOURCE_URL, { cache: 'no-store' });
    if (!res.ok) return;
    const fresh = applySelection(parseM3U(await res.text()));
    if (fresh.length) {
      state.channels = fresh;
      applyFilter();
      el('freshness').textContent = 'updated just now';
    }
  } catch (e) {
    el('freshness').textContent = 'using bundled list';
  }
}

// ---------------------------------------------------------------------------
// playback - straight from the stream's own server
// ---------------------------------------------------------------------------
function destroyPlayer() {
  if (state.hls) {
    try { state.hls.destroy(); } catch (e) { /* already gone */ }
    state.hls = null;
  }
  try {
    video.removeAttribute('src');
    video.load();
  } catch (e) { /* ignore */ }
}

function play(channel) {
  state.current = channel;
  destroyPlayer();
  renderList();
  el('now-title').textContent = channel.name;
  el('now-meta').textContent = channel.group;
  showOverlay('Connecting...', channel.name, true);

  if (window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({
      lowLatencyMode: false,
      manifestLoadingMaxRetry: 2,
      levelLoadingMaxRetry: 2,
      fragLoadingMaxRetry: 3,
    });
    state.hls = hls;
    hls.on(window.Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
        return;
      }
      markFailed(channel, data);
    });
    hls.loadSource(channel.url);
    hls.attachMedia(video);
    video.play().catch(() => {});
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = channel.url;
    video.play().catch(() => {});
  } else {
    showOverlay('Unsupported browser', 'This browser cannot play HLS.', false);
  }
}

// Public playlists rot: channels go offline, get geo-fenced, or expire. Say so
// plainly instead of spinning forever.
function markFailed(channel, data) {
  state.failed.add(channel.name);
  // Trust real playback over the probe - it is the strongest signal we get.
  state.health[channel.url] = false;
  saveHealth();
  applyFilter();

  const isNetwork = data && data.type === 'networkError';
  const code = data && data.response && data.response.code;
  let why = 'This channel is not responding.';
  if (code === 403 || code === 401) {
    why = 'The stream refused the request (403). It is probably region-locked.';
  } else if (isNetwork) {
    why = 'Could not reach this stream. It may be offline, or only reachable ' +
          'from inside Bangladesh (BDIX channels usually are).';
  }
  showOverlay('Cannot play ' + channel.name, why + ' Try another channel.', false);
  el('now-meta').textContent = 'unavailable';
}

video.addEventListener('playing', () => {
  hideOverlay();
  if (state.current) {
    state.failed.delete(state.current.name);
    state.health[state.current.url] = true;
    saveHealth();
    el('now-meta').textContent = state.current.group;
    renderList();
  }
});

video.addEventListener('waiting', () => {
  el('now-meta').textContent = 'Buffering...';
});


// ---------------------------------------------------------------------------
// Per-viewer health scanning
//
// Whether a channel works depends on WHO is watching: BDIX streams answer
// inside Bangladesh and refuse everyone else, and plenty of public streams die
// without warning. So each browser tests the list on its own connection and
// hides what it cannot reach. A viewer in Dhaka and a viewer abroad end up
// with different, correct channel lists from the same build.
//
// Results are cached so this costs one sweep every few hours, not every load.
// ---------------------------------------------------------------------------
const HEALTH_KEY = 'iptv-health-v1';
const HEALTH_TTL_MS = 6 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 9000;
const PROBE_CONCURRENCY = 6;

function loadHealth() {
  try {
    const raw = localStorage.getItem(HEALTH_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || Date.now() - parsed.at > HEALTH_TTL_MS) return {};
    return parsed.map || {};
  } catch (e) {
    return {}; // private mode or blocked storage - just re-scan
  }
}

function saveHealth() {
  try {
    localStorage.setItem(HEALTH_KEY, JSON.stringify({ at: Date.now(), map: state.health }));
  } catch (e) { /* not fatal */ }
}

async function probeChannel(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store', redirect: 'follow' });
    if (!res.ok) return false;
    const text = await res.text();
    // A CORS-blocked or non-HLS response cannot be played by hls.js either,
    // so treating it as dead matches what the viewer would actually see.
    return text.indexOf('#EXTM3U') !== -1;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function scanHealth() {
  const todo = state.channels.filter((c) => state.health[c.url] === undefined);
  if (!todo.length) {
    updateHealthLabel(true);
    return;
  }

  state.scanning = true;
  let done = 0;
  const queue = todo.slice();

  const worker = async () => {
    while (queue.length) {
      const ch = queue.shift();
      state.health[ch.url] = await probeChannel(ch.url);
      done++;
      if (done % 5 === 0 || !queue.length) {
        updateHealthLabel(false, done, todo.length);
        applyFilter();
      }
    }
  };

  await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, worker));

  state.scanning = false;
  saveHealth();
  applyFilter();
  renderGroups();
  updateHealthLabel(true);
}

function deadCount() {
  return state.channels.filter((c) => state.health[c.url] === false).length;
}

function updateHealthLabel(finished, done, total) {
  const label = el('health');
  if (!label) return;
  if (!finished) {
    label.textContent = 'checking ' + done + '/' + total + '...';
    return;
  }
  const dead = deadCount();
  label.textContent = dead
    ? dead + ' unavailable ' + (state.hideDead ? 'hidden' : 'found')
    : 'all channels reachable';
}

function rescan() {
  state.health = {};
  saveHealth();
  applyFilter();
  scanHealth();
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
function groupsOf(channels) {
  const counts = new Map();
  for (const c of channels) {
    if (state.hideDead && state.health[c.url] === false) continue;
    counts.set(c.group, (counts.get(c.group) || 0) + 1);
  }
  // A group with nothing reachable here should not be offered at all.
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function renderGroups() {
  const wrap = el('cats');
  wrap.innerHTML = '';
  const visible = state.hideDead
    ? state.channels.filter((c) => state.health[c.url] !== false)
    : state.channels;
  const all = [['all', visible.length]].concat(groupsOf(state.channels));
  for (const [name, count] of all) {
    const b = document.createElement('button');
    b.className = 'cat' + (state.group === name ? ' active' : '');
    b.textContent = (name === 'all' ? 'All channels' : name) + '  (' + count + ')';
    b.title = name;
    b.onclick = () => {
      state.group = name;
      renderGroups();
      applyFilter();
    };
    wrap.appendChild(b);
  }
}

function placeholder(name) {
  const d = document.createElement('div');
  d.className = 'ph';
  d.textContent = (name || '?').replace(/[^\w]/g, '').trim().slice(0, 2).toUpperCase() || '?';
  return d;
}

function renderList() {
  const list = el('list');
  list.innerHTML = '';
  if (!state.filtered.length) {
    list.innerHTML = '<div class="list-note">No channels match.</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const ch of state.filtered) {
    const b = document.createElement('button');
    b.className = 'ch' +
      (state.current && state.current.name === ch.name ? ' active' : '') +
      (state.failed.has(ch.name) ? ' dead' : '');
    if (ch.logo) {
      const img = document.createElement('img');
      img.src = ch.logo;
      img.loading = 'lazy';
      img.alt = '';
      img.onerror = () => img.replaceWith(placeholder(ch.name));
      b.appendChild(img);
    } else {
      b.appendChild(placeholder(ch.name));
    }
    const span = document.createElement('span');
    span.textContent = ch.name;
    b.appendChild(span);
    b.onclick = () => play(ch);
    frag.appendChild(b);
  }
  list.appendChild(frag);
}

function applyFilter() {
  const q = state.query.toLowerCase();
  state.filtered = state.channels.filter((c) => {
    if (state.hideDead && state.health[c.url] === false) return false;
    if (state.group !== 'all' && c.group !== state.group) return false;
    if (q && !c.name.toLowerCase().includes(q)) return false;
    return true;
  });
  const hidden = state.hideDead ? deadCount() : 0;
  el('count').textContent =
    state.filtered.length + ' channels' + (hidden ? '  (' + hidden + ' hidden)' : '');
  renderList();
}

let searchTimer;
el('search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const v = e.target.value;
  searchTimer = setTimeout(() => {
    state.query = v;
    applyFilter();
  }, 180);
});

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
(function init() {
  state.channels = applySelection(window.SNAPSHOT || []);
  state.health = loadHealth();
  try {
    state.hideDead = localStorage.getItem('iptv-hide-dead') !== '0';
  } catch (e) { /* default stays true */ }

  const toggle = el('hide-dead');
  if (toggle) {
    toggle.checked = state.hideDead;
    toggle.addEventListener('change', () => {
      state.hideDead = toggle.checked;
      try { localStorage.setItem('iptv-hide-dead', state.hideDead ? '1' : '0'); } catch (e) {}
      applyFilter();
      renderGroups();
      updateHealthLabel(true);
    });
  }
  const again = el('rescan');
  if (again) again.addEventListener('click', rescan);

  renderGroups();
  applyFilter();
  updateHealthLabel(true);
  showOverlay('Pick a channel', 'Choose something from the list to start watching.', false);

  // Refresh the playlist first so we probe current URLs, then scan.
  refreshFromSource().then(() => {
    renderGroups();
    scanHealth();
  });
})();
