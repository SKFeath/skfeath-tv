# Server version — for a paid subscription

Use this only when your channels come from a **paid subscription** whose
credentials must stay secret, or when the provider limits simultaneous
connections. For a public playlist, use the static site in [README.md](README.md)
instead — it is free to host and needs none of this.

## What it does

- Keeps your Xtream/M3U credentials on the server; viewers never see them
- **Fan-out**: pulls one upstream stream and serves it to unlimited viewers, so
  a 1-connection plan still works for a group
- Per-person access codes, individually revocable
- Releases the provider connection once nobody is watching

The tradeoff: everyone shares one channel at a time, because a second channel
would need a second upstream connection.

## Setup

```bash
cp .env.example .env
```

Fill in `XTREAM_BASE`, `XTREAM_USERNAME`, `XTREAM_PASSWORD`, then:

```bash
npm run check
```

Reports whether the credentials work, how many connections your plan allows, and
whether the provider serves HLS (which fan-out requires).

```bash
npm start
```

## Deploying

```bash
docker compose up -d --build
```

Every viewer's video flows through this server — roughly **1 TB/month for three
friends watching four hours a day**. Use a VPS with a real bandwidth allowance
(Hetzner, Contabo) or Oracle's free tier. Metered per-GB platforms get expensive
fast, and Vercel/Netlify cannot stream at all.

Put TLS in front (Caddy or a Cloudflare Tunnel), then set `COOKIE_SECURE=1`.
Keep `SESSION_SECRET` stable or every deploy signs everyone out.

Note that many providers block datacenter IP ranges. If `npm run check` passes
at home but fails on the server, that is why.

## Tests

```bash
npm run test:e2e
```

Runs the app against a mock provider that refuses any second simultaneous
connection, proving six viewers never push it past one, that switching channels
stays within the limit, that no credentials reach viewers, and that the
connection is released when idle.

## Configuration

| Variable | Purpose |
|---|---|
| `XTREAM_BASE` | Provider URL: scheme + host + port only |
| `XTREAM_USERNAME` / `XTREAM_PASSWORD` | Subscription credentials |
| `M3U_URL` | Used only when `XTREAM_BASE` is empty |
| `UPSTREAM_CONNECTIONS` | Connections your plan allows (usually `1`) |
| `CHANNEL_CONTROL` | `anyone` or `owner` |
| `CHANNEL_OWNERS` | Access codes allowed to switch, when `owner` |
| `ACCESS_CODES` | `name:code` pairs — one per friend |
| `SESSION_SECRET` | Long random string; keep stable in production |
| `COOKIE_SECURE` | `1` when served over HTTPS |
| `SEGMENT_WINDOW` | Segments buffered in memory (default 8) |
| `IDLE_STOP_SECONDS` | Release the connection after this idle time |
| `PORT` | Defaults to 3000 |
