import { Rpc, BSC } from './rpc.mjs';
import { Scanner, mapLimit } from './scanner.mjs';
import { EntrySchedule } from './entry-schedule.mjs';
import { MarketObserver } from './market.mjs';
import { Planner } from './planner.mjs';
import { Executor } from './executor.mjs';
import { BawWallet } from './baw.mjs';
import { Notifier } from './notifier.mjs';
import { observePosition, saleDecision, coreReminders, reconcileExternalBalance } from './positions.mjs';
import { ALLOWANCE, addrWord, uint } from './abi.mjs';
export class Runtime {
  constructor(cfg, store, { rpc = null, walletFor = null, liveArmed = false, logger = console.log, clock = Date.now, market = null } = {}) {
    this.cfg = cfg; this.store = store; this.rpc = rpc || new Rpc(cfg.rpcs, cfg.scan.rpcTimeoutMs); this.logger = logger;
    this.clock = clock; this.market = market || new MarketObserver(cfg.market, fetch, clock);
    this.scanner = new Scanner(this.rpc, store, cfg, clock); this.planner = new Planner(this.rpc, cfg, clock, this.market);
    const wallets = new Map(cfg.wallets.map(w => [w.address, new BawWallet(w, { live: cfg.mode === 'live' && liveArmed })]));
    this.executor = new Executor(store, cfg, { rpc: this.rpc, walletFor: walletFor || (a => { if (!wallets.has(a)) throw new Error('Wallet not configured'); return wallets.get(a); }), liveArmed, clock });
    this.notifier = new Notifier(cfg, store, fetch, logger); this.entrySchedule = new EntrySchedule(cfg, clock); this.nextMarket = new Map(); this.cleanupChecks = new Map(); this.timers = []; this.stopped = false; this.running = new Map();
  }
  async reportError(where, e) {
    // Do not print raw RPC URLs, arbitrary provider errors, CLI stdout, or credential-containing messages.
    const reason = typeof e.code === 'string' ? e.code : String(e.message || 'Unknown error').replace(/https?:\/\/\S+/g, '[provider]').slice(0, 180);
    await this.store.event('error', { where, reason });
    await this.notifier.send('error:' + where + ':' + reason, '[' + where + '] ' + reason);
  }
  async scan() {
    const result = await this.scanner.tick();
    if (result.lag > this.cfg.scan.maxBlocksPerTick * 4) await this.notifier.send('scan-lag', '扫描落后 ' + result.lag + ' 个区块；没有跳过游标，请检查节点速度。');
    for (const x of result.candidates) {
      const c = this.scanner.context(x);
      if (!this.cfg.templates.some(t => t.contract === c.contract) && (c.agentCount >= this.cfg.entry.minAgents || c.burstCount >= this.cfg.entry.freeBurstMin)) {
        await this.notifier.send('candidate:' + c.contract, '候选项目 ' + c.contract + '\n24 小时内已验证 Agent ID 发送者 ' + c.agentCount + '；近期已验证发送者 ' + c.burstCount + '\n缺少本地审核模板，只观察，不自动付款。', { intervalMs: 86400000 });
      }
    }
  }
  async cleanupApproval(t, wallet, candidate, force = false) {
    if (t.kind !== 'usdt-fixed') return false;
    const records = Object.values(this.store.snapshot().reservations);
    const finished = records.some(r => r.wallet === wallet.address && r.project === t.asset && r.action === 'mint' && ['confirmed', 'failed'].includes(r.status));
    const granted = records.filter(r => r.wallet === wallet.address && r.project === t.asset && r.action === 'approve' && !r.exitApproval && r.plan?.spender === t.contract && r.status === 'confirmed').at(-1);
    if ((!finished && !(granted && (force || this.clock() - granted.confirmedAt > 60000))) || records.some(r => r.wallet === wallet.address && ['reserved', 'broadcasting', 'pending', 'unknown'].includes(r.status))) return false;
    if (records.filter(r => r.wallet === wallet.address && r.project === t.asset && r.action === 'revoke' && r.status === 'failed').length >= this.cfg.limits.maxFailures) return true;
    const allowance = uint(await this.rpc.call(BSC.usdt, ALLOWANCE + addrWord(wallet.address) + addrWord(t.contract)));
    if (allowance === 0n) return false;
    const snapshot = await this.planner.revokeSnapshot(wallet, BSC.usdt);
    const plan = await this.planner.approval(wallet.address, BSC.usdt, t.contract, 0n, snapshot, t.asset);
    if (this.store.snapshot().positions[wallet.address + ':' + t.asset]) plan.positionId = wallet.address + ':' + t.asset;
    await this.executor.submit(plan, snapshot, () => this.planner.revokeSnapshot(wallet, BSC.usdt)); return true;
  }
  async entries() {
    const state = this.store.snapshot(), candidates = state.scan.candidates;
    const templates = this.cfg.templates.filter(t => !this.cfg.wallets.length || !this.cfg.wallets.every(w => Object.values(state.reservations).some(r => r.wallet === w.address && r.project === t.asset && r.action === 'mint' && r.status === 'confirmed')));
    const due = this.entrySchedule.claim(templates, t => candidates[t.contract] ? this.scanner.context(candidates[t.contract]) : { agentCount: 0, burstCount: 0, heatTier: 0 });
    await mapLimit(due, this.cfg.scan.entryConcurrency, async ({ template: t, candidate }) => {
      for (const wallet of this.cfg.wallets) {
        const records = Object.values(this.store.snapshot().reservations);
        if (records.some(r => r.wallet === wallet.address && ['reserved', 'broadcasting', 'pending', 'unknown'].includes(r.status))) continue;
        try {
          if (await this.cleanupApproval(t, wallet, candidate)) continue;
          if (records.some(r => r.wallet === wallet.address && r.project === t.asset && r.action === 'mint' && r.status === 'confirmed')) continue;
          const snapshot = await this.planner.snapshot(t, wallet, candidate);
          this.entrySchedule.observe(t.contract, candidate, snapshot);
          const { plan } = await this.planner.mintPlan(t, wallet, candidate, snapshot);
          const result = await this.executor.submit(plan, snapshot, () => this.planner.snapshot(t, wallet, candidate));
          await this.notifier.send('entry:' + t.contract + ':' + wallet.address + ':' + result.status, '参与计划 ' + result.status + '\n' + t.contract + '\n钱包 ' + wallet.address, { intervalMs: 60000 });
        } catch (e) {
          await this.reportError('entry:' + t.contract, e);
          try { await this.cleanupApproval(t, wallet, candidate, true); } catch (cleanup) { await this.reportError('approval-cleanup:' + t.contract, cleanup); }
        }
      }
    });
  }
  async cleanups() {
    // Cleanup has its own cycle: an inactive or already-minted template must
    // not leave a confirmed USDT allowance waiting behind entry polling.
    const records = Object.values(this.store.snapshot().reservations), tasks = new Map();
    for (const r of records) {
      if (r.action !== 'approve' || r.exitApproval || r.status !== 'confirmed' || r.plan?.token !== BSC.usdt) continue;
      const template = this.cfg.templates.find(t => t.asset === r.project && t.contract === r.plan.spender && t.kind === 'usdt-fixed');
      const wallet = this.cfg.wallets.find(w => w.address === r.wallet);
      if (!template || !wallet || records.some(x => x.wallet === r.wallet && x.project === r.project && x.plan?.token === BSC.usdt && x.plan?.spender === r.plan.spender && x.action === 'revoke' && x.status === 'confirmed' && x.confirmedAt >= r.confirmedAt)) continue;
      tasks.set(r.wallet + ':' + r.plan.spender, { template, wallet });
    }
    for (const key of this.cleanupChecks.keys()) if (!tasks.has(key)) this.cleanupChecks.delete(key);
    const due = [...tasks.entries()].sort((a, b) => (this.cleanupChecks.get(a[0]) || 0) - (this.cleanupChecks.get(b[0]) || 0)).slice(0, this.cfg.scan.maxEntryChecksPerTick);
    await mapLimit(due, this.cfg.scan.entryConcurrency, async ([key, { template, wallet }]) => {
      this.cleanupChecks.set(key, this.clock());
      try { await this.cleanupApproval(template, wallet, {}); } catch (e) { await this.reportError('approval-cleanup:' + template.contract, e); }
    });
  }
  async marketWatch() {
    if (!this.cfg.market.enabled) return;
    const assets = [...new Set(Object.values(this.store.snapshot().positions).filter(p => BigInt(p.qty) > 0n).map(p => p.asset))];
    for (const key of this.nextMarket.keys()) if (!assets.includes(key)) this.nextMarket.delete(key);
    const due = assets.filter(a => (this.nextMarket.get(a) || 0) <= this.clock()).sort((a, b) => (this.nextMarket.get(a) || 0) - (this.nextMarket.get(b) || 0)).slice(0, this.cfg.scan.maxEntryChecksPerTick);
    for (const asset of due) {
      this.nextMarket.set(asset, this.clock() + this.cfg.market.cacheSeconds * 1000);
      const result = await this.market.pools(asset);
      if (result.status !== 'ok') { await this.notifier.send('market-unavailable', '其他 DEX 开池观察暂不可用，不以缺失数据判断未开池，也不据此买卖。'); continue; }
      for (const pool of result.pools.slice(0, 3)) await this.notifier.send('market-pool:' + asset + ':' + pool.id, '发现第三方收录的池子，请人工复核：\n' + asset + '\n池子 ' + pool.id + '\nDEX ' + pool.dex + ' ' + pool.labels.join(' ') + '\n这里只提醒；收录情况和展示价格不参与止盈止损。', { intervalMs: 6 * 3600000 });
    }
  }
  async holdings() {
    const head = await this.rpc.head(), b = await this.rpc.block(head);
    if (!b?.hash) throw new Error('No fresh quote block');
    const blockInfo = { number: head, hash: b.hash, at: Number(BigInt(b.timestamp)) * 1000 };
    for (const [id, original] of Object.entries(this.store.snapshot().positions)) {
      if (BigInt(original.qty) <= 0n) {
        if (original.closedAt && Date.now() - original.closedAt < 48 * 3600000) await this.store.event('post-exit-observation', { position: id, block: head });
        continue;
      }
      const wallet = this.cfg.wallets.find(w => w.address === original.wallet); if (!wallet) continue;
      try {
        let due = [];
        await this.store.transaction(s => { due = coreReminders(s.positions[id]); });
        for (const h of due) await this.notifier.send('core:' + id + ':' + h, '底仓已保留 ' + h + ' 小时，仅提醒复盘，不自动卖出。\n' + original.asset, { intervalMs: 365 * 86400000 });
        const balance = await this.rpc.balance(wallet.address, original.asset);
        let consistent = true;
        await this.store.transaction(s => { if (!s.positions[id].pendingSale) consistent = reconcileExternalBalance(s.positions[id], balance); });
        if (!consistent) { await this.notifier.send('balance:' + id, '仓位数量变化，已暂停自动卖出，请核对转账／补铸：' + original.asset); continue; }
        if (original.pendingSale) continue;
        const amount = BigInt(original.tradeQty) || BigInt(original.coreQty);
        const q = await this.rpc.saleQuote(original.asset, amount, BigInt(original.originalQty), blockInfo);
        let decision, reminders = [];
        await this.store.transaction(s => {
          const p = s.positions[id], fresh = observePosition(p, q, this.cfg);
          reminders = coreReminders(p);
          const emergency = this.cfg.blockedContracts.includes(p.asset) || (p.source && this.cfg.blockedContracts.includes(p.source));
          const normal = fresh ? saleDecision(p, q, this.cfg, { emergency, manualAll: p.manualExit === true }) : null;
          decision = fresh ? (normal?.includesCore ? normal : (!p.hold && !p.needsReview ? p.preparedSale || normal : null)) : null;
        });
        for (const h of reminders) await this.notifier.send('core:' + id + ':' + h, '底仓已保留 ' + h + ' 小时，仅提醒复盘，不自动卖出。\n' + original.asset, { intervalMs: 365 * 86400000 });
        if (!decision) continue;
        const current = this.store.snapshot().positions[id];
        if (current.pendingSale || Object.values(this.store.snapshot().reservations).some(r => r.wallet === wallet.address && ['reserved', 'broadcasting', 'pending', 'unknown'].includes(r.status))) continue;
        const prepared = await this.planner.sale(id, current, decision, wallet, blockInfo);
        const result = await this.executor.submit(prepared.plan, prepared.snapshot, async () => {
          const nextHead = await this.rpc.head(), nextBlock = await this.rpc.block(nextHead);
          return (await this.planner.sale(id, this.store.snapshot().positions[id], decision, wallet, { number: nextHead, hash: nextBlock.hash, at: Number(BigInt(nextBlock.timestamp)) * 1000 })).snapshot;
        });
        await this.notifier.send('sale:' + id + ':' + decision.kind + ':' + result.status, '卖出计划 ' + result.status + '：' + decision.kind + '\n' + original.asset + '\n保留底仓数量 ' + current.coreQty, { intervalMs: 60000 });
      } catch (e) { await this.reportError('hold:' + id, e); }
    }
  }
  async refunds() {
    const records = Object.values(this.store.snapshot().reservations);
    for (const t of this.cfg.templates.filter(t => !t.kind.startsWith('free-'))) for (const wallet of this.cfg.wallets) {
      if (!records.some(r => r.wallet === wallet.address && r.project === t.asset && r.action === 'mint' && r.status === 'confirmed')) continue;
      const c = this.store.snapshot().scan.candidates[t.contract], context = c ? this.scanner.context(c) : {};
      const s = await this.planner.snapshot(t, wallet, context);
      if (s.refund && s.refund.deadline - Date.now() < 86400000) await this.notifier.send('refund-deadline:' + t.contract + ':' + wallet.address, '请复核退款期限及资格：' + t.contract + '\n审核模板中的截止时间：' + new Date(s.refund.deadline).toISOString() + '\n本版本不自动申请退款。', { intervalMs: 6 * 3600000 });
      if (!s.refund?.covered || s.identity !== s.expectedIdentity || !s.invariantsOk) await this.notifier.send('refund-risk:' + t.contract, '退款资金覆盖或合约审核状态变化，请人工复核：' + t.contract);
    }
  }
  start() {
    const schedule = (name, fn, interval) => {
      const run = () => {
        if (this.stopped || this.running.has(name)) return;
        const task = Promise.resolve().then(fn).catch(e => this.reportError(name, e));
        this.running.set(name, task); task.finally(() => this.running.delete(name)).catch(() => {});
      };
      run(); this.timers.push(setInterval(run, interval));
    };
    schedule('scan', () => this.scan(), this.cfg.scan.pollMs);
    schedule('entry', () => this.entries(), Math.min(this.cfg.scan.hotMs, 5000));
    schedule('approval-cleanup', () => this.cleanups(), 15000);
    schedule('market', () => this.marketWatch(), 15000);
    schedule('holdings', () => this.holdings(), 5000);
    schedule('receipts', () => this.executor.reconcile(), 5000);
    schedule('refunds', () => this.refunds(), 60000);
  }
  async stop() { this.stopped = true; for (const t of this.timers) clearInterval(t); await Promise.allSettled([...this.running.values()]); }
}
