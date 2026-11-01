import { address } from './config.mjs';
const MAX_BYTES = 1 << 20;
const POOL_ID = /^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const label = x => String(x || '').replace(/[^a-zA-Z0-9 ._-]/g, '').slice(0, 60);
export function listedPools(payload, asset) {
  if (!Array.isArray(payload) || payload.length > 500) throw new Error('Invalid market pool list');
  const pools = new Map();
  for (const p of payload) {
    const base = String(p?.baseToken?.address || '').toLowerCase(), quote = String(p?.quoteToken?.address || '').toLowerCase();
    const id = String(p?.pairAddress || '').toLowerCase(), liquidity = p?.liquidity?.usd;
    if (p?.chainId !== 'bsc' || ![base, quote].includes(asset) || !POOL_ID.test(id) || typeof liquidity !== 'number' || !Number.isFinite(liquidity) || liquidity <= 0) continue;
    pools.set(id, { id, dex: label(p.dexId), labels: Array.isArray(p.labels) ? p.labels.slice(0, 4).map(label) : [], liquidityUsd: liquidity });
  }
  return [...pools.values()].sort((a, b) => b.liquidityUsd - a.liquidityUsd);
}
async function smallJson(response) {
  if (!response.ok) throw new Error('Market HTTP failure');
  if (Number(response.headers.get('content-length') || 0) > MAX_BYTES) throw new Error('Market response too large');
  if (!response.body) throw new Error('Missing market response');
  const reader = response.body.getReader(), chunks = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) throw new Error('Market response too large');
      chunks.push(value);
    }
  } catch (e) { await reader.cancel().catch(() => {}); throw e; }
  finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
// Public pool listings can veto a new mint or trigger a reminder. They cannot
// supply executable quotes, alter peaks/costs, or authorize a different router.
export class MarketObserver {
  constructor(cfg, fetcher = fetch, clock = Date.now) { this.cfg = cfg; this.fetcher = fetcher; this.clock = clock; this.cache = new Map(); this.inFlight = new Map(); this.requests = []; }
  async pools(token) {
    const asset = address(token), now = this.clock();
    if (!this.cfg.enabled) return { status: 'disabled', at: now, pools: [] };
    const cached = this.cache.get(asset);
    if (cached && now < cached.expiresAt) return structuredClone(cached.value);
    if (this.inFlight.has(asset)) return structuredClone(await this.inFlight.get(asset));
    this.requests = this.requests.filter(t => now - t < 60000);
    if (this.requests.length >= this.cfg.maxRequestsPerMinute) return { status: 'rate-limited', at: now, pools: [] };
    this.requests.push(now);
    const task = (async () => {
      let value;
      try {
        const response = await this.fetcher('https://api.dexscreener.com/token-pairs/v1/bsc/' + asset, { redirect: 'error', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(this.cfg.timeoutMs) });
        value = { status: 'ok', at: this.clock(), pools: listedPools(await smallJson(response), asset) };
      } catch { value = { status: 'unavailable', at: this.clock(), pools: [] }; }
      const ttl = value.status === 'ok' ? this.cfg.cacheSeconds * 1000 : Math.min(this.cfg.cacheSeconds * 1000, 15000);
      this.cache.delete(asset); this.cache.set(asset, { value, expiresAt: this.clock() + ttl });
      if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value);
      return value;
    })();
    this.inFlight.set(asset, task);
    try { return structuredClone(await task); } finally { this.inFlight.delete(asset); }
  }
}
