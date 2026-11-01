import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEnvelope, BawWallet } from '../src/baw.mjs';
import { plan, envelope, W, OTHER, HASH } from './helpers.mjs';
test('live envelope pins sender, target, data, value and maximum Gas', () => {
  const p = plan(), e = envelope(p); assert.equal(validateEnvelope(e, p), true);
  for (const edit of [{ to: OTHER }, { from: OTHER }, { value: '0x0' }, { chainId: '0x1' }, { data: '0x095ea7b3' }, { gasPrice: '100000000000' }, { authorizationList: [{}] }]) assert.throws(() => validateEnvelope({ ...e, ...edit }, p));
});
test('missing signing envelope cannot silently downgrade the live check', () => { assert.throws(() => validateEnvelope(null, plan()), /unavailable/); });
test('shadow Baw adapter cannot broadcast even if a runner is injected', async () => {
  let calls = 0;
  const b = new BawWallet({ address: W }, { runner: async () => { calls++; return { success: true, data: { txHash: HASH } }; } });
  await assert.rejects(b.broadcast('anything'), /disabled/); assert.equal(calls, 0);
});
