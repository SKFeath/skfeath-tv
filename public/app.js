'use strict';

const el = (id) => document.getElementById(id);
const video = el('video');

const state = {
  user: null,
  canChangeChannel: false,
  upstreamConnections: 1,
  category: 'all',
  query: '',
  channels: [],
  total: 0,
  playingId: null,      // what the room is actually on
  attachedId: null,     // what our player is attached to
  hls: null,
  mpegts: null,
  epgLine: '',
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
async function api(path, options) {
  const res = await fetch(path, options);
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('Signed out');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Request failed (' + res.status + ')');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

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
// playback - always attaches to whatever the room is currently playing
// ---------------------------------------------------------------------------
function destroyPlayer() {
  if (state.hls) {
    try { state.hls.destroy(); } catch (e) { /* already gone */ }
    state.hls = null;
  }
  if (state.mpegts) {
    try { state.mpegts.destroy(); } catch (e) { /* already gone */ }
    state.mpegts = null;
  }
  try {
    video.removeAttribute('src');
    video.load();
  } catch (e) { /* ignore */ }
  state.attachedId = null;
}

function attachTo(channelId, channelName) {
  if (state.attachedId === channelId) return;
  destroyPlayer();
  state.attachedId = channelId;
  showOverlay('Tuning in...', channelName || '', true);

  const url = '/api/live/' + encodeURIComponent(channelId) + '/index.m3u8';

  if (window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({
      lowLatencyMode: false,
      liveSyncDurationCount: 3,
      manifestLoadingMaxRetry: 4,
      levelLoadingMaxRetry: 4,
      fragLoadingMaxRetry: 6,
    });
    state.hls = hls;
    hls.on(window.Hls.Events.ERROR, (_evt, data) => {
      if (!data.fatal) return;
      if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
        return;
      }
      // The room may have moved on, or the buffer is still filling.
      showOverlay('Reconnecting...', 'Waiting for the stream', true);
      state.attachedId = null;
    });
    hls.loadSource(url);
    hls.attachMedia(video);
    video.play().catch(() => {});
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url; // Safari plays HLS natively
    video.play().catch(() => {});
  } else {
    showOverlay('Unsupported browser', 'This browser cannot play HLS.', false);
  }
}

video.addEventListener('playing', () => {
  hideOverlay();
  el('now-meta').textContent = state.epgLine || 'Live';
});

video.addEventListener('waiting', () => {
  el('now-meta').textContent = 'Buffering...';
});

// ---------------------------------------------------------------------------
// the room
// ---------------------------------------------------------------------------
async function requestChannel(channel, force) {
  showOverlay('Switching...', channel.name, true);
  try {
    const res = await api('/api/room/channel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId: channel.id, force: !!force }),
    });
    state.playingId = res.playing.channelId;
    attachTo(res.playing.channelId, res.playing.channelName);
    loadEpg(channel);
    renderList();
    syncRoom();
  } catch (err) {
    if (err.status === 409) {
      // Someone else is already watching something on the one connection.
      const onNow = (err.data.active && err.data.active[0]) || null;
      const others = onNow ? onNow.channelName : 'another channel';
      const ok = confirm(
        'Your subscription allows one channel at a time.\n\n' +
        'Currently playing: ' + others + '\n\n' +
        'Switch everyone to "' + channel.name + '"?'
      );
      if (ok) return requestChannel(channel, true);
      showOverlay('Still watching', others, false);
      return;
    }
    showOverlay('Could not switch', err.message, false);
  }
}

function renderRoom(room) {
  state.canChangeChannel = room.canChangeChannel;

  const playing = room.playing;
  if (playing) {
    el('now-title').textContent = playing.channelName;
    if (state.playingId !== playing.channelId) {
      state.playingId = playing.channelId;
      renderList();
    }
    // Someone else may have changed channel - follow along.
    attachTo(playing.channelId, playing.channelName);
    if (playing.error) {
      showOverlay('Stream problem', playing.error, false);
    }
  } else {
    state.playingId = null;
    el('now-title').textContent = 'Nothing playing';
    el('now-meta').textContent = 'Pick a channel to start the room.';
    destroyPlayer();
    showOverlay('Nothing playing', 'Pick a channel from the list.', false);
  }

  const names = room.viewers.map((v) => v.user);
  el('watchers').textContent = names.length
    ? names.length + ' watching: ' + names.join(', ')
    : 'nobody watching';

  const banner = el('room-note');
  if (room.lastChange) {
    banner.textContent =
      room.lastChange.user + ' switched to ' + room.lastChange.channelName;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

async function syncRoom() {
  try {
    renderRoom(await api('/api/room'));
  } catch (e) {
    // transient - next poll retries
  }
}

// ---------------------------------------------------------------------------
// EPG
// ---------------------------------------------------------------------------
async function loadEpg(channel) {
  state.epgLine = '';
  try {
    const rows = await api('/api/epg/' + encodeURIComponent(channel.id));
    if (!rows.length) return;
    const now = rows[0];
    const next = rows[1];
    state.epgLine = 'Now: ' + now.title + (next ? '   -   Next: ' + next.title : '');
    el('now-meta').textContent = state.epgLine;
  } catch (e) {
    // EPG is optional
  }
}

// ---------------------------------------------------------------------------
// catalogue UI
// ---------------------------------------------------------------------------
function renderCats(cats) {
  const wrap = el('cats');
  wrap.innerHTML = '';
  const all = [{ id: 'all', name: 'All channels' }].concat(cats);
  for (const c of all) {
    const b = document.createElement('button');
    b.className = 'cat' + (state.category === c.id ? ' active' : '');
    b.textContent = c.name;
    b.title = c.name;
    b.onclick = () => {
      state.category = c.id;
      renderCats(cats);
      loadChannels();
    };
    wrap.appendChild(b);
  }
}

function placeholder(name) {
  const d = document.createElement('div');
  d.className = 'ph';
  d.textContent = (name || '?').trim().slice(0, 2).toUpperCase();
  return d;
}

function renderList() {
  const list = el('list');
  list.innerHTML = '';
  if (!state.channels.length) {
    list.innerHTML = '<div class="list-note">No channels match.</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const ch of state.channels) {
    const b = document.createElement('button');
    b.className = 'ch' + (state.playingId === ch.id ? ' active' : '');
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
    if (!state.canChangeChannel) {
      b.disabled = true;
      b.title = 'Only the owner can change the channel';
    } else {
      b.onclick = () => requestChannel(ch, false);
    }
    frag.appendChild(b);
  }
  list.appendChild(frag);

  if (state.total > state.channels.length) {
    const note = document.createElement('div');
    note.className = 'list-note';
    note.textContent =
      'Showing ' + state.channels.length + ' of ' + state.total + ' - search to narrow down.';
    list.appendChild(note);
  }
}

async function loadChannels() {
  const params = new URLSearchParams({
    category: state.category,
    q: state.query,
    limit: '300',
  });
  try {
    const data = await api('/api/channels?' + params);
    state.channels = data.items;
    state.total = data.total;
    renderList();
  } catch (err) {
    el('list').innerHTML = '<div class="list-note">' + escapeHtml(err.message) + '</div>';
  }
}

let searchTimer;
el('search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const v = e.target.value;
  searchTimer = setTimeout(() => {
    state.query = v;
    loadChannels();
  }, 220);
});

el('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login';
});

window.addEventListener('pagehide', () => {
  if (navigator.sendBeacon) navigator.sendBeacon('/api/leave');
});

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
(async function init() {
  try {
    const me = await api('/api/me');
    state.user = me.user;
    state.canChangeChannel = me.canChangeChannel;
    state.upstreamConnections = me.upstreamConnections;
  } catch (e) {
    return; // api() already redirected to /login
  }

  api('/api/account')
    .then((a) => {
      const bits = ['Signed in as ' + state.user];
      if (a.expires) bits.push('expires ' + a.expires.slice(0, 10));
      bits.push(state.upstreamConnections + ' channel at a time');
      el('account').textContent = bits.join(' - ');
    })
    .catch((err) => {
      el('account').textContent = err.message;
    });

  try {
    renderCats(await api('/api/categories'));
  } catch (e) {
    renderCats([]);
  }

  await loadChannels();
  await syncRoom();
  // Polling keeps every browser on the same channel, so a switch by one
  // person moves everybody.
  setInterval(syncRoom, 5000);
})();
