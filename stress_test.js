#!/usr/bin/env node
/**
 * stress_test.js — Fire 30 concurrent buy requests against the server.
 * Only 20 stock exists. Exactly 20 should get holds, 10 should be waitlisted.
 * If overselling were possible, holds > 20 would occur.
 */

const http = require('http');

function buy(userId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ userId });
    const req = http.request({
      hostname: '127.0.0.1',
      port: 3000,
      path: '/buy',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function reset() {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: 3000, path: '/admin/reset', method: 'POST',
    }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  console.log('Resetting stock to 20...');
  await reset();

  console.log('Firing 30 concurrent buy requests...\n');
  const users = Array.from({ length: 30 }, (_, i) => `stressUser${i + 1}`);
  const results = await Promise.all(users.map(buy));

  const holds     = results.filter(r => r.status === 'hold_placed').length;
  const waitlisted = results.filter(r => r.status === 'waitlisted').length;
  const other     = results.filter(r => r.status !== 'hold_placed' && r.status !== 'waitlisted');

  console.log(`hold_placed:  ${holds}   ← must be exactly 20`);
  console.log(`waitlisted:   ${waitlisted}  ← must be exactly 10`);
  console.log(`other:        ${other.length}  ← must be 0`);
  if (other.length > 0) console.log('unexpected:', other);

  const ok = holds === 20 && waitlisted === 10 && other.length === 0;
  console.log(`\n${ok ? '✅ PASS — no overselling!' : '❌ FAIL — check the logic!'}`);
  process.exit(ok ? 0 : 1);
}

main();
