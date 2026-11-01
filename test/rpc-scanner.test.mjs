import test from 'node:test';
import assert from 'node:assert/strict';
import { Rpc } from '../src/rpc.mjs';
import { Store } from '../src/store.mjs';
import { Scanner } from '../src/scanner.mjs';
import { cfg, NOW } from './helpers.mjs';
import { W, C, T, OTHER } from './helpers.mjs';
import { BSC } from '../src/rpc.mjs';
import { TRANSFER, ZERO_TOPIC, addrWord, word } from '../src/abi.mjs';
test('read-only RPC refuses transaction submission methods', async () => {
  const r = new Rpc([]);
  await assert.rejects(r.request('eth_sendRawTransaction', ['0x00']), /mutation/);
});
test('RPC checks the actual chain ID before using an endpoint', async () => {
  const r = new Rpc(['https://example.invalid'], 100, async () => ({ ok: true, json: async () => ({ result: '0x1' }) }));
  await assert.rejects(r.head(), /Wrong chain/);
});
test('RPC failure does not silently advance the discovery cursor', async () => {
  const s = new Store(); await s.transaction(x => { x.scan.lastBlock = 9; });
  const rpc = { head: async () => 12, block: async () => ({ hash: 'block10', parentHash: 'block9', timestamp: '0x1', transactions: [{ hash: 'tx1' }] }), request: async () => null };
  const scanner = new Scanner(rpc, s, cfg(), () => NOW);
  await assert.rejects(scanner.tick(), /Incomplete receipts/); assert.equal(s.snapshot().scan.lastBlock, 9);
});
test('reorganization stops discovery rather than trusting a mismatched parent', async () => {
  const s = new Store(); await s.transaction(x => { x.scan.lastBlock = 9; x.scan.lastHash = 'old'; });
  const rpc = { head: async () => 12, block: async () => ({ hash: 'new', parentHash: 'fork', transactions: [] }) };
  await assert.rejects(new Scanner(rpc, s, cfg(), () => NOW).tick(), /reorganization/);
  assert.equal(s.snapshot().scan.lastBlock, 9);
});
test('successful mint observations count verified senders, not the airdropped recipients', async () => {
  const s = new Store();
  const txs = [{ hash: 'one', from: W, to: C }, { hash: 'two', from: OTHER, to: C }];
  const rpc = { head: async () => 11, block: async () => ({ hash: 'block10', parentHash: 'block9', timestamp: '0x' + BigInt(NOW / 1000).toString(16), transactions: txs }),
    request: async (_, [hash]) => ({ blockHash: 'block10', status: '0x1', logs: [{ address: T, topics: [TRANSFER, ZERO_TOPIC, '0x' + addrWord(W)], data: '0x' + word(1000) }] }),
    identity: async () => ({ fingerprint: 'id', code: '0x' + BSC.registry.slice(2) }),
    call: async (_, data) => '0x' + word(data.endsWith(addrWord(W)) ? 1 : 0) };
  const scanner = new Scanner(rpc, s, cfg(), () => NOW);
  await scanner.tick(); const c = scanner.context(s.snapshot().scan.candidates[C]);
  assert.equal(c.observations.length, 2); assert.equal(c.agentCount, 1); assert.equal(c.burstCount, 1);
  assert.equal(c.observations.find(x => x.wallet === OTHER).isAgent, false);
});
test('heat deduplicates verified senders and excludes legacy, future and stale observations', () => {
  const scanner = new Scanner({}, new Store(), cfg(), () => NOW);
  const observation = (wallet, at, isAgent) => ({ wallet, at, isAgent });
  const c = scanner.context({ agents: [W, OTHER], observations: [observation(W, NOW, true), observation(W, NOW - 1000, true), observation(OTHER, NOW, false), observation(C, NOW, undefined), observation(T, NOW + 1, true), observation(C, NOW - 86400000, true)] });
  assert.equal(c.agentCount, 1); assert.equal(c.burstCount, 1); assert.equal(c.heatTier, 0);
});
