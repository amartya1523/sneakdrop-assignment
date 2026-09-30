# Notes

## How to Run

### Requirements
- **Node.js** v18+ (tested on v22)
- **Redis** v6+ (tested on v8.6.2 via Homebrew)
- **npm** v9+

### 1. Start Redis

```bash
redis-server
```

Or via Homebrew services (runs in background):

```bash
brew services start redis
```

### 2. Install dependencies

```bash
npm install
```

### 3. Start the server

```bash
npm start
```

Server runs at **http://localhost:3000**

Open that URL in your browser to use the status page.

---

## Environment Variables (optional)

| Variable     | Default     | Description              |
|--------------|-------------|--------------------------|
| `PORT`       | `3000`      | HTTP server port         |
| `REDIS_HOST` | `127.0.0.1` | Redis host               |
| `REDIS_PORT` | `6379`      | Redis port               |

---

## API Endpoints

| Method | Path           | Description                                        |
|--------|----------------|----------------------------------------------------|
| `GET`  | `/`            | Status page (browser UI)                           |
| `GET`  | `/status`      | JSON status (`?userId=alice`)                      |
| `POST` | `/buy`         | Place a hold (`{ "userId": "alice" }` in body)     |
| `POST` | `/admin/reset` | Reset stock to 20 and clear all holds (demo only)  |
| `GET`  | `/admin/dump`  | Dump all Redis state (debug)                       |

---

## Design Decisions

### The Overselling Problem — Fixed with Lua Scripts

The original bug (51 pairs sold when only 20 existed) happens because of a classic **check-then-act** race condition:

```
Thread A: reads stock = 1 ✓
Thread B: reads stock = 1 ✓
Thread A: decrements → stock = 0, gives hold
Thread B: decrements → stock = -1, gives hold  ← OVERSOLD
```

**Fix:** Every stock mutation is a single **Lua script executed atomically** by Redis. Redis is single-threaded — Lua scripts run without interruption. No two requests can race on the same counter.

```lua
-- Atomic: check stock AND decrement in one shot
local stock = tonumber(redis.call('GET', stock_key))
if stock <= 0 then return -1 end
redis.call('SET', hold_key, '1', 'EX', ttl)
redis.call('DECR', stock_key)
return 1
```

### Hold Expiry

Redis TTL handles hold expiry natively — no cron job needed. The `HOLD_TTL_SECONDS = 300` (5 minutes) is set directly on the Redis key. When it expires, Redis deletes it automatically.

When a payment succeeds, the hold key is deleted and the waitlist is advanced.

### Waitlist

Implemented as a **Redis list** (LPUSH/RPOP = FIFO queue). Each waitlist advance is also a Lua script — it atomically pops the next user, skips ineligible ones (already bought 2, already has a hold), and assigns a new hold.

### Fake Payment Service

Simulates a real payment provider with three realistic failure modes:

1. **Late delivery** — webhook arrives 1–7 seconds after `POST /buy` returns
2. **Duplicate webhooks** — 40% chance the webhook fires a second time
3. **Out-of-order messages** — 30% chance a `failed` event arrives before `succeeded`

The `confirmPayment` Lua script is **idempotent**: if the hold key doesn't exist (already confirmed or expired), it's a no-op. Duplicates are harmless.

### User Identity

Users are identified by a `userId` string (passed in request body or `X-User-Id` header). No auth system — this is a demo. In production you'd use session tokens or JWTs.

### Per-User Limits

- Max **1 active hold** at a time (enforced atomically)
- Max **2 total purchases** per user (enforced atomically)
