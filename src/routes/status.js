/**
 * routes/status.js
 *
 * GET /status?userId=alice
 *
 * Returns JSON with:
 *   - pairsLeft        : how many pairs are available right now
 *   - hasHold          : does this user have an active hold?
 *   - holdSecondsLeft  : seconds until their hold expires (0 if none)
 *   - totalPurchased   : how many pairs this user has bought
 *   - waitlistPosition : their position in the waitlist (null if not waiting)
 */

const express = require('express');
const router = express.Router();
const store = require('../store');

router.get('/', async (req, res) => {
  const userId = req.query.userId || req.headers['x-user-id'] || null;
  const status = await store.getStatus(userId);

  // Also return HTML if browser requests it (Accept: text/html)
  const wantsHtml = req.headers.accept && req.headers.accept.includes('text/html');
  if (wantsHtml) {
    // Redirect to the status page (which fetches this endpoint via JS)
    return res.redirect(`/?userId=${userId || ''}`);
  }

  return res.json(status);
});

module.exports = router;
