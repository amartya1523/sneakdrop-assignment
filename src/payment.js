/**
 * payment.js — Fake payment service
 *
 * Simulates a real payment provider:
 *  - Sometimes the webhook arrives LATE (up to 8 seconds delay)
 *  - Sometimes it arrives TWICE (duplicate messages) — the system is idempotent
 *  - Sometimes a FAILURE message arrives before a SUCCESS (out-of-order)
 *    (we ignore failures and only process success)
 *
 * In a real system you'd receive these via an incoming webhook.
 * Here we simulate it internally via a callback to /pay/webhook.
 */

const { v4: uuidv4 } = require('uuid');

/**
 * Kicks off a fake payment flow for a user.
 * Returns a paymentId immediately. The "payment provider" will call
 * our webhook endpoint asynchronously with the result.
 *
 * @param {string} userId
 * @param {function} webhookHandler - async fn({ paymentId, userId, status })
 * @returns {string} paymentId
 */
function initiateFakePayment(userId, webhookHandler) {
  const paymentId = uuidv4();
  const baseDelay = Math.floor(Math.random() * 6000) + 1000; // 1–7 seconds

  console.log(`[Payment] Initiating payment ${paymentId} for user ${userId}, will arrive in ~${baseDelay}ms`);

  // Simulate out-of-order: sometimes a FAILURE arrives first, then SUCCESS
  const sendFailureFirst = Math.random() < 0.3;
  if (sendFailureFirst) {
    const failureDelay = Math.floor(Math.random() * 800) + 200;
    setTimeout(() => {
      console.log(`[Payment] Sending FAILURE first (out-of-order) for ${paymentId}`);
      webhookHandler({ paymentId, userId, status: 'failed' }).catch(() => {});
    }, failureDelay);
  }

  // PRIMARY success webhook
  setTimeout(async () => {
    console.log(`[Payment] Sending SUCCESS for ${paymentId}`);
    try {
      await webhookHandler({ paymentId, userId, status: 'succeeded' });
    } catch (e) {
      console.error(`[Payment] Webhook error: ${e.message}`);
    }
  }, baseDelay);

  // Simulate duplicate: sometimes send it again
  const sendDuplicate = Math.random() < 0.4;
  if (sendDuplicate) {
    const dupDelay = baseDelay + Math.floor(Math.random() * 3000) + 500;
    setTimeout(async () => {
      console.log(`[Payment] Sending DUPLICATE webhook for ${paymentId}`);
      try {
        await webhookHandler({ paymentId, userId, status: 'succeeded' });
      } catch (e) {}
    }, dupDelay);
  }

  return paymentId;
}

module.exports = { initiateFakePayment };
