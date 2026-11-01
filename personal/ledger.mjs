import { randomUUID } from 'node:crypto';
import { units, dayKey } from './money.mjs';
import { Store } from './store.mjs';
const PENDING = new Set(['reserved', 'broadcasting', 'unknown']);
export class PersonalLedger {
  constructor(file, cfg, clock = Date.now) { this.store = new Store(file); this.cfg = cfg; this.clock = clock; }
  close() { this.store.close(); }
  records() { return Object.values(this.store.snapshot().reservations); }
  remainingUsd(wallet, project, price) {
    const day = dayKey(this.clock()), all = this.records(), relevant = all.filter(r => r.status !== 'released');
    const dayRows = relevant.filter(r => r.day === day || PENDING.has(r.status));
    const daily = units(this.cfg.globalDailyBnb) - dayRows.filter(r => !r.exit).reduce((s, r) => s + BigInt(r.spentBnbWei ?? r.reservedBnbWei), 0n);
    const used = relevant.filter(r => r.wallet === wallet && r.project === project && !r.exit).reduce((s, r) => s + BigInt(r.spentUsdMicro ?? r.reservedUsdMicro), 0n);
    const per = units(this.cfg.perProjectUsd, 6) - used;
    const amount = daily * price / (10n ** 18n), available = amount < per ? amount : per;
    return available > 0n ? available : 0n;
  }
  async reserve(order) {
    const now = this.clock(), day = dayKey(now), id = randomUUID();
    return this.store.transaction(s => {
      const rows = Object.values(s.reservations).filter(r => r.status !== 'released');
      if (rows.some(r => r.wallet === order.wallet && PENDING.has(r.status))) throw new Error('結果不明：此钱包有未完成请求，先到钱包核对；不会自动重试');
      const gas = BigInt(order.gasWei), principal = BigInt(order.principalWei), price = BigInt(order.price), cost = principal + gas;
      if (gas <= 0n || gas > units(this.cfg.maxGasBnb) || principal < 0n || price <= 0n) throw new Error('Gas 或付款估算无效／超额');
      const today = rows.filter(r => r.day === day || PENDING.has(r.status));
      const gasUsed = today.reduce((sum, r) => sum + BigInt(r.gasWeiActual ?? r.gasWei), 0n);
      if (gasUsed + gas > units(this.cfg.globalGasDailyBnb)) throw new Error('全天自动 Gas 预算已达上限');
      const usd = cost * price / (10n ** 18n);
      if (!order.exit) {
        const used = today.filter(r => !r.exit).reduce((sum, r) => sum + BigInt(r.spentBnbWei ?? r.reservedBnbWei), 0n);
        if (used + cost > units(this.cfg.globalDailyBnb)) throw new Error('所有钱包合计日预算已达上限');
        const project = rows.filter(r => r.wallet === order.wallet && r.project === order.project && !r.exit).reduce((sum, r) => sum + BigInt(r.spentUsdMicro ?? r.reservedUsdMicro), 0n);
        if (order.project && project + usd > units(order.nft ? this.cfg.nftMaxUsd : this.cfg.perProjectUsd, 6)) throw new Error('单项目累计付款及 Gas 超过预算');
        if (BigInt(order.balanceWei) - BigInt(order.nativeDebitWei || '0') - gas < units(this.cfg.keepBnb)) throw new Error('需要保留退出用 BNB');
      } else if (BigInt(order.balanceWei) < gas) throw new Error('退出 Gas 不足');
      s.reservations[id] = { ...order, id, day, createdAt: now, reservedBnbWei: String(cost), reservedUsdMicro: String(usd), status: 'reserved' };
      return id;
    });
  }
  set(id, status, extra = {}) { return this.store.transaction(s => { const r = s.reservations[id]; if (!r || !PENDING.has(r.status)) throw new Error('不可修改已结束订单'); Object.assign(r, extra, { status }); }); }
  finish(id, { gasWei, principalWei, failed = false }) {
    return this.store.transaction(s => {
      const r = s.reservations[id]; if (!r || !PENDING.has(r.status)) throw new Error('订单状态异常');
      const total = BigInt(gasWei) + (failed ? 0n : BigInt(principalWei));
      Object.assign(r, { status: failed ? 'failed' : 'confirmed', gasWeiActual: String(gasWei), spentBnbWei: String(total), spentUsdMicro: String(total * BigInt(r.price) / (10n ** 18n)), confirmedAt: this.clock(), day: dayKey(this.clock()) });
    });
  }
}
