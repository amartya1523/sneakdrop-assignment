/**
 * routes/buy.js
 *
 * POST /buy
 *   Body (JSON): { userId: "alice" }
 *
 * Behaviour:
 *   1. Try to place a hold (atomic Lua script)
 *   2. If stock = 0 → auto-join the waitlist
 *   3. If hold placed → kick off fake payment
 *   4. Return clear status to caller
 */

const express = require('express');
const router = express.Router();
const store = require('../store');
const { initiateFakePayment } = require('../payment');

// Webhook handler called by the fake payment service
async function handlePaymentWebhook({ paymentId, userId, status }) {
  if (status !== 'succeeded') {
    // Ignore failure messages (they may be out-of-order)
    console.log(`[Webhook] Ignoring ${status} for payment ${paymentId} user ${userId}`);
    return;
  }
  const result = await store.confirmPayment(userId);
  if (result === 1) {
    console.log(`[Webhook] Payment confirmed: user ${userId} payment ${paymentId}`);
  } else {
    console.log(`[Webhook] Duplicate or expired webhook — no-op for ${paymentId}`);
  }
}

router.post('/', async (req, res) => {
  const userId = req.body?.userId || req.headers['x-user-id'];
  if (!userId) {
    return res.status(400).json({ error: 'userId required (body JSON or X-User-Id header)' });
  }

  const result = await store.placeHold(userId);

  if (result === 1) {
    // Hold placed — start fake payment
    const paymentId = initiateFakePayment(userId, handlePaymentWebhook);
    return res.json({
      status: 'hold_placed',
      message: 'You have a 5-minute hold. Payment is being processed.',
      paymentId,
      holdSeconds: store.HOLD_TTL_SECONDS,
    });
  }

  if (result === -1) {
    // No stock — try to join waitlist
    const wl = await store.joinWaitlist(userId);
    if (wl.alreadyIn) {
      const pos = await store.getStatus(userId);
      return res.json({
        status: 'waitlisted',
        message: 'Stock is 0. You are already on the waitlist.',
        waitlistPosition: pos.waitlistPosition,
      });
    }
    return res.json({
      status: 'waitlisted',
      message: 'Stock is 0. You have been added to the waitlist.',
      waitlistPosition: wl.position,
    });
  }

  if (result === -2) {
    return res.status(400).json({
      status: 'limit_reached',
      message: 'You have already purchased 2 pairs (maximum allowed).',
    });
  }

  if (result === -3) {
    const s = await store.getStatus(userId);
    return res.status(400).json({
      status: 'already_on_hold',
      message: 'You already have an active hold. Please wait for payment to complete.',
      holdSecondsLeft: s.holdSecondsLeft,
    });
  }

  return res.status(500).json({ error: 'Unexpected error' });
});

module.exports = router;
