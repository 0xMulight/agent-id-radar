import test from 'node:test';
import assert from 'node:assert/strict';
import { EntrySchedule } from '../src/entry-schedule.mjs';
import { Runtime } from '../src/runtime.mjs';
import { Store } from '../src/store.mjs';
import { BSC } from '../src/rpc.mjs';
import { cfg, NOW, W, C, T, OTHER, snapshot, plan } from './helpers.mjs';
const templates = [C, T, OTHER].map(contract => ({ contract, asset: contract, kind: 'free-fixed' }));
test('newer unseen templates are checked first and each tick is bounded', () => {
  const c = cfg({ scan: { maxEntryChecksPerTick: 2 } }), schedule = new EntrySchedule(c, () => NOW);
  const selected = schedule.claim(templates, t => ({ firstSeen: NOW - templates.indexOf(t) * 1000 }));
  assert.deepEqual(selected.map(x => x.template.contract), [C, T]);
  assert.deepEqual(schedule.claim(templates, () => ({})).map(x => x.template.contract), [OTHER]);
});
test('a busy hot queue leaves capacity for ordinary templates', () => {
  const c = cfg({ scan: { maxEntryChecksPerTick: 2 } }), schedule = new EntrySchedule(c, () => NOW);
  const due = schedule.claim(templates, t => ({ firstSeen: NOW, heatTier: t.contract === OTHER ? 0 : 1 }));
  assert.equal(due.length, 2); assert.ok(due.some(x => x.template.contract === OTHER)); assert.ok(due.some(x => x.hot));
});
test('near-threshold templates return sooner without changing entry thresholds', () => {
  let now = NOW; const c = cfg(), schedule = new EntrySchedule(c, () => now);
  schedule.claim([templates[0]], () => ({})); schedule.observe(C, {}, { progressBps: 5800 });
  now += c.scan.hotMs - 1; assert.equal(schedule.claim([templates[0]], () => ({})).length, 0);
  now++; assert.equal(schedule.claim([templates[0]], () => ({})).length, 1); assert.equal(c.entry.progressBps, 6000);
});
test('inactive templates slow down and resume quickly after new verified activity', () => {
  let now = NOW;
  const c = cfg(), schedule = new EntrySchedule(c, () => now), old = { firstSeen: NOW - 2 * 86400000, lastSeen: NOW - 86400001 };
  assert.equal(schedule.interval(old), c.scan.coldMs);
  assert.equal(schedule.interval({ ...old, lastSeen: NOW, heatTier: 1 }), c.scan.hotMs);
  assert.equal(schedule.interval(old, { progressBps: 5900, observedAt: NOW - 3 * c.scan.normalMs }), c.scan.coldMs);
  schedule.claim([templates[0]], () => old); now += c.scan.hotMs;
  assert.equal(schedule.claim([templates[0]], () => old).length, 0);
  assert.equal(schedule.claim([templates[0]], () => ({ ...old, lastSeen: now, heatTier: 1 })).length, 1);
});
test('a single scheduler slot fairly rotates popular and ordinary templates', () => {
  let now = NOW; const c = cfg({ scan: { maxEntryChecksPerTick: 1 } }), schedule = new EntrySchedule(c, () => now);
  const context = t => ({ firstSeen: NOW, heatTier: t.contract === C ? 1 : 0 });
  const first = schedule.claim(templates, context); now += c.scan.normalMs;
  const second = schedule.claim(templates, context);
  assert.notEqual(first[0].template.contract, second[0].template.contract);
});
test('runtime bounds parallel checks and skips already-filled templates', async () => {
  const c = cfg({ wallets: [{ address: W }], scan: { maxEntryChecksPerTick: 2, entryConcurrency: 2 } }); c.templates = templates;
  const store = new Store(); await store.transaction(s => { s.reservations.old = { wallet: W, project: OTHER, action: 'mint', status: 'confirmed' }; });
  const runtime = new Runtime(c, store, { rpc: {}, clock: () => NOW, logger: () => {} }); let active = 0, peak = 0, checked = 0;
  runtime.planner = { snapshot: async t => { active++; peak = Math.max(peak, active); checked++; await new Promise(resolve => setImmediate(resolve)); active--; return snapshot({ target: t.contract }); }, mintPlan: async () => ({ plan: plan() }) };
  runtime.executor.submit = async () => ({ status: 'shadow' });
  await runtime.entries(); assert.equal(checked, 2); assert.equal(peak, 2);
});
test('independent allowance cleanup still sees already-filled templates', async () => {
  const c = cfg({ wallets: [{ address: W }] }); c.templates = [{ contract: C, asset: T, kind: 'usdt-fixed' }];
  const store = new Store(); await store.transaction(s => {
    s.reservations.grant = { wallet: W, project: T, action: 'approve', status: 'confirmed', confirmedAt: NOW - 120000, plan: { token: BSC.usdt, spender: C } };
    s.reservations.mint = { wallet: W, project: T, action: 'mint', status: 'confirmed' };
  });
  const runtime = new Runtime(c, store, { rpc: {}, clock: () => NOW, logger: () => {} }); let cleaned = 0;
  runtime.cleanupApproval = async () => { cleaned++; };
  await runtime.entries(); assert.equal(cleaned, 0); await runtime.cleanups(); assert.equal(cleaned, 1);
  await store.transaction(s => { s.reservations.revoke = { wallet: W, project: T, action: 'revoke', status: 'confirmed', confirmedAt: NOW, plan: { token: BSC.usdt, spender: C } }; });
  await runtime.cleanups(); assert.equal(cleaned, 1);
});
