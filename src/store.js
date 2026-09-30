/**
 * store.js — Core stock, hold, and waitlist logic
 *
 * All stock mutations use Lua scripts executed atomically in Redis.
 * This is what prevents the "sold 51 instead of 20" overselling bug —
 * no two requests can race to decrement the same stock count.
 *
 * Keys used:
 *   stock                        → integer, current available pairs
 *   hold:{userId}                → string "1", TTL = 300s (5 min)
 *   user_purchases:{userId}      → integer, total pairs bought (max 2)
 *   waitlist                     → Redis list (LPUSH / RPOP = FIFO queue)
 *   waitlist_member:{userId}     → string "1", tells us if user is in queue
 */

const redis = require('./redis');

const TOTAL_STOCK = 20;
const HOLD_TTL_SECONDS = 300; // 5 minutes

// ── Lua: atomically decrement stock and set a hold ──────────────────────────
// Returns:
//   -3  user already has an active hold
//   -2  user has already bought 2 pairs
//   -1  stock is 0 (no pairs available)
//    1  hold placed successfully
const LUA_PLACE_HOLD = `
local hold_key    = KEYS[1]
local stock_key   = KEYS[2]
local purchase_key = KEYS[3]
local ttl         = tonumber(ARGV[1])
local max_buys    = tonumber(ARGV[2])

-- Check if user already has a hold
if redis.call('EXISTS', hold_key) == 1 then
  return -3
end

-- Check purchase limit
local purchases = tonumber(redis.call('GET', purchase_key) or '0')
if purchases >= max_buys then
  return -2
end

-- Check stock
local stock = tonumber(redis.call('GET', stock_key) or '0')
if stock <= 0 then
  return -1
end

-- Place hold
redis.call('SET', hold_key, '1', 'EX', ttl)
redis.call('DECR', stock_key)
return 1
`;

// ── Lua: confirm payment ─────────────────────────────────────────────────────
// Idempotent — safe to call multiple times (handles duplicate payment messages).
// Returns:
//    0  hold no longer exists (expired or already confirmed) — no-op
//    1  payment confirmed successfully
const LUA_CONFIRM_PAYMENT = `
local hold_key     = KEYS[1]
local purchase_key = KEYS[2]

if redis.call('EXISTS', hold_key) == 0 then
  return 0
end

redis.call('DEL', hold_key)
redis.call('INCR', purchase_key)
return 1
`;

// ── Lua: release a hold and restore stock (called when hold expires) ─────────
// Returns 0 if hold didn't exist (already handled), 1 if released.
const LUA_RELEASE_HOLD = `
local hold_key  = KEYS[1]
local stock_key = KEYS[2]

if redis.call('EXISTS', hold_key) == 0 then
  return 0
end

redis.call('DEL', hold_key)
redis.call('INCR', stock_key)
return 1
`;

// ── Lua: atomically pop next user from waitlist and give them a hold ─────────
// Returns:
//   nil   waitlist is empty
//   userId that received the hold
const LUA_ADVANCE_WAITLIST = `
local waitlist_key  = KEYS[1]
local stock_key     = KEYS[2]
local ttl           = tonumber(ARGV[1])

while true do
  local userId = redis.call('RPOP', waitlist_key)
  if not userId then
    return nil
  end

  local member_key = 'waitlist_member:' .. userId
  redis.call('DEL', member_key)

  local hold_key     = 'hold:' .. userId
  local purchase_key = 'user_purchases:' .. userId

  -- Skip if they already have a hold or exceeded purchase limit
  if redis.call('EXISTS', hold_key) == 1 then
    -- next person
  else
    local purchases = tonumber(redis.call('GET', purchase_key) or '0')
    if purchases >= 2 then
      -- next person
    else
      local stock = tonumber(redis.call('GET', stock_key) or '0')
      if stock <= 0 then
        -- Push them back? No — stock is 0, stop trying
        return nil
      end
      redis.call('SET', hold_key, '1', 'EX', ttl)
      redis.call('DECR', stock_key)
      return userId
    end
  end
end
`;

// Register scripts
let scriptHashes = {};

async function loadScripts() {
  scriptHashes.placeHold = await redis.script('LOAD', LUA_PLACE_HOLD);
  scriptHashes.confirmPayment = await redis.script('LOAD', LUA_CONFIRM_PAYMENT);
  scriptHashes.releaseHold = await redis.script('LOAD', LUA_RELEASE_HOLD);
  scriptHashes.advanceWaitlist = await redis.script('LOAD', LUA_ADVANCE_WAITLIST);
  console.log('[Store] Lua scripts loaded');
}

// ── Initialize stock (only sets if not already set) ──────────────────────────
async function initStock() {
  const existing = await redis.get('stock');
  if (existing === null) {
    await redis.set('stock', TOTAL_STOCK);
    console.log(`[Store] Stock initialized to ${TOTAL_STOCK}`);
  } else {
    console.log(`[Store] Stock already set: ${existing}`);
  }
}

// ── Place a hold for a user ───────────────────────────────────────────────────
async function placeHold(userId) {
  const result = await redis.evalsha(
    scriptHashes.placeHold,
    3,
    `hold:${userId}`,
    'stock',
    `user_purchases:${userId}`,
    HOLD_TTL_SECONDS,
    2
  );
  return result; // -3, -2, -1, or 1
}

// ── Confirm payment ───────────────────────────────────────────────────────────
async function confirmPayment(userId) {
  const result = await redis.evalsha(
    scriptHashes.confirmPayment,
    2,
    `hold:${userId}`,
    `user_purchases:${userId}`
  );
  if (result === 1) {
    // Hold released, try to advance the waitlist
    await advanceWaitlist();
  }
  return result; // 0 or 1
}

// ── Release an expired hold and restore stock ─────────────────────────────────
// Called when we detect a hold has expired (via polling or keyspace events).
// NOTE: In production you'd use Redis keyspace notifications. For this demo,
// the hold TTL handles automatic expiry — we just also call this manually
// from the payment route when it's too late to confirm.
async function releaseHold(userId) {
  const result = await redis.evalsha(
    scriptHashes.releaseHold,
    2,
    `hold:${userId}`,
    'stock'
  );
  if (result === 1) {
    await advanceWaitlist();
  }
  return result;
}

// ── Join the waitlist ─────────────────────────────────────────────────────────
async function joinWaitlist(userId) {
  const alreadyIn = await redis.get(`waitlist_member:${userId}`);
  if (alreadyIn) {
    return { alreadyIn: true };
  }
  await redis.lpush('waitlist', userId);
  await redis.set(`waitlist_member:${userId}`, '1');
  const position = await getWaitlistPosition(userId);
  return { alreadyIn: false, position };
}

// ── Get a user's position in the waitlist ─────────────────────────────────────
async function getWaitlistPosition(userId) {
  const list = await redis.lrange('waitlist', 0, -1);
  // LPUSH adds to left, RPOP reads from right → right side is front of queue
  const reversed = list.slice().reverse();
  const pos = reversed.indexOf(userId);
  return pos === -1 ? null : pos + 1;
}

// ── Advance the waitlist (give next person a hold) ────────────────────────────
async function advanceWaitlist() {
  const userId = await redis.evalsha(
    scriptHashes.advanceWaitlist,
    2,
    'waitlist',
    'stock',
    HOLD_TTL_SECONDS
  );
  if (userId) {
    console.log(`[Waitlist] Advanced: ${userId} now has a hold`);
  }
  return userId;
}

// ── Get status for a user ─────────────────────────────────────────────────────
async function getStatus(userId) {
  const [stock, holdTTL, purchases, waitlistPos] = await Promise.all([
    redis.get('stock'),
    userId ? redis.ttl(`hold:${userId}`) : Promise.resolve(-2),
    userId ? redis.get(`user_purchases:${userId}`) : Promise.resolve('0'),
    userId ? getWaitlistPosition(userId) : Promise.resolve(null),
  ]);

  return {
    pairsLeft: parseInt(stock || '0', 10),
    holdSecondsLeft: holdTTL > 0 ? holdTTL : 0,
    hasHold: holdTTL > 0,
    totalPurchased: parseInt(purchases || '0', 10),
    waitlistPosition: waitlistPos,
  };
}

module.exports = {
  loadScripts,
  initStock,
  placeHold,
  confirmPayment,
  releaseHold,
  joinWaitlist,
  getStatus,
  HOLD_TTL_SECONDS,
  TOTAL_STOCK,
};
