import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Executor } from '../src/executor.mjs';
import { TRANSFER, ZERO_TOPIC, addrWord, word } from '../src/abi.mjs';
import { W, C, T, NOW, HASH, cfg, plan, snapshot, sim, envelope } from './helpers.mjs';
function fakeRpc(p, { status = '0x1', wrongTo = false, delivery = true, gasPrice = 1000000000n } = {}) {
  const receipt = { status, transactionHash: HASH, blockNumber: '0xa', blockHash: 'block10', gasUsed: '0x5208', effectiveGasPrice: '0x' + gasPrice.toString(16), logs: delivery ? [{ address: T, topics: [TRANSFER, ZERO_TOPIC, '0x' + addrWord(W)], data: '0x' + word(1000) }] : [] };
  return { head: async () => 11, block: async () => ({ hash: 'block10', timestamp: '0x' + BigInt(NOW / 1000).toString(16) }), bnbPrice: async () => 700000000n,
    request: async method => method === 'eth_getTransactionReceipt' ? receipt : { from: W, to: wrongTo ? T : C, input: p.data, value: '0x' + BigInt(p.valueWei).toString(16) } };
}
test('confirmed receipt settles fees and creates the position exactly once', async () => {
  const store = new Store(), p = plan(), c = cfg({ mode: 'live' });
  const e = new Executor(store, c, { rpc: fakeRpc(p), walletFor: () => ({ preview: async () => ({ requestId: 'one', sim: sim(), envelope: envelope(p) }), broadcast: async () => HASH }), liveArmed: true, clock: () => NOW });
  await e.submit(p, snapshot(), async () => snapshot()); await e.reconcile(); await e.reconcile();
  const s = store.snapshot(), record = Object.values(s.reservations)[0];
  assert.equal(record.status, 'confirmed'); assert.equal(record.actualUsdMicro, '714700');
  assert.equal(s.positions[W + ':' + T].qty, '1000'); assert.equal(s.positions[W + ':' + T].costUsdMicro, '714700');
  assert.equal(s.events.filter(x => x.type === 'receipt').length, 1);
});
test('reverted receipt records the real failed Gas and does not create a position', async () => {
  const store = new Store(), p = plan(), c = cfg({ mode: 'live' });
  const e = new Executor(store, c, { rpc: fakeRpc(p, { status: '0x0', delivery: false }), walletFor: () => ({ preview: async () => ({ requestId: 'one', sim: sim(), envelope: envelope(p) }), broadcast: async () => HASH }), liveArmed: true, clock: () => NOW });
  await e.submit(p, snapshot(), async () => snapshot()); await e.reconcile();
  assert.equal(Object.values(store.snapshot().reservations)[0].status, 'failed');
  assert.equal(Object.values(store.snapshot().reservations)[0].actualUsdMicro, '14700');
  assert.deepEqual(store.snapshot().positions, {});
});
test('unmatched sender/target receipt cannot unlock a reserved transaction', async () => {
  const store = new Store(), p = plan(), c = cfg({ mode: 'live' });
  const e = new Executor(store, c, { rpc: fakeRpc(p, { wrongTo: true }), walletFor: () => ({ preview: async () => ({ requestId: 'one', sim: sim(), envelope: envelope(p) }), broadcast: async () => HASH }), liveArmed: true, clock: () => NOW });
  await e.submit(p, snapshot(), async () => snapshot()); await assert.rejects(e.reconcile(), /does not match/);
  assert.equal(Object.values(store.snapshot().reservations)[0].status, 'pending');
});
test('success without the expected asset remains locked for review', async () => {
  const store = new Store(), p = plan(), c = cfg({ mode: 'live' });
  const e = new Executor(store, c, { rpc: fakeRpc(p, { delivery: false }), walletFor: () => ({ preview: async () => ({ requestId: 'one', sim: sim(), envelope: envelope(p) }), broadcast: async () => HASH }), liveArmed: true, clock: () => NOW });
  await e.submit(p, snapshot(), async () => snapshot()); await assert.rejects(e.reconcile(), /did not deliver/);
  assert.deepEqual(store.snapshot().positions, {});
});
