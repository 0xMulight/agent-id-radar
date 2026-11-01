import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Ledger } from '../src/ledger.mjs';
import { units } from '../src/money.mjs';
import { cfg, reservation, W, OTHER, NOW, C } from './helpers.mjs';
test('parallel wallets cannot overspend the common daily budget', async () => {
  const s = new Store(), l = new Ledger(s, cfg({ limits: { globalDailyBnb: '0.008' } }), () => NOW);
  const results = await Promise.allSettled([l.reserve(reservation('one')), l.reserve(reservation('two', OTHER))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
});
test('one unresolved request blocks new actions across the same wallet', async () => {
  const s = new Store(), l = new Ledger(s, cfg(), () => NOW);
  await l.reserve(reservation('one')); await l.transition('one', 'broadcasting'); await l.transition('one', 'unknown');
  await assert.rejects(l.reserve(reservation('two', W, { project: OTHER })), /unresolved/);
  await assert.rejects(l.release('one', 'timeout'), /Cannot release/);
  await assert.rejects(l.transition('one', 'released'), /Invalid intent/);
});
test('cumulative project limit is not reset by an alternate path', async () => {
  const s = new Store(), l = new Ledger(s, cfg(), () => NOW);
  await l.reserve(reservation('one', W, { usdMicro: '11000000', action: 'approve' }));
  await s.transaction(x => { x.reservations.one.status = 'confirmed'; });
  await assert.rejects(l.reserve(reservation('two', W, { usdMicro: '2000000' })), /Project cumulative/);
});
test('free mint cannot consume reserved BNB or exceed the free Gas cap', async () => {
  const s = new Store(), l = new Ledger(s, cfg(), () => NOW);
  await assert.rejects(l.reserve(reservation('one', W, { bnbWei: '0', nativeValueWei: '0', freeMint: true, balanceWei: String(units('0.006')) })), /reserve/);
  const q = new Ledger(new Store(), cfg({ limits: { freeGasDailyBnb: '0.00005' } }), () => NOW);
  await assert.rejects(q.reserve(reservation('two', W, { bnbWei: '0', nativeValueWei: '0', freeMint: true })), /Free mint Gas/);
});
test('temporary 0.08 cap expires and does not renew on restart', async () => {
  const c = cfg({ temporaryDailyLimit: { globalDailyBnb: '0.08', expiresAt: new Date(NOW - 1).toISOString() } });
  const s = new Store(), l = new Ledger(s, c, () => NOW);
  await assert.rejects(l.reserve(reservation('big', W, { bnbWei: String(units('0.06')), nativeValueWei: String(units('0.06')), usdMicro: '1000000' })), /Global daily/);
});
test('pending reservations across midnight remain counted', async () => {
  const s = new Store(); let now = Date.parse('2026-11-01T15:59:59Z');
  const l = new Ledger(s, cfg({ limits: { globalDailyBnb: '0.008' } }), () => now);
  await l.reserve(reservation('before')); now += 2000;
  await assert.rejects(l.reserve(reservation('after', OTHER)), /Global daily/);
});
test('exit approval can use Gas after the buy budget is exhausted', async () => {
  const s = new Store(), l = new Ledger(s, cfg({ limits: { globalDailyBnb: '0.00001' } }), () => NOW);
  await l.reserve(reservation('exit', W, { action: 'approve', exitApproval: true, bnbWei: '0', nativeValueWei: '0', usdMicro: '0', balanceWei: String(units('0.0002')) }));
  assert.equal(s.snapshot().reservations.exit.status, 'reserved');
});
test('dry-run budget validation does not reserve funds', async () => {
  const s = new Store(), l = new Ledger(s, cfg(), () => NOW);
  await l.preview(reservation('paper')); assert.deepEqual(s.snapshot().reservations, {});
});
test('state survives restart and process locks prevent duplicate workers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-state-')), file = join(dir, 'state.json');
  try {
    const s = new Store(file), l = new Ledger(s, cfg(), () => NOW);
    await l.reserve(reservation('one')); assert.throws(() => new Store(file), /Another Radar/); s.close();
    const reopened = new Store(file); assert.equal(reopened.snapshot().reservations.one.status, 'reserved'); reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('automatic revoke is still constrained by the separate global Gas cap', async () => {
  const l = new Ledger(new Store(), cfg({ limits: { globalGasDailyBnb: '0.00001' } }), () => NOW);
  await assert.rejects(l.reserve(reservation('revoke', W, { action: 'revoke', bnbWei: '0', nativeValueWei: '0', usdMicro: '0' })), /Global automatic Gas/);
});
