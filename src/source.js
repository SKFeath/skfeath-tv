'use strict';
// Single façade over the two backends so routes never branch on mode.
const { config } = require('./config');
const xtream = require('./xtream');
const m3u = require('./m3u');

const backend = config.mode === 'xtream' ? xtream : m3u;

module.exports = {
  mode: config.mode,
  accountInfo: () => backend.accountInfo(),
  liveCategories: () => backend.liveCategories(),
  liveChannels: () => backend.liveChannels(),
  clearCache: () => backend.clearCache(),

  // Xtream builds the URL from an id; M3U looks it up in the parsed playlist.
  streamUrl: async (id, format) =>
    config.mode === 'xtream'
      ? xtream.liveStreamUrl(id, format)
      : await m3u.liveStreamUrl(id),

  shortEpg: async (streamId) =>
    config.mode === 'xtream' ? xtream.shortEpg(streamId) : [],
};
