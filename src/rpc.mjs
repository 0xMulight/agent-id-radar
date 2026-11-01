import { createHash } from 'node:crypto';
import { address } from './config.mjs';
import { addrWord, word, uint, selector } from './abi.mjs';
import { WAD, USD } from './money.mjs';
export const BSC = {
  registry: '0x60b9262456de011f7d15a54cdd8c48baaa8b022f',
  usdt: '0x55d398326f99059ff775485246999027b3197955',
  wbnb: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  native: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  router: '0x10ed43c718714eb63d5aa57b78b54704e256024e'
};
const IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const BEACON = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const READS = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getCode', 'eth_getStorageAt', 'eth_call', 'eth_getBalance', 'eth_getTransactionCount', 'eth_estimateGas', 'eth_gasPrice', 'eth_getLogs']);
export class Rpc {
  constructor(urls, timeout = 8000, fetcher = fetch) { this.urls = urls; this.timeout = timeout; this.fetcher = fetcher; this.index = 0; this.checked = new Set(); }
  async request(method, params = []) {
    if (!READS.has(method)) throw new Error('RPC mutation or unsupported method refused');
    if (!this.urls.length) throw new Error('Configure at least one HTTPS BSC RPC');
    let error;
    for (let n = 0; n < this.urls.length; n++) {
      const url = this.urls[(this.index + n) % this.urls.length];
      try {
        const invoke = async (m, p) => {
          const r = await this.fetcher(url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }), signal: AbortSignal.timeout(this.timeout) });
          if (!r.ok) throw new Error('RPC HTTP ' + r.status);
          const j = await r.json(); if (j.error || !Object.hasOwn(j, 'result')) throw new Error('RPC returned an error'); return j.result;
        };
        if (!this.checked.has(url)) { if (await invoke('eth_chainId', []) !== '0x38') throw new Error('Wrong chain: BSC 56 required'); this.checked.add(url); }
        const result = await invoke(method, params); this.index = (this.index + n) % this.urls.length; return result;
      } catch (e) { error = e; }
    }
    throw error || new Error('RPC unavailable');
  }
  async head() { return Number(BigInt(await this.request('eth_blockNumber'))); }
  async block(number, full = false) { return this.request('eth_getBlockByNumber', ['0x' + Number(number).toString(16), full]); }
  async call(to, data, block = 'latest', from) { return this.request('eth_call', [{ to: address(to), data, ...(from ? { from: address(from) } : {}) }, block]); }
  async balance(wallet, token = BSC.native, block = 'latest') {
    if (token === BSC.native) return BigInt(await this.request('eth_getBalance', [address(wallet), block]));
    return uint(await this.call(token, selector('balanceOf(address)') + addrWord(wallet), block));
  }
  async identity(target, block = 'latest') {
    const visited = new Set(), parts = [];
    const walk = async (a, depth) => {
      a = address(a); if (visited.has(a)) throw new Error('Cyclic proxy'); if (depth > 4) throw new Error('Proxy depth limit'); visited.add(a);
      const code = await this.request('eth_getCode', [a, block]); if (!code || code === '0x') throw new Error('No contract code');
      const [impl, beacon] = await Promise.all([IMPL, BEACON].map(slot => this.request('eth_getStorageAt', [a, slot, block])));
      parts.push({ address: a, code, impl, beacon });
      const clone = code.toLowerCase().match(/^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/);
      if (clone) await walk('0x' + clone[1], depth + 1);
      else if (BigInt(impl) > 0n) await walk('0x' + impl.slice(-40), depth + 1);
      else if (BigInt(beacon) > 0n) {
        const b = address('0x' + beacon.slice(-40)), bc = await this.request('eth_getCode', [b, block]);
        parts.push({ address: b, code: bc, beacon: true });
        const r = await this.call(b, selector('implementation()'), block); await walk('0x' + r.slice(-40), depth + 1);
      }
    };
    await walk(target, 0);
    return { fingerprint: 'sha256:' + createHash('sha256').update(JSON.stringify(parts)).digest('hex'), code: parts.map(p => p.code).join(''), parts };
  }
  async quote(path, amount, block = 'latest') {
    const data = selector('getAmountsOut(uint256,address[])') + word(amount) + word(64) + word(path.length) + path.map(addrWord).join('');
    const r = await this.call(BSC.router, data, block);
    if (!/^0x[0-9a-fA-F]+$/.test(r) || r.length < 194) throw new Error('Invalid route quote');
    const len = Number(BigInt('0x' + r.slice(66, 130)));
    if (uint(r) !== 32n || len !== path.length || r.length !== 130 + len * 64) throw new Error('Invalid route quote array');
    return BigInt('0x' + r.slice(-64));
  }
  async bnbPrice(block = 'latest') {
    const raw = await this.quote([BSC.wbnb, BSC.usdt], WAD, block), micro = raw / (WAD / USD);
    if (micro <= 0n) throw new Error('BNB price unavailable'); return micro;
  }
  async saleQuote(token, amount, originalQty, blockInfo) {
    const block = '0x' + blockInfo.number.toString(16), choices = [];
    for (const path of [[token, BSC.wbnb], [token, BSC.usdt, BSC.wbnb]]) {
      if (new Set(path).size !== path.length) continue;
      try {
        const out = await this.quote(path, amount, block);
        const probe = originalQty / 100n || 1n, probeOut = await this.quote(path, probe, block);
        if (out > 0n && probeOut > 0n) choices.push({ path, out, probe, probeOut });
      } catch {}
    }
    if (!choices.length) throw new Error('No verified Pancake V2 sale route; other DEX routes are observation-only');
    choices.sort((a, b) => a.out > b.out ? -1 : 1);
    const q = choices[0], bnbPrice = await this.bnbPrice(block), unitPrice = q.probeOut * bnbPrice / q.probe;
    return { outWei: q.out.toString(), unitPrice: unitPrice.toString(), usdMicro: (q.out * bnbPrice / WAD).toString(), priceImpactBps: Number((q.probeOut * amount > q.out * q.probe ? (q.probeOut * amount - q.out * q.probe) * 10000n / (q.probeOut * amount) : 0n)), bnbPrice: bnbPrice.toString(), path: q.path, sampleId: blockInfo.hash, blockNumber: blockInfo.number, at: blockInfo.at };
  }
}
