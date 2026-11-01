import test from 'node:test';
import assert from 'node:assert/strict';
import { openPosition, observePosition, saleDecision, applySale, coreReminders, reconcileExternalBalance } from '../src/positions.mjs';
import { replay } from '../src/replay.mjs';
import { readFileSync } from 'node:fs';
import { cfg, W, T, NOW, quote } from './helpers.mjs';
function paid() { return openPosition({ wallet: W, asset: T, qty: '1000', costUsdMicro: '12000000', now: NOW }, cfg()); }
function recovered() { const p = paid(); applySale(p, { qty: '500', proceedsUsdMicro: '12100000', gasUsdMicro: '10000', includesCore: false }, cfg(), NOW); return p; }
test('paid core is half of remaining quantity and locks exactly once', () => {
  const p = recovered(); assert.equal(p.coreQty, '250'); assert.equal(p.tradeQty, '250');
  applySale(p, { qty: '100', proceedsUsdMicro: '10000000', includesCore: false }, cfg(), NOW + 1000);
  assert.equal(p.coreQty, '250'); assert.equal(p.tradeQty, '150');
});
test('an unfilled or insufficient recovery is not marked as recovered', () => {
  const p = paid(); applySale(p, { qty: '100', proceedsUsdMicro: '2000000', includesCore: false }, cfg(), NOW);
  assert.equal(p.coreLocked, false); assert.equal(p.coreQty, '0');
});
test('free trailing exit only sells the 70% trading portion', () => {
  const c = cfg(), p = openPosition({ wallet: W, asset: T, qty: '1000', free: true, now: NOW }, c);
  let q = quote(1, 0, '0.10', 700); observePosition(p, q, c, NOW);
  q = quote(2, 5, '0.10', 700); observePosition(p, q, c, NOW + 5000);
  q = quote(3, 10, '0.04', 700); observePosition(p, q, c, NOW + 10000); assert.equal(saleDecision(p, q, c, { now: NOW + 10000 }), null);
  q = quote(4, 15, '0.04', 700); observePosition(p, q, c, NOW + 15000);
  const d = saleDecision(p, q, c, { now: NOW + 15000 }); assert.equal(d.qty, '700'); assert.equal(d.includesCore, false);
  applySale(p, { ...d, proceedsUsdMicro: '28000000' }, c, NOW + 15000);
  assert.equal(p.qty, '300'); assert.equal(p.closedAt, null); assert.equal(p.coreQty, '300');
});
test('repeated cache and same block cannot count as two crash confirmations', () => {
  const c = cfg(), p = paid(); observePosition(p, quote(1, 0, '0.012'), c, NOW);
  const q = quote(2, 5, '0.006'); observePosition(p, q, c, NOW + 5000);
  assert.equal(observePosition(p, q, c, NOW + 6000), false);
  assert.equal(p.dropCount, 1); assert.equal(saleDecision(p, q, c, { now: NOW + 6000 }), null);
});
test('long data gaps reset consecutive confirmation count', () => {
  const c = cfg(), p = paid(); observePosition(p, quote(1, 0, '0.012'), c, NOW);
  observePosition(p, quote(2, 5, '0.006'), c, NOW + 5000);
  observePosition(p, quote(3, 90, '0.006'), c, NOW + 90000);
  assert.equal(p.dropCount, 1);
});
test('partial take profit retains a fixed target and does not sell the same stage twice', () => {
  const c = cfg(), p = recovered(), q = quote(1, 5, '0.12', 250);
  observePosition(p, q, c, NOW + 5000);
  const first = saleDecision(p, q, c, { now: NOW + 5000 }); assert.equal(first.kind, 'step'); assert.equal(first.qty, '75');
  applySale(p, { ...first, qty: '25', proceedsUsdMicro: '3000000', complete: false }, c, NOW + 5000);
  assert.deepEqual(p.steps, []);
  const next = quote(2, 10, '0.12', 225); observePosition(p, next, c, NOW + 10000);
  const rest = saleDecision(p, next, c, { now: NOW + 10000 }); assert.equal(rest.qty, '50');
  applySale(p, { ...rest, proceedsUsdMicro: '6000000', complete: true }, c, NOW + 10000);
  assert.deepEqual(p.steps, [10]); assert.equal(p.coreQty, '250');
});
test('ordinary sale cannot consume protected core even if caller asks for more', () => {
  const p = recovered();
  assert.throws(() => applySale(p, { qty: '251', proceedsUsdMicro: '1', includesCore: false }, cfg(), NOW), /protected core/);
});
test('safety emergency includes core, while reminders do not create sales', () => {
  const c = cfg(), p = recovered();
  assert.deepEqual(coreReminders(p, NOW + 86400001), [24]);
  assert.deepEqual(coreReminders(p, NOW + 2 * 86400000), [48]);
  assert.deepEqual(coreReminders(p, NOW + 2 * 86400000 + 1), []);
  const d = saleDecision(p, null, c, { emergency: true, now: NOW }); assert.equal(d.qty, '500'); assert.equal(d.includesCore, true);
});
test('manual balance change requires reconciliation, not re-allocating a fresh core', () => {
  const p = recovered();
  assert.equal(reconcileExternalBalance(p, 1000n), false); assert.equal(p.needsReview, true); assert.equal(p.coreQty, '250');
});
test('fee-inclusive recovery and protected quantity survive restart serialization', () => {
  const p = recovered(), restored = JSON.parse(JSON.stringify(p));
  applySale(restored, { qty: '20', proceedsUsdMicro: '1000000', gasUsdMicro: '1000', includesCore: false }, cfg(), NOW);
  assert.equal(restored.coreQty, '250');
});
test('three synthetic scenarios include both second-day recovery and continuing decline', () => {
  const tape = JSON.parse(readFileSync(new URL('../examples/replay.json', import.meta.url), 'utf8'));
  const rows = replay(tape);
  assert.equal(rows[0].coreQty, '300'); assert.equal(rows[0].remainingMarkedUsd, '90');
  assert.equal(rows[1].coreQty, '242'); assert.equal(rows[2].remainingQty, '0');
  assert.match(rows[2].netMarkedPnlUsd, /^-/);
});
test('one abnormal high quote is not immediately adopted as a reliable high-water mark', () => {
  const c = cfg(), p = openPosition({ wallet: W, asset: T, qty: '1000', free: true, now: NOW }, c);
  observePosition(p, quote(1, 0, '1', 700), c, NOW);
  assert.equal(p.peak, '0');
  observePosition(p, quote(2, 5, '0.10', 700), c, NOW + 5000);
  assert.equal(p.peak, '0');
  observePosition(p, quote(3, 10, '0.10', 700), c, NOW + 10000);
  assert.equal(p.peak, String(100000n * 10n ** 18n)); assert.equal(p.dropCount, 0);
});
