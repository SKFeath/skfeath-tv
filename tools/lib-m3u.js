'use strict';
// Shared M3U parsing for the build tools and the static site.
const ATTR_RE = /([\w-]+)="([^"]*)"/g;

// The title is separated from the attributes by the first comma that is NOT
// inside a quoted value. Splitting on the first comma outright corrupts every
// entry whose logo URL contains one (CDN transforms like "f_png,w_300,q_85"
// are common), yielding garbage channel names and broken logos.
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
  const lines = String(text).split(/\r?\n/);
  let pending = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      const { attrs: attrPart, title } = splitExtinf(line);

      const attrs = {};
      ATTR_RE.lastIndex = 0;
      let m;
      while ((m = ATTR_RE.exec(attrPart)) !== null) attrs[m[1].toLowerCase()] = m[2];

      pending = {
        name: title || attrs['tvg-name'] || 'Unnamed',
        logo: attrs['tvg-logo'] || null,
        group: attrs['group-title'] || 'Ungrouped',
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

module.exports = { parseM3U };
