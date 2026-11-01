import { BSC } from './rpc.mjs';
import { TRANSFER, ZERO_TOPIC, topicAddress, BALANCE, addrWord, uint } from './abi.mjs';
export async function mapLimit(items, limit, fn) {
  let index = 0; const out = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (index < items.length) { const i = index++; out[i] = await fn(items[i], i); } }));
  return out;
}
export class Scanner {
  constructor(rpc, store, cfg, clock = Date.now) { this.rpc = rpc; this.store = store; this.cfg = cfg; this.clock = clock; this.agentCache = new Map(); }
  async isAgent(wallet, block) {
    const key = wallet + ':' + block, found = this.agentCache.get(key); if (found !== undefined) return found;
    const yes = uint(await this.rpc.call(BSC.registry, BALANCE + addrWord(wallet), block)) > 0n;
    this.agentCache.set(key, yes); if (this.agentCache.size > 5000) this.agentCache.delete(this.agentCache.keys().next().value); return yes;
  }
  async tick() {
    const head = await this.rpc.head(), safeHead = head - this.cfg.scan.confirmations + 1;
    let last = this.store.snapshot().scan.lastBlock;
    if (last === null) last = Math.max(0, safeHead - 1);
    const end = Math.min(safeHead, last + this.cfg.scan.maxBlocksPerTick);
    for (let n = last + 1; n <= end; n++) {
      const block = await this.rpc.block(n, true); if (!block?.hash || !Array.isArray(block.transactions)) throw new Error('Incomplete block; cursor not advanced');
      const prior = this.store.snapshot().scan;
      if (prior.lastBlock === n - 1 && prior.lastHash && block.parentHash !== prior.lastHash) throw new Error('Chain reorganization detected; stop and reconcile cursor before continuing');
      const receipts = await mapLimit(block.transactions, this.cfg.scan.receiptConcurrency, async tx => {
        const r = await this.rpc.request('eth_getTransactionReceipt', [tx.hash]);
        if (!r || r.blockHash !== block.hash) throw new Error('Incomplete receipts; cursor not advanced');
        return { tx, r };
      });
      const updates = new Map(), at = Number(BigInt(block.timestamp)) * 1000, tag = '0x' + n.toString(16);
      const candidate = (a) => { a = a.toLowerCase(); if (!updates.has(a)) updates.set(a, { addresses: new Set(), txs: [], deployedBy: null }); return updates.get(a); };
      for (const { tx, r } of receipts) {
        if (r.status !== '0x1') continue;
        if (r.contractAddress) { const x = candidate(r.contractAddress); x.deployedBy = tx.from.toLowerCase(); }
        for (const l of r.logs || []) if (l.topics?.[0] === TRANSFER && l.topics[1] === ZERO_TOPIC && l.topics[2] && [3, 4].includes(l.topics.length)) {
          const x = candidate(l.address); x.addresses.add(tx.from.toLowerCase()); x.txs.push({ hash: tx.hash, wallet: tx.from.toLowerCase(), at });
          if (tx.to) { const parent = candidate(tx.to); parent.addresses.add(tx.from.toLowerCase()); parent.txs.push({ hash: tx.hash, wallet: tx.from.toLowerCase(), at }); }
        }
      }
      const discoveries = [];
      await mapLimit([...updates.entries()], this.cfg.scan.receiptConcurrency, async ([target, update]) => {
        if (target === BSC.registry || target === BSC.wbnb || target === BSC.usdt) return;
        const known = this.store.snapshot().scan.candidates[target], hasTemplate = this.cfg.templates.some(t => t.contract === target);
        let gated = Boolean(known?.agentGated), identity = null;
        if (!known) {
          try { identity = await this.rpc.identity(target, tag); gated = identity.code.toLowerCase().includes(BSC.registry.slice(2)); } catch { return; }
        }
        let verified = 0;
        for (const a of update.addresses) if (await this.isAgent(a, tag)) verified++;
        if (!gated && !hasTemplate && verified === 0) return;
        discoveries.push({ target, update, gated, identity: identity?.fingerprint, verified });
      });
      await this.store.transaction(s => {
        for (const d of discoveries) {
          const x = s.scan.candidates[d.target] ||= { contract: d.target, firstSeen: at, observations: [], agents: [], notified: false };
          x.agentGated ||= d.gated; x.deployer ||= d.update.deployedBy; x.identity = d.identity || x.identity; x.lastSeen = at;
          const add = new Set(x.agents), seen = new Set(x.observations.map(t => t.hash));
          for (const t of d.update.txs) if (!seen.has(t.hash)) { x.observations.push(t); seen.add(t.hash); }
          // Only verified Agent-ID senders contribute to the Agent count.
          for (const a of d.update.addresses) if (this.agentCache.get(a + ':' + tag) === true) add.add(a);
          x.agents = [...add].slice(-5000); x.observations = x.observations.filter(t => at - t.at < 86400000).slice(-5000);
        }
        s.scan.lastBlock = n; s.scan.lastHash = block.hash;
        const entries = Object.entries(s.scan.candidates);
        if (entries.length > this.cfg.scan.maxCandidates) {
          const pinned = new Set(this.cfg.templates.map(t => t.contract));
          for (const [key] of entries.filter(([k]) => !pinned.has(k)).sort((a, b) => a[1].lastSeen - b[1].lastSeen).slice(0, entries.length - this.cfg.scan.maxCandidates)) delete s.scan.candidates[key];
        }
      });
    }
    const state = this.store.snapshot();
    return { head, scanned: state.scan.lastBlock, lag: safeHead - (state.scan.lastBlock || safeHead), candidates: Object.values(state.scan.candidates) };
  }
  context(candidate) {
    const now = this.clock(), burst = new Set(candidate.observations.filter(o => now - o.at < this.cfg.entry.burstSeconds * 1000).map(o => o.wallet));
    return { ...candidate, agentCount: candidate.agents.length, burstCount: burst.size, heatTier: burst.size >= this.cfg.entry.freeBurstMin ? 1 : 0 };
  }
}
