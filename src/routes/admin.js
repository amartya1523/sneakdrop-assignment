/**
 * routes/admin.js
 *
 * Admin helper routes (for demo/testing only):
 *
 * POST /admin/reset      — reset stock to 20, clear all holds & waitlist
 * GET  /admin/dump       — dump all Redis keys (debug)
 */

const express = require('express');
const router = express.Router();
const redis = require('../redis');
const store = require('../store');

router.post('/reset', async (req, res) => {
  // Clear everything and reset stock
  const keys = await redis.keys('hold:*');
  const purchaseKeys = await redis.keys('user_purchases:*');
  const memberKeys = await redis.keys('waitlist_member:*');

  const toDelete = ['stock', 'waitlist', ...keys, ...purchaseKeys, ...memberKeys];
  if (toDelete.length > 0) {
    await redis.del(...toDelete);
  }

  await redis.set('stock', store.TOTAL_STOCK);

  res.json({ status: 'reset', stock: store.TOTAL_STOCK });
});

router.get('/dump', async (req, res) => {
  const keys = await redis.keys('*');
  const result = {};
  for (const key of keys) {
    const type = await redis.type(key);
    if (type === 'string') {
      result[key] = { type, value: await redis.get(key), ttl: await redis.ttl(key) };
    } else if (type === 'list') {
      result[key] = { type, value: await redis.lrange(key, 0, -1) };
    }
  }
  res.json(result);
});

module.exports = router;
