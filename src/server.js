/**
 * server.js — Entry point
 *
 * Starts the Express server, loads Lua scripts into Redis,
 * and initialises stock on first run.
 */

const express = require('express');
const path = require('path');
const store = require('./store');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/buy', require('./routes/buy'));
app.use('/status', require('./routes/status'));
app.use('/admin', require('./routes/admin'));

// ── Startup ───────────────────────────────────────────────────────────────────
async function start() {
  try {
    await store.loadScripts();
    await store.initStock();

    app.listen(PORT, () => {
      console.log(`\n🔥 Sneaker Drop server running at http://localhost:${PORT}`);
      console.log(`   Open http://localhost:${PORT} in your browser\n`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
