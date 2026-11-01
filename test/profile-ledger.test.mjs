import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profile, ownerMessage, PERSONAL_DEFAULTS } from '../personal/profile.mjs';
import { PersonalLedger } from '../personal/ledger.mjs';
import { W, OTHER, C, NOW, order, units } from './helpers.mjs';
const config = extra => ({ wallets: [{ name: 'test.ai', address: W }], ...extra });
test('default observation and two live signals prevent accidental broadcasts', () => {
  assert.equal(profile(config()).mode, 'observe');
  assert.throws(() => profile(config({ personal: { mode: 'live' } })), /--execute/);
  assert.throws(() => profile(config(), ['--execute']), /观察模式/);
  assert.equal(profile(config({ personal: { mode: 'live' } }), ['--execute']).mode, 'live');
});
test('old template configs and unknown personal settings are rejected clearly', () => {
  assert.throws(() => profile(config({ schemaVersion: 1 })), /旧版/);
  assert.throws(() => profile(config({ personal: { requireRefund: false } })), /未知/);
  assert.throws(() => profile(config({ personal: { perProjectUsd: 'Infinity' } })));
});
test('a group member is not the owner even if the chat ID matches', () => {
  const m = { chat: { id: -100 }, from: { id: 8, is_bot: false } };
  assert.equal(ownerMessage(m, { chatId: '-100' }), false);
  assert.equal(ownerMessage(m, { chatId: '-100', controlUserId: '7' }), false);
  assert.equal(ownerMessage(m, { chatId: '-100', controlUserId: '8' }), true);
  assert.equal(ownerMessage({ chat: { id: 8 }, from: { id: 8 } }, { chatId: '8' }), true);
});
test('concurrent wallets share the same daily reservation cap', async () => {
  const l = new PersonalLedger(null, PERSONAL_DEFAULTS, () => NOW);
  const a = order({ project: null, principalWei: String(units('0.03')), nativeDebitWei: String(units('0.03')) });
  const r = await Promise.allSettled([l.reserve(a), l.reserve({ ...a, wallet: OTHER })]);
  assert.equal(r.filter(x => x.status === 'fulfilled').length, 1);
});
test('full increased payment plus Gas is counted against project cumulative spending', async () => {
  const l = new PersonalLedger(null, PERSONAL_DEFAULTS, () => NOW);
  const first = await l.reserve(order({ principalWei: String(units('0.01')), nativeDebitWei: String(units('0.01')) }));
  await l.finish(first, { gasWei: String(units('0.0001')), principalWei: String(units('0.01')) });
  await assert.rejects(l.reserve(order({ principalWei: String(units('0.007')), nativeDebitWei: String(units('0.007')) })), /累计/);
});
test('unknown requests survive midnight and block the same wallet', async () => {
  let now = Date.parse('2026-11-01T15:59:59Z'); const l = new PersonalLedger(null, PERSONAL_DEFAULTS, () => now);
  const id = await l.reserve(order()); await l.set(id, 'unknown'); now += 2000;
  await assert.rejects(l.reserve(order({ project: OTHER })), /結果不明/); assert.equal(l.records()[0].status, 'unknown');
});
test('exit operations can use their Gas budget after the buy cap is exhausted', async () => {
  const l = new PersonalLedger(null, { ...PERSONAL_DEFAULTS, globalDailyBnb: '0.00001' }, () => NOW);
  assert.ok(await l.reserve(order({ principalWei: '0', nativeDebitWei: '0', exit: true })));
});
test('Gas reserve protects exits and the global Gas cap still applies', async () => {
  const l = new PersonalLedger(null, PERSONAL_DEFAULTS, () => NOW);
  await assert.rejects(l.reserve(order({ balanceWei: String(units('0.01')) })), /保留/);
  const small = new PersonalLedger(null, { ...PERSONAL_DEFAULTS, globalGasDailyBnb: '0.0001' }, () => NOW);
  await assert.rejects(small.reserve(order({ exit: true })), /Gas 预算/);
});
test('durable uncertain records and process locks survive restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mulight-orders-')), file = join(dir, 'orders.json'); let l;
  try {
    l = new PersonalLedger(file, PERSONAL_DEFAULTS, () => NOW); const id = await l.reserve(order()); await l.set(id, 'broadcasting', { orderId: 'private-order' });
    assert.throws(() => new PersonalLedger(file, PERSONAL_DEFAULTS), /Another/); l.close();
    l = new PersonalLedger(file, PERSONAL_DEFAULTS, () => NOW); assert.equal(l.records()[0].status, 'broadcasting');
    await assert.rejects(l.reserve(order()), /結果不明/);
  } finally { l?.close(); rmSync(dir, { recursive: true, force: true }); }
});
