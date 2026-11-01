import test from 'node:test';
import assert from 'node:assert/strict';
import { Rpc } from '../src/rpc.mjs';
import { Store } from '../src/store.mjs';
import { Scanner } from '../src/scanner.mjs';
import { cfg, NOW } from './helpers.mjs';
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
