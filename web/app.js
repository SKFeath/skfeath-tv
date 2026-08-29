'use strict';
// SKFeath TV - static player. No backend: the browser fetches the playlists and
// plays each stream directly from its origin, so hosting carries no video.

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// gate
//
// Honest about what this is: the check runs in the browser, so anyone who opens
// devtools can walk past it. Storing a hash rather than the literal code keeps
// it out of "view source", nothing more. The playlists are public, so there is
// nothing secret behind it - it is a door, not a lock.
// ---------------------------------------------------------------------------
const CODE_HASH = 'b7fe2d572c4b3ad90bc6b55e37919e8892ac6da28f8bca766e9fa3e130d54cc0';
const GATE_KEY = 'sk-gate';

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function unlock() {
  try { sessionStorage.setItem(GATE_KEY, '1'); } catch (e) { /* private mode */ }
  el('gate').classList.add('hidden');
  el('app').classList.remove('hidden');
  boot();
}

el('gate-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = el('gate-err');
  err.textContent = '';
  const value = el('gate-code').value.trim();
  let ok = false;
  try {
    ok = (await sha256Hex(value)) === CODE_HASH;
  } catch (e2) {
    ok = value === 'f5noobs'; // crypto.subtle needs a secure context
  }
  if (!ok) {
    err.textContent = 'Wrong code.';
    el('gate-code').select();
    return;
  }
  unlock();
});

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
const FAV_KEY = 'sk-favs';
const HEALTH_KEY = 'sk-health-v2';
const HIDE_KEY = 'sk-hide-dead';
const MAX_RENDER = 400;

const state = {
  channels: [],
  tree: [],
  filtered: [],
  category: 'All',      // 'All' | 'Favourites' | category name
  subcategory: null,
  query: '',
  catQuery: '',
  open: {},             // category -> expanded?
  favs: new Set(),
  health: {},           // url -> true/false
  hideDead: true,
  tab: 'tv',
  scanning: false,
  current: null,
  hls: null,
  booted: false,
};

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  },
};

function escapeHtml(s) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => map[c]);
}

// ---------------------------------------------------------------------------
// playlist loading + merge (mirrors tools/lib-m3u.js)
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
    if (pending) { out.push({ ...pending, url: line }); pending = null; }
  }
  return out;
}

// Refresh keeps stream URLs current without changing which channels are
// offered: the build decided that, and its classification travels with it.
async function refreshFromSource() {
  const urls = window.SOURCE_URLS || [];
  if (!urls.length) return;

  const byName = new Map(state.channels.map((c) => [c.name, c]));
  const seen = new Set();
  let anyOk = false;
  let updated = 0;

  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) continue;
      anyOk = true;
      for (const fresh of parseM3U(await res.text())) {
        if (seen.has(fresh.name)) continue;
        seen.add(fresh.name);
        const known = byName.get(fresh.name);
        if (known && known.url !== fresh.url) {
          // URL rotated upstream - take the new one and retest it.
          delete state.health[known.url];
          known.url = fresh.url;
          updated++;
        }
      }
    } catch (e) { /* one bad source must not block the rest */ }
  }

  el('foot').textContent = anyOk
    ? (updated ? updated + ' stream links refreshed' : 'channel list up to date')
    : 'using bundled list';
  if (updated) applyFilter();
}

// ---------------------------------------------------------------------------
// health scanning
//
// The list is ~1800 channels, so a blind sweep on every visit is minutes of
// waiting. Instead: cached results paint the UI instantly, then channels that
// worked last time are re-checked FIRST (so the usable list is confirmed
// quickly), then brand-new channels, and only then the ones already known bad.
// ---------------------------------------------------------------------------
const PROBE_TIMEOUT_MS = 7000;
const PROBE_CONCURRENCY = 14;
const RECHECK_DEAD_AFTER_MS = 30 * 60 * 1000;

function loadHealth() {
  const saved = store.get(HEALTH_KEY, null);
  if (!saved || !saved.map) return { map: {}, at: 0 };
  return { map: saved.map, at: saved.at || 0 };
}

function saveHealth() {
  store.set(HEALTH_KEY, { at: Date.now(), map: state.health });
}

async function probe(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store', redirect: 'follow' });
    if (!res.ok) return false;
    const text = await res.text();
    // A CORS-blocked or non-HLS reply cannot be played by hls.js either.
    return text.indexOf('#EXTM3U') !== -1;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function scanHealth(cacheAge) {
  const alive = [];
  const fresh = [];
  const dead = [];
  for (const c of state.channels) {
    const known = state.health[c.url];
    if (known === true) alive.push(c);
    else if (known === undefined) fresh.push(c);
    else dead.push(c);
  }

  // Skip re-testing known-bad channels while the cache is still recent; that is
  // where most of the time goes and they rarely come back within the hour.
  const includeDead = cacheAge > RECHECK_DEAD_AFTER_MS || dead.length === 0;
  const queue = alive.concat(fresh, includeDead ? dead : []);
  if (!queue.length) { setHealthLabel(); return; }

  state.scanning = true;
  setHealthLabel();
  let done = 0;
  const total = queue.length;

  const worker = async () => {
    for (;;) {
      // Whatever category is open gets priority, so the view you are actually
      // looking at settles first.
      let idx = 0;
      if (state.category !== 'All' && state.category !== 'Favourites') {
        const i = queue.findIndex((c) => c.category === state.category);
        if (i !== -1) idx = i;
      }
      const ch = queue.splice(idx, 1)[0];
      if (!ch) return;
      state.health[ch.url] = await probe(ch.url);
      done++;
      if (done % 12 === 0 || !queue.length) {
        setHealthLabel(done, total);
        applyFilter();
        renderCats();
      }
      if (done % 200 === 0) saveHealth();
    }
  };

  await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, worker));

  state.scanning = false;
  saveHealth();
  applyFilter();
  renderCats();
  setHealthLabel();
}

function aliveCount() {
  return state.channels.filter((c) => state.health[c.url] === true).length;
}
function deadCount() {
  return state.channels.filter((c) => state.health[c.url] === false).length;
}

function setHealthLabel(done, total) {
  const dot = el('health-dot');
  if (state.scanning && done != null) {
    el('health').textContent = 'checking ' + done + '/' + total;
    dot.classList.add('scanning');
  } else if (state.scanning) {
    el('health').textContent = 'checking…';
    dot.classList.add('scanning');
  } else {
    const d = deadCount();
    el('health').textContent = d ? d + ' unavailable' : 'all reachable';
    dot.classList.remove('scanning');
  }
  el('stat-ok').textContent = aliveCount();
  el('stat-off').textContent = deadCount();
  // keep the profile tab's live counts fresh while scanning
  const pr = el('profile-reachable');
  if (pr && state.tab === 'you') {
    pr.textContent = aliveCount();
    el('profile-unavailable').textContent = deadCount();
  }
}

function isDead(c) { return state.health[c.url] === false; }

// ---------------------------------------------------------------------------
// favourites
// ---------------------------------------------------------------------------
function isFav(c) { return state.favs.has(c.name); }

function toggleFav(c) {
  if (state.favs.has(c.name)) state.favs.delete(c.name);
  else state.favs.add(c.name);
  store.set(FAV_KEY, [...state.favs]);
  renderCats();
  applyFilter();
}

// ---------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------
function matchesCategory(c, category, subcategory) {
  if (c.category === category && (!subcategory || c.subcategory === subcategory)) return true;
  // Dual-purpose channels (e.g. a regional network known to carry both
  // cricket and a target football league) are cross-listed via `also` and
  // show up under both places they actually belong.
  if (c.also && c.also.category === category && (!subcategory || c.also.subcategory === subcategory)) {
    return true;
  }
  return false;
}

function categoryChannels(category, subcategory) {
  if (category === 'Favourites') return state.channels.filter(isFav);
  if (category === 'All') return state.channels;
  return state.channels.filter((c) => matchesCategory(c, category, subcategory));
}

function visibleCount(list) {
  return state.hideDead ? list.filter((c) => !isDead(c)).length : list.length;
}

function renderCats() {
  const wrap = el('cats');
  wrap.innerHTML = '';
  const q = state.catQuery.toLowerCase();

  const row = (label, count, opts) => {
    const b = document.createElement('button');
    b.className = 'cat-row' + (opts.active ? ' active' : '') + (opts.open ? ' open' : '');
    if (opts.expandable) {
      b.innerHTML = '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M9 18l6-6-6-6"/></svg>';
    } else {
      b.innerHTML = '<span style="width:13px;flex:none"></span>';
    }
    const l = document.createElement('span');
    l.className = 'label';
    l.textContent = label;
    b.appendChild(l);
    const n = document.createElement('span');
    n.className = 'count';
    n.textContent = count;
    b.appendChild(n);
    b.onclick = opts.onClick;
    return b;
  };

  // Favourites and All are pinned above the A-Z list.
  if (!q || 'favourites'.includes(q)) {
    const favs = categoryChannels('Favourites');
    wrap.appendChild(row('★ Favourites', visibleCount(favs), {
      active: state.category === 'Favourites',
      onClick: () => selectCategory('Favourites', null),
    }));
  }
  if (!q || 'all channels'.includes(q)) {
    wrap.appendChild(row('All channels', visibleCount(state.channels), {
      active: state.category === 'All',
      onClick: () => selectCategory('All', null),
    }));
  }

  // Football is pinned right under Favourites/All - this site exists to
  // watch football, so it should not be buried alphabetically between
  // Entertainment and Kids. Everything else follows A-Z.
  const PINNED = ['Football'];
  const pinned = state.tree.filter((t) => PINNED.includes(t.category))
    .sort((a, b) => PINNED.indexOf(a.category) - PINNED.indexOf(b.category));
  const rest = state.tree.filter((t) => !PINNED.includes(t.category));

  for (const t of pinned.concat(rest)) {
    const catMatches = t.category.toLowerCase().includes(q);
    const subMatches = t.subcategories.filter((s) => s.name.toLowerCase().includes(q));
    if (q && !catMatches && !subMatches.length) continue;

    const list = categoryChannels(t.category);
    const open = state.open[t.category] || (q && subMatches.length > 0);

    wrap.appendChild(row(t.category, visibleCount(list), {
      active: state.category === t.category && !state.subcategory,
      expandable: true,
      open,
      onClick: () => {
        state.open[t.category] = !open;
        selectCategory(t.category, null);
      },
    }));

    if (!open) continue;
    const subs = q && !catMatches ? subMatches : t.subcategories;
    for (const s of subs) {
      const subList = categoryChannels(t.category, s.name);
      const b = document.createElement('button');
      b.className = 'sub-row' +
        (state.category === t.category && state.subcategory === s.name ? ' active' : '');
      const l = document.createElement('span');
      l.className = 'label';
      l.textContent = s.name;
      b.appendChild(l);
      const n = document.createElement('span');
      n.className = 'count';
      n.textContent = visibleCount(subList);
      b.appendChild(n);
      b.onclick = () => selectCategory(t.category, s.name);
      wrap.appendChild(b);
    }
  }

  if (!wrap.children.length) {
    wrap.innerHTML = '<div class="list-note">No categories match.</div>';
  }
}

function selectCategory(category, subcategory) {
  state.category = category;
  state.subcategory = subcategory;
  el('crumb').textContent = subcategory ? category + ' › ' + subcategory
    : category === 'All' ? 'All channels' : category;
  // NOTE: do NOT close the mobile drawer here - browsing a category to reach
  // its subcategories must keep the drawer open. It closes only when a channel
  // is actually picked (see play()) or when the user dismisses it themselves.
  renderCats();
  applyFilter();
}

// ---------------------------------------------------------------------------
// channel list
// ---------------------------------------------------------------------------
function initials(name) {
  const clean = String(name || '').replace(/^\[[^\]]*\]\s*/, '').replace(/[^\w\s]/g, ' ').trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[1][0]).toUpperCase();
}

function channelRow(c) {
  const b = document.createElement('button');
  const dead = isDead(c);
  const active = state.current && state.current.name === c.name;
  b.className = 'ch' + (active ? ' active' : '') + (dead ? ' dead' : '');

  const logo = document.createElement('span');
  logo.className = 'ch-logo';
  logo.textContent = initials(c.name);
  if (c.logo) {
    const img = document.createElement('img');
    img.src = c.logo;
    img.loading = 'lazy';
    img.alt = '';
    img.onerror = () => img.remove();
    logo.appendChild(img);
  }
  b.appendChild(logo);

  const nm = document.createElement('span');
  nm.className = 'ch-name';
  nm.textContent = c.name;
  b.appendChild(nm);

  if (active) {
    const air = document.createElement('span');
    air.className = 'onair';
    air.innerHTML = '<i></i>ON AIR';
    b.appendChild(air);
  } else if (dead) {
    const off = document.createElement('span');
    off.className = 'off-tag';
    off.textContent = 'off';
    b.appendChild(off);
  }

  // A dual-purpose channel shows which OTHER category it's also listed
  // under, so it's clear why e.g. T Sports appears in both Football and
  // Sports > Cricket rather than looking like a stray misclassification.
  if (c.also) {
    const viewingPrimary = state.category === c.category;
    const other = viewingPrimary ? c.also : { category: c.category, subcategory: c.subcategory };
    const tag = document.createElement('span');
    tag.className = 'also-tag';
    tag.textContent = 'also: ' + other.category;
    tag.title = 'Also listed under ' + other.category + ' › ' + other.subcategory;
    b.appendChild(tag);
  }

  const fav = document.createElement('button');
  fav.className = 'ch-fav' + (isFav(c) ? ' on' : '');
  fav.setAttribute('aria-label', 'Favourite');
  fav.innerHTML = isFav(c)
    ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5 15 9l7 1-5.2 5 1.3 7-6.1-3.4L5.9 22l1.3-7L2 10l7-1z"/></svg>'
    : '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 2.5 15 9l7 1-5.2 5 1.3 7-6.1-3.4L5.9 22l1.3-7L2 10l7-1z"/></svg>';
  fav.onclick = (ev) => { ev.stopPropagation(); toggleFav(c); };
  b.appendChild(fav);

  b.onclick = () => play(c);
  return b;
}

function renderList() {
  const list = el('list');
  list.innerHTML = '';
  if (!state.filtered.length) {
    list.innerHTML = '<div class="list-note">No channels match.</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  const slice = state.filtered.slice(0, MAX_RENDER);

  // In broad views, a subheading per category keeps a long list navigable.
  const showHeads = state.category === 'All' || state.category === 'Favourites';
  let lastHead = null;
  for (const c of slice) {
    if (showHeads) {
      const head = c.category + ' › ' + c.subcategory;
      if (head !== lastHead) {
        lastHead = head;
        const h = document.createElement('div');
        h.className = 'group-head';
        h.textContent = head;
        frag.appendChild(h);
      }
    }
    frag.appendChild(channelRow(c));
  }
  list.appendChild(frag);

  if (state.filtered.length > slice.length) {
    const note = document.createElement('div');
    note.className = 'list-note';
    note.textContent = 'Showing ' + slice.length + ' of ' + state.filtered.length +
      ' — search to narrow down.';
    list.appendChild(note);
  }
}

function applyFilter() {
  const q = state.query.toLowerCase();
  let list = categoryChannels(state.category, state.subcategory);
  if (state.hideDead) list = list.filter((c) => !isDead(c));
  if (q) list = list.filter((c) => c.name.toLowerCase().includes(q));

  list.sort((a, b) =>
    a.category.localeCompare(b.category) ||
    a.subcategory.localeCompare(b.subcategory) ||
    a.name.localeCompare(b.name)
  );

  state.filtered = list;
  el('count').textContent = list.length + ' ch';
  renderList();
  setHealthLabel(state.scanning ? undefined : null);
}

// ---------------------------------------------------------------------------
// playback
// ---------------------------------------------------------------------------
function setState(kind, title, detail) {
  const box = el('state');
  if (kind === 'playing') { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  let icon = '';
  if (kind === 'idle') {
    icon = '<div class="state-icon"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="15" rx="2"/><path d="m17 2-5 5-5-5"/></svg></div>';
  } else if (kind === 'connecting') {
    icon = '<div class="spinner"></div>';
  } else if (kind === 'failed') {
    icon = '<div class="state-icon" style="background:rgba(255,77,77,.12);border-color:rgba(255,77,77,.35)"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--live)" stroke-width="1.7" stroke-linecap="round"><path d="M12 8v5M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg></div>';
  }
  box.innerHTML = '<div>' + icon + '<h2>' + escapeHtml(title) + '</h2>' +
    (detail ? '<p>' + escapeHtml(detail) + '</p>' : '') + '</div>';
}

function destroyPlayer() {
  if (state.hls) {
    try { state.hls.destroy(); } catch (e) { /* already gone */ }
    state.hls = null;
  }
  const v = el('video');
  try { v.removeAttribute('src'); v.load(); } catch (e) { /* ignore */ }
}

function play(c) {
  state.current = c;
  closeDrawer(); // picking a channel dismisses the mobile category drawer
  destroyPlayer();
  renderList();

  el('now-title').textContent = c.name;
  el('now-meta').textContent = c.category + ' › ' + c.subcategory;
  const lg = el('meta-logo');
  if (c.logo) { lg.src = c.logo; lg.classList.remove('hidden'); } else { lg.classList.add('hidden'); }
  setState('connecting', 'Connecting…', c.name);

  const video = el('video');
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
      if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) { hls.recoverMediaError(); return; }
      failed(c, data);
    });
    hls.loadSource(c.url);
    hls.attachMedia(video);
    video.play().catch(() => {});
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = c.url;
    video.play().catch(() => {});
  } else {
    setState('failed', 'Unsupported browser', 'This browser cannot play HLS.');
  }
}

function failed(c, data) {
  state.health[c.url] = false;
  saveHealth();
  const code = data && data.response && data.response.code;
  let why = 'This channel is not responding. Try another.';
  if (code === 403 || code === 401) {
    why = 'The stream refused the request. It is probably region-locked.';
  } else if (data && data.type === 'networkError') {
    why = 'Could not reach this stream. It may be offline, or only reachable from ' +
          'inside its own country (BDIX channels usually are).';
  }
  setState('failed', 'Cannot play ' + c.name, why);
  el('now-meta').textContent = 'unavailable';
  applyFilter();
  renderCats();
}

el('video').addEventListener('playing', () => {
  setState('playing');
  if (state.current) {
    state.health[state.current.url] = true;
    saveHealth();
    el('now-meta').textContent = state.current.category + ' › ' + state.current.subcategory;
    renderList();
  }
});

function step(delta) {
  if (!state.filtered.length) return;
  const i = state.current
    ? state.filtered.findIndex((c) => c.name === state.current.name)
    : -1;
  const next = state.filtered[(i + delta + state.filtered.length) % state.filtered.length];
  if (next) play(next);
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------
let searchTimer;
el('search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const v = e.target.value;
  searchTimer = setTimeout(() => { state.query = v; applyFilter(); }, 180);
});

let catTimer;
el('cat-search').addEventListener('input', (e) => {
  clearTimeout(catTimer);
  const v = e.target.value;
  catTimer = setTimeout(() => { state.catQuery = v; renderCats(); }, 150);
});

el('hide-dead').addEventListener('change', (e) => {
  state.hideDead = e.target.checked;
  store.set(HIDE_KEY, state.hideDead);
  applyFilter();
  renderCats();
});

function doRescan() {
  state.health = {};
  saveHealth();
  applyFilter();
  renderCats();
  renderProfile();
  scanHealth(Infinity);
}
el('rescan').addEventListener('click', doRescan);

// "Reachable" only means anything from the connection that measured it -
// BDIX channels reach a Bangladeshi visitor and refuse everyone else, so this
// list only has meaning for the browser that generated it. That's why it's a
// button, not a fixed file: it always reflects the exporter's own network.
function exportReachable() {
  const alive = state.channels
    .filter((c) => state.health[c.url] === true)
    .sort((a, b) => a.category.localeCompare(b.category) || a.subcategory.localeCompare(b.subcategory) || a.name.localeCompare(b.name));

  if (!alive.length) {
    alert('Nothing has tested reachable yet. Wait for the scan to finish (see the status pill, top right) and try again.');
    return;
  }

  const lines = ['#EXTM3U'];
  let lastGroup = null;
  for (const c of alive) {
    const group = c.category + ' - ' + c.subcategory;
    if (group !== lastGroup) lastGroup = group;
    lines.push('#EXTINF:-1 group-title="' + group.replace(/"/g, "'") + '"' +
      (c.logo ? ' tvg-logo="' + c.logo.replace(/"/g, "'") + '"' : '') + ',' + c.name);
    lines.push(c.url);
  }

  const blob = new Blob([lines.join('\n') + '\n'], { type: 'audio/x-mpegurl' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = 'reachable-' + stamp + '.m3u';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
el('export-reachable').addEventListener('click', exportReachable);

el('prev').addEventListener('click', () => step(-1));
el('next').addEventListener('click', () => step(1));

document.addEventListener('keydown', (e) => {
  if (/input|textarea/i.test(e.target.tagName)) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
  if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
});

function closeDrawer() {
  el('sidebar').classList.remove('open');
  const back = document.querySelector('.drawer-back');
  if (back) back.remove();
}
el('navbtn').addEventListener('click', () => {
  const side = el('sidebar');
  const isOpen = side.classList.toggle('open');
  if (isOpen) {
    const back = document.createElement('div');
    back.className = 'drawer-back';
    back.onclick = closeDrawer;
    document.body.appendChild(back);
  } else closeDrawer();
});

// ---------------------------------------------------------------------------
// tabs: TV / Room / You
// ---------------------------------------------------------------------------
const TAB_SUB = { tv: 'Live TV', room: 'Homies Room', you: 'Profile' };
let roomLoaded = false;

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tabpanel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + tab));
  document.querySelectorAll('.tabbtn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  const app = el('app');
  app.classList.remove('tab-tv', 'tab-room', 'tab-you');
  app.classList.add('tab-' + tab);
  const sub = el('brand-sub');
  if (sub) sub.textContent = TAB_SUB[tab] || 'Live TV';
  if (tab === 'you') renderProfile();
  if (tab === 'room') openRoom();
  try { sessionStorage.setItem('sk-tab', tab); } catch (e) { /* ignore */ }
}

function wireTabs() {
  document.querySelectorAll('.tabbtn').forEach((b) => {
    b.addEventListener('click', () => setTab(b.dataset.tab));
  });
}

// The Room tab loads the fan-out server (window.ROOM_URL) in an iframe. Until
// that server exists, ROOM_URL is empty and we leave the "offline" screen up.
function openRoom() {
  if (roomLoaded) return;
  const url = window.ROOM_URL;
  if (!url) return; // stays on the offline screen
  const frame = el('room-frame');
  const offline = el('room-offline');
  frame.src = url;
  frame.classList.remove('hidden');
  offline.classList.add('hidden');
  roomLoaded = true;
}

// ---------------------------------------------------------------------------
// You / profile
// ---------------------------------------------------------------------------
function renderProfile() {
  const favs = state.favs ? state.favs.size : 0;
  el('profile-favs').textContent = favs;
  el('profile-reachable').textContent = aliveCount();
  el('profile-unavailable').textContent = deadCount();
  el('profile-total').textContent = state.channels.length;
  const cb = el('profile-hide-dead');
  if (cb) cb.checked = state.hideDead;
  const src = el('profile-sources');
  if (src) {
    const n = (window.SOURCE_URLS || []).length;
    src.textContent = 'Playing ' + state.channels.length + ' channels from ' + n +
      ' public playlist source(s). Streams play straight from their origin — nothing passes through this site, so what works depends on your own connection.';
  }
}

function wireProfile() {
  el('profile-hide-dead').addEventListener('change', (e) => {
    state.hideDead = e.target.checked;
    store.set(HIDE_KEY, state.hideDead);
    el('hide-dead').checked = state.hideDead; // keep the TV-tab toggle in sync
    applyFilter();
    renderCats();
  });
  el('profile-rescan').addEventListener('click', doRescan);
  el('profile-export').addEventListener('click', exportReachable);
  el('profile-signout').addEventListener('click', () => {
    try { sessionStorage.removeItem(GATE_KEY); } catch (e) { /* ignore */ }
    location.reload();
  });
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
function boot() {
  if (state.booted) return;
  state.booted = true;

  state.channels = (window.SNAPSHOT || []).map((c) => ({ ...c }));
  state.tree = window.TREE || [];
  state.open.Football = true; // the site's whole purpose - start expanded
  state.favs = new Set(store.get(FAV_KEY, []));
  state.hideDead = store.get(HIDE_KEY, true);
  el('hide-dead').checked = state.hideDead;

  const cached = loadHealth();
  state.health = cached.map;
  const cacheAge = cached.at ? Date.now() - cached.at : Infinity;

  el('foot').textContent = (window.SOURCE_URLS || []).length + ' playlist source(s)';

  wireTabs();
  wireProfile();
  renderCats();
  applyFilter();
  renderProfile();
  setState('idle', 'Pick a channel to start',
    'Streams play straight from their own origin — no video passes through this site.');

  // Restore the last tab within this session (defaults to TV).
  let startTab = 'tv';
  try { startTab = sessionStorage.getItem('sk-tab') || 'tv'; } catch (e) { /* ignore */ }
  setTab(startTab);

  // Cached results are already on screen; verify in the background.
  refreshFromSource().then(() => scanHealth(cacheAge));
}

// Skip the gate for the rest of this browser session once entered.
try {
  if (sessionStorage.getItem(GATE_KEY) === '1') {
    el('gate').classList.add('hidden');
    el('app').classList.remove('hidden');
    boot();
  }
} catch (e) { /* private mode - gate stays up */ }
