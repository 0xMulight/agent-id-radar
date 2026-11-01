import { units, dayKey } from './money.mjs';
import { dailyLimit } from './config.mjs';
const uncertain = new Set(['reserved', 'broadcasting', 'pending', 'unknown']);
function counted(r) { return r.status !== 'released'; }
export class Ledger {
  constructor(store, cfg, clock = Date.now) { this.store = store; this.cfg = cfg; this.clock = clock; }
  async preview(order) {
    const probe = Object.create(this);
    probe.store = { transaction: async fn => fn(this.store.snapshot()) };
    return probe.reserve(order);
  }
  async reserve(order) {
    const now = this.clock(), c = this.cfg;
    for (const k of ['bnbWei', 'gasWei', 'usdMicro']) if (BigInt(order[k]) < 0n) throw new Error('Negative reservation');
    return this.store.transaction(s => {
      if (s.reservations[order.id]) throw new Error('Duplicate intent');
      const all = Object.values(s.reservations), today = dayKey(now);
      if (all.some(r => r.wallet === order.wallet && uncertain.has(r.status))) throw new Error('Wallet has an unresolved transaction');
      if (order.action === 'mint' && all.some(r => r.wallet === order.wallet && r.project === order.project && r.action === 'mint' && r.status === 'confirmed')) throw new Error('Project already minted by this wallet');
      const gas = BigInt(order.gasWei), principal = BigInt(order.bnbWei), total = gas + principal;
      if (gas > units(c.limits.maxGasPerTransactionBnb)) throw new Error('Gas limit exceeded');
      const gasToday = all.filter(r => counted(r) && (r.day === today || uncertain.has(r.status))).reduce((a, r) => a + BigInt(r.gasWeiActual ?? r.gasWei), 0n);
      if (gasToday + gas > units(c.limits.globalGasDailyBnb)) throw new Error('Global automatic Gas budget exceeded');
      if (order.action !== 'sell' && order.action !== 'revoke' && !order.exitApproval) {
        const day = all.filter(r => counted(r) && (r.day === today || uncertain.has(r.status)) && !['sell', 'revoke'].includes(r.action) && !r.exitApproval);
        const used = day.reduce((a, r) => a + BigInt(r.actualBnbWei ?? r.totalWei), 0n);
        if (used + total > dailyLimit(c, now)) throw new Error('Global daily budget exceeded');
        const wu = day.filter(r => r.wallet === order.wallet).reduce((a, r) => a + BigInt(r.actualBnbWei ?? r.totalWei), 0n);
        if (wu + total > units(c.limits.walletDailyBnb)) throw new Error('Wallet daily budget exceeded');
        const project = all.filter(r => counted(r) && r.wallet === order.wallet && r.project === order.project && !['sell', 'revoke'].includes(r.action) && !r.exitApproval).reduce((a, r) => a + BigInt(r.actualUsdMicro ?? r.usdMicro), 0n);
        if (project + BigInt(order.usdMicro) > units(c.limits.perProjectUsd, 6)) throw new Error('Project cumulative budget exceeded');
        const failed = all.filter(r => r.wallet === order.wallet && r.day === today && r.status === 'failed').length;
        if (failed >= c.limits.maxFailures) throw new Error('Failure circuit breaker is open');
        if (principal > 0n) {
          const recent = all.filter(r => counted(r) && BigInt(r.bnbWei) > 0n && now - r.createdAt < c.limits.paidWindowSeconds * 1000 && !['sell', 'revoke'].includes(r.action));
          if (recent.length >= c.limits.maxPaidInWindow) throw new Error('Paid transaction burst circuit breaker is open');
        }
        if (order.freeMint) {
          const free = day.filter(r => r.wallet === order.wallet && r.freeMint);
          if (free.length >= c.limits.maxFreeTransactions) throw new Error('Free transaction count exceeded');
          if (free.reduce((a, r) => a + BigInt(r.actualBnbWei ?? r.totalWei), 0n) + total > units(c.limits.freeGasDailyBnb)) throw new Error('Free mint Gas budget exceeded');
        }
        if (BigInt(order.balanceWei) - BigInt(order.nativeValueWei ?? principal) - gas < units(c.limits.gasReserveBnb)) throw new Error('Wallet Gas reserve would be consumed');
      } else if (BigInt(order.balanceWei) < gas) throw new Error('Insufficient Gas for exit/revoke');
      s.reservations[order.id] = { ...order, bnbWei: String(principal), gasWei: String(gas), usdMicro: String(order.usdMicro), totalWei: String(total), day: today, createdAt: now, status: 'reserved' };
      return structuredClone(s.reservations[order.id]);
    });
  }
  transition(id, status, extra = {}) {
    return this.store.transaction(s => {
      const r = s.reservations[id]; if (!r) throw new Error('Unknown intent');
      if (['confirmed', 'failed', 'released'].includes(r.status)) throw new Error('Intent is already terminal');
      const allowed = { reserved: ['broadcasting'], broadcasting: ['pending', 'unknown'], pending: ['unknown'], unknown: ['pending'] };
      if (!allowed[r.status]?.includes(status)) throw new Error('Invalid intent state transition');
      for (const key of Object.keys(extra)) if (!['requestId', 'txHash', 'reason'].includes(key)) throw new Error('Cannot change reserved amounts');
      Object.assign(r, extra, { status }); return structuredClone(r);
    });
  }
  release(id, reason) {
    return this.store.transaction(s => {
      const r = s.reservations[id]; if (!r || r.status !== 'reserved') throw new Error('Cannot release an already-broadcast or unknown transaction');
      r.status = 'released'; r.reason = reason;
    });
  }
}
