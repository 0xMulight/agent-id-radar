import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Executor } from '../src/executor.mjs';
import { W, T, NOW, HASH, cfg, snapshot, plan, sim, envelope } from './helpers.mjs';
function setup(c = cfg({ mode: 'live' }), extra = {}) {
  const store = new Store(); let sends = 0;
  const wallet = { preview: async p => ({ requestId: 'request-1', sim: sim(), envelope: envelope(p) }), broadcast: async () => { sends++; return HASH; }, ...extra };
  const executor = new Executor(store, c, { walletFor: () => wallet, clock: () => NOW, liveArmed: true });
  return { store, wallet, executor, sends: () => sends };
}
test('shadow plan cannot broadcast or create a real reservation', async () => {
  const x = setup(cfg());
  const r = await x.executor.submit(plan(), snapshot(), async () => snapshot());
  assert.equal(r.status, 'shadow'); assert.equal(x.sends(), 0); assert.deepEqual(x.store.snapshot().reservations, {});
});
test('shadow mode still enforces the daily budget', async () => {
  const x = setup(cfg({ limits: { globalDailyBnb: '0.0005' } }));
  await assert.rejects(x.executor.submit(plan(), snapshot(), async () => snapshot()), /daily budget/);
  assert.equal(x.sends(), 0);
});
test('mode=live alone does not arm broadcasts', async () => {
  const x = setup(); x.executor.liveArmed = false;
  await assert.rejects(x.executor.submit(plan(), snapshot(), async () => snapshot()), /explicit --execute/); assert.equal(x.sends(), 0);
});
test('a code upgrade between preview and execution aborts before broadcast', async () => {
  const x = setup();
  await assert.rejects(x.executor.submit(plan(), snapshot(), async () => snapshot({ identity: 'changed' })));
  assert.equal(x.sends(), 0); assert.deepEqual(x.store.snapshot().reservations, {});
});
test('concurrent same-wallet entries serialize and cannot broadcast twice', async () => {
  const x = setup();
  const results = await Promise.allSettled([x.executor.submit(plan(), snapshot(), async () => snapshot()), x.executor.submit(plan(), snapshot(), async () => snapshot())]);
  assert.equal(x.sends(), 1); assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(Object.values(x.store.snapshot().reservations)[0].status, 'pending');
});
test('broadcast timeout stays unknown and never auto-releases the budget', async () => {
  const x = setup(cfg({ mode: 'live' }), { broadcast: async () => { throw new Error('timeout'); } });
  await assert.rejects(x.executor.submit(plan(), snapshot(), async () => snapshot()), /timeout/);
  const r = Object.values(x.store.snapshot().reservations)[0]; assert.equal(r.status, 'unknown');
  await assert.rejects(x.executor.submit(plan(), snapshot(), async () => snapshot()), /unresolved/);
});
test('malicious simulation produces no reservation and no broadcast', async () => {
  const x = setup(cfg({ mode: 'live' }), { preview: async () => ({ requestId: 'bad', sim: sim({ authorityChanges: [{}] }) }) });
  await assert.rejects(x.executor.submit(plan(), snapshot(), async () => snapshot()), /AUTHORITY/);
  assert.equal(x.sends(), 0); assert.deepEqual(x.store.snapshot().reservations, {});
});
test('even an armed live run cannot send when the official signing envelope is absent', async () => {
  const x = setup(cfg({ mode: 'live' }), { preview: async () => ({ requestId: 'one', sim: sim() }) });
  await assert.rejects(x.executor.submit(plan(), snapshot(), async () => snapshot()), /envelope unavailable/);
  assert.equal(x.sends(), 0); assert.deepEqual(x.store.snapshot().reservations, {});
});
