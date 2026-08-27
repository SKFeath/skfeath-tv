'use strict';
const path = require('path');
const express = require('express');
const session = require('express-session');

const { config, describeProblems } = require('./src/config');
const routes = require('./src/routes');
const auth = require('./src/auth');
const fanout = require('./src/fanout');

const app = express();
app.set('trust proxy', 1); // correct client IPs behind a tunnel/reverse proxy

app.use(express.json({ limit: '64kb' }));
app.use(
  session({
    name: 'iptv.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
      // Set COOKIE_SECURE=1 once you are serving over HTTPS.
      secure: process.env.COOKIE_SECURE === '1',
    },
  })
);

app.use('/api', routes);

// Player libraries straight from node_modules - no CDN dependency.
app.use('/vendor/hls', express.static(path.join(__dirname, 'node_modules/hls.js/dist')));
app.use('/vendor/mpegts', express.static(path.join(__dirname, 'node_modules/mpegts.js/dist')));

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public/login.html')));
app.get('/', (req, res) => {
  if (!req.session || !req.session.user) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public/index.html'));
});
app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, _next) => {
  console.error('[error]', err && err.message);
  if (res.headersSent) return;
  res.status(500).json({ error: err && err.message ? err.message : 'Server error' });
});

// Tear down a viewer's slot the moment their socket drops.
const server = app.listen(config.port, () => {
  const problems = describeProblems();
  console.log('');
  console.log('  IPTV web player');
  console.log('  ---------------');
  console.log(`  local     http://localhost:${config.port}`);
  console.log(`  source    ${config.mode}`);
  console.log(`  viewers   ${config.users.size} access code(s), unlimited simultaneous`);
  console.log(`  upstream  ${config.upstreamConnections} provider connection(s) - shared by everyone`);
  if (problems.length) {
    console.log('');
    console.log('  Fix before sharing:');
    for (const p of problems) console.log(`   ! ${p}`);
  }
  console.log('');
});

function shutdown() {
  // Drop the provider connection promptly so the single slot is freed.
  fanout.stopAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { app, server };
