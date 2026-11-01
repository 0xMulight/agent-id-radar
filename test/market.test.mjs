import test from 'node:test';
import assert from 'node:assert/strict';
import { MarketObserver, listedPools } from '../src/market.mjs';
import { Planner } from '../src/planner.mjs';
import { Runtime } from '../src/runtime.mjs';
import { Store } from '../src/store.mjs';
import { BSC } from '../src/rpc.mjs';
import { word, selector } from '../src/abi.mjs';
import { entryGate } from '../src/guard.mjs';
import { cfg, W, C, T, OTHER, NOW, IDENTITY } from './helpers.mjs';
const pool = (extra = {}) => ({ chainId: 'bsc', dexId: 'pancakeswap', pairAddress: OTHER, labels: ['v3'], baseToken: { address: T }, quoteToken: { address: BSC.wbnb }, liquidity: { usd: 500 }, priceUsd: '999999999', ...extra });
const response = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
test('market observation is off by default and makes no requests', async () => {
  let calls = 0; const m = new MarketObserver(cfg().market, async () => { calls++; }, () => NOW);
  assert.equal((await m.pools(T)).status, 'disabled'); assert.equal(calls, 0);
});
test('pool listings require the exact BSC token and never expose a trading price', () => {
  const pools = listedPools([pool(), pool({ chainId: 'ethereum' }), pool({ baseToken: { address: C } }), pool({ liquidity: { usd: 0 } }), pool({ pairAddress: 'https://evil.invalid' })], T);
  assert.equal(pools.length, 1); assert.equal(pools[0].id, OTHER); assert.equal(pools[0].priceUsd, undefined);
  assert.equal(listedPools([pool({ baseToken: { address: C }, quoteToken: { address: T } })], T).length, 1);
  assert.equal(listedPools([pool({ pairAddress: '0x' + 'e'.repeat(64), labels: ['infinity'] })], T).length, 1);
});
test('observation caches results, shares in-flight requests and refuses redirects', async () => {
  let calls = 0, now = NOW; const c = cfg({ market: { enabled: true } });
  const m = new MarketObserver(c.market, async (url, options) => {
    calls++; assert.equal(url, 'https://api.dexscreener.com/token-pairs/v1/bsc/' + T); assert.equal(options.redirect, 'error');
    await new Promise(resolve => setImmediate(resolve)); return response([pool()]);
  }, () => now);
  const [a, b] = await Promise.all([m.pools(T), m.pools(T)]); assert.equal(calls, 1); a.pools.length = 0; assert.equal(b.pools.length, 1);
  assert.equal((await m.pools(T)).pools.length, 1); assert.equal(calls, 1);
  now += c.market.cacheSeconds * 1000; await m.pools(T); assert.equal(calls, 2);
});
test('all token observations share one request rate limit', async () => {
  let calls = 0; const c = cfg({ market: { enabled: true, maxRequestsPerMinute: 1 } });
  const m = new MarketObserver(c.market, async () => { calls++; return response([]); }, () => NOW);
  await m.pools(T); assert.equal((await m.pools(C)).status, 'rate-limited'); assert.equal(calls, 1);
});
test('unavailable and oversized responses stay unknown instead of meaning no pool', async () => {
  const c = cfg({ market: { enabled: true } });
  for (const fetcher of [async () => { throw new Error('provider failed'); }, async () => response({ pairs: [] }), async () => new Response('x'.repeat((1 << 20) + 1))]) {
    const r = await new MarketObserver(c.market, fetcher, () => NOW).pools(T);
    assert.equal(r.status, 'unavailable'); assert.deepEqual(r.pools, []);
  }
});
function planning(marketResult, { otherDexReview = true, enabled = true } = {}) {
  const c = cfg({ market: { enabled } }), t = { contract: C, asset: T, kind: 'free-fixed', assetType: 'ERC20', identity: IDENTITY, assetIdentity: IDENTITY,
    calldata: selector('mint()'), review: { note: 'review fixture', expiresAt: new Date(NOW + 86400000).toISOString() }, poolReview: { noOtherDex: otherDexReview } };
  const rpc = { head: async () => 10, identity: async () => ({ fingerprint: IDENTITY }), balance: async () => 1000000000000000000n, bnbPrice: async () => 700000000n, call: async () => '0x' + word(0) };
  return { c, t, planner: new Planner(rpc, c, () => NOW, { pools: async () => marketResult }) };
}
test('a listed V3 or Infinity pool vetoes a mint despite a previous manual pool review', async () => {
  const { c, t, planner } = planning({ status: 'ok', pools: listedPools([pool()], T) });
  const s = await planner.snapshot(t, { address: W }, { agentCount: 100, burstCount: 25, heatTier: 1 });
  assert.equal(s.poolOpen, true); assert.throws(() => entryGate(s, c, NOW), /POOL_ALREADY_OPEN/);
});
test('an empty market listing never proves that other DEX pools are absent', async () => {
  const { t, planner } = planning({ status: 'ok', pools: [] }, { otherDexReview: false });
  assert.equal((await planner.snapshot(t, { address: W })).poolOpen, null);
});
test('an enabled but unavailable observer blocks new entry', async () => {
  const { t, planner } = planning({ status: 'unavailable', pools: [] });
  assert.equal((await planner.snapshot(t, { address: W })).poolOpen, null);
});
test('market reminders cannot change quantities, peaks, cost or send orders', async () => {
  const c = cfg({ market: { enabled: true } }), store = new Store();
  await store.transaction(s => { s.positions.one = { asset: T, qty: '1000', coreQty: '300', tradeQty: '700', peak: '200', costUsdMicro: '12000000' }; });
  const before = store.snapshot().positions;
  const runtime = new Runtime(c, store, { rpc: {}, logger: () => {}, clock: () => NOW, market: { pools: async () => ({ status: 'ok', pools: listedPools([pool()], T) }) } });
  let messages = 0; runtime.notifier.send = async () => { messages++; }; runtime.executor.submit = async () => { assert.fail('A public listing must not trade'); };
  await runtime.marketWatch(); assert.equal(messages, 1); assert.deepEqual(store.snapshot().positions, before);
});
test('configuration bounds entry concurrency and public observation', () => {
  assert.throws(() => cfg({ scan: { entryConcurrency: 100 } }), /scheduling/);
  assert.throws(() => cfg({ scan: { hotMs: 120000 } }), /scheduling/);
  assert.throws(() => cfg({ market: { enabled: 'true' } }), /boolean/);
  assert.throws(() => cfg({ market: { maxRequestsPerMinute: 10000 } }), /limits/);
  assert.throws(() => cfg({ market: { endpoint: 'https://evil.invalid' } }), /Unknown config/);
});
