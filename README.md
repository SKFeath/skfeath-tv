# IPTV website

Two ways to run this, depending on where your channels come from.

| | **Static site** | **Server + fan-out** |
|---|---|---|
| For | a public M3U playlist | a paid subscription |
| Hosting | **free**, anywhere | a VPS (~€4/mo) |
| Bandwidth cost | **zero** | ~1 TB/month |
| Connection limit | none | works with a 1-connection plan |
| Password protection | no | yes |

**If you have a public playlist, use the static site.** It is simpler, free, and
plays channels a server could never reach. Everything below covers it; the
server version is documented in [SERVER.md](SERVER.md).

---

## How the static site works

There is no backend. The browser fetches the playlist and plays each stream
**directly from whoever hosts it**:

```
   playlist (GitHub)  ──>  friend's browser  <──  stream CDN
                                 ▲
                          your site (HTML/JS only, ~680 KB)
```

Your host serves a few hundred KB of HTML and JavaScript once. **No video ever
passes through it**, so any free static host works and nothing can run up a bill.

This also plays channels a server could not. BDIX channels only accept
connections from inside Bangladesh — a proxy on a free host abroad gets refused,
but a friend in Bangladesh playing directly gets through fine.

---

## Build it

```bash
npm install
```

**1. Generate the channel list**

```bash
npm run channels
```

Writes `config/channels.txt` — every channel in the playlist, grouped.

**2. Choose your channels**

Open `config/channels.txt` and comment out (with a leading `#`) or delete
anything you don't want. Channels served over plain `http://` are commented out
for you: browsers refuse to load them on an `https://` page, so they cannot work
once hosted.

Re-running `npm run channels` later keeps your choices.

**3. Build**

```bash
npm run build
```

Produces `dist/` — a complete, self-contained site.

**4. Check it before uploading**

```bash
npm run preview
```

Then open <http://localhost:4173>.

---

## Host it free

Upload the **`dist/` folder**. Nothing needs to run server-side.

- **Cloudflare Pages** — unlimited bandwidth on the free plan. Best choice.
- **Netlify** — 100 GB/month free, plenty since no video goes through it.
- **GitHub Pages** — works; push `dist/` to a `gh-pages` branch.
- **Vercel** — fine here (it's static; the limits that break streaming don't apply).

Cloudflare Pages, drag-and-drop: create a project, choose *Direct Upload*, drop
`dist/` in. Or with the CLI:

```bash
npx wrangler pages deploy dist
```

Give friends the URL. That is the whole deployment.

---

## Dead channels

The site tests every channel **from each viewer's own connection** on load, then
hides the ones that do not respond. Someone in Bangladesh keeps the BDIX
channels; someone abroad does not see them. Same build, different list, no
configuration.

Results are cached for six hours, so it costs one sweep rather than one per page
load. A channel that fails during playback is marked dead immediately; one that
plays successfully is marked alive.

- **Hide unavailable** (top right) turns the filtering off if you want the full list
- **Re-check** clears the cache and tests everything again

### Removing them permanently

Run the health check **on the network your viewers actually use**, then prune:

```bash
npm run health
```

```bash
npm run prune
```

```bash
npm run build
```

`prune` comments channels out rather than deleting them, so you can restore any
by removing the leading `#`.

> **Run the health check from the right place.** It reports what *that machine*
> can reach. Running it outside Bangladesh marks all 69 BDIX channels dead and
> prunes channels that work perfectly for your friends. The in-browser filtering
> above has no such problem — it always measures the real viewer.

---

## Things you should know

**Anyone with the link can watch.** A static site has nowhere to check a
password. The playlist is public, so there is nothing of yours to protect — but
the link is the only thing between your site and the open internet. If you need
real access control, use the server version.

**Channels break, constantly.** Public playlists rot: streams go offline, get
region-locked, or expire. Expect a substantial fraction of duds at any moment,
and a different fraction next week. That is why the filtering is automatic.

**Some channels carry expiring links.** A few "Live Event" entries have signed
URLs with an expiry timestamp. The site re-fetches the playlist on every load so
it picks up refreshed links, but if the upstream repo stops updating, those die.

**The site self-updates.** It loads its bundled channel list instantly, then
refreshes from the live playlist in the background. Rebuild and redeploy only
when you want to change *which* channels are offered.

---

## Changing the playlist source

One line, in `tools/source-url.js`. The URL must send CORS headers
(`Access-Control-Allow-Origin`), because the browser fetches it directly.
GitHub raw does. Then re-run `npm run channels` and `npm run build`.

---

## Legal note

This plays publicly-listed streams that other people host; it does not
rebroadcast anything itself. Whether those streams are licensed is between
whoever runs them and the rights holders, and putting a nicer front end on them
does not change that.

---

## Commands

| Command | What it does |
|---|---|
| `npm run channels` | Regenerate `config/channels.txt` (keeps your picks) |
| `npm run build` | Build `dist/` from your selection |
| `npm run preview` | Serve `dist/` at localhost:4173 |
| `npm run health` | Probe every channel from this machine |
| `npm run prune` | Comment out channels that failed the last health check |
| `npm start` | Run the **server** version (see [SERVER.md](SERVER.md)) |
| `npm run check` | Test a paid subscription's credentials |
| `npm run test:e2e` | Test suite for the server version |
