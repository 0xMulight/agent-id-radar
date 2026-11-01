import { Rpc, BSC } from './rpc.mjs';
import { Scanner } from './scanner.mjs';
import { Planner } from './planner.mjs';
import { Executor } from './executor.mjs';
import { BawWallet } from './baw.mjs';
import { Notifier } from './notifier.mjs';
import { observePosition, saleDecision, coreReminders, reconcileExternalBalance } from './positions.mjs';
import { ALLOWANCE, addrWord, uint } from './abi.mjs';
export class Runtime {
  constructor(cfg, store, { rpc = null, walletFor = null, liveArmed = false, logger = console.log } = {}) {
    this.cfg = cfg; this.store = store; this.rpc = rpc || new Rpc(cfg.rpcs, cfg.scan.rpcTimeoutMs); this.logger = logger;
    this.scanner = new Scanner(this.rpc, store, cfg); this.planner = new Planner(this.rpc, cfg);
    const wallets = new Map(cfg.wallets.map(w => [w.address, new BawWallet(w, { live: cfg.mode === 'live' && liveArmed })]));
    this.executor = new Executor(store, cfg, { rpc: this.rpc, walletFor: walletFor || (a => { if (!wallets.has(a)) throw new Error('Wallet not configured'); return wallets.get(a); }), liveArmed });
    this.notifier = new Notifier(cfg, store, fetch, logger); this.nextEntry = new Map(); this.timers = []; this.stopped = false; this.running = new Map();
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
        await this.notifier.send('candidate:' + c.contract, '候选项目 ' + c.contract + '\n已验证 Agent ID 地址 ' + c.agentCount + '；近期参与地址 ' + c.burstCount + '\n缺少本地审核模板，只观察，不自动付款。', { intervalMs: 86400000 });
      }
    }
  }
  async cleanupApproval(t, wallet, candidate, force = false) {
    if (t.kind !== 'usdt-fixed') return false;
    const records = Object.values(this.store.snapshot().reservations);
    const finished = records.some(r => r.wallet === wallet.address && r.project === t.asset && r.action === 'mint' && ['confirmed', 'failed'].includes(r.status));
    const granted = records.filter(r => r.wallet === wallet.address && r.project === t.asset && r.action === 'approve' && !r.exitApproval && r.status === 'confirmed').at(-1);
    if ((!finished && !(granted && (force || Date.now() - granted.confirmedAt > 60000))) || records.some(r => r.wallet === wallet.address && ['reserved', 'broadcasting', 'pending', 'unknown'].includes(r.status))) return false;
    if (records.filter(r => r.wallet === wallet.address && r.project === t.asset && r.action === 'revoke' && r.status === 'failed').length >= this.cfg.limits.maxFailures) return true;
    const allowance = uint(await this.rpc.call(BSC.usdt, ALLOWANCE + addrWord(wallet.address) + addrWord(t.contract)));
    if (allowance === 0n) return false;
    const snapshot = await this.planner.revokeSnapshot(wallet, BSC.usdt);
    const plan = await this.planner.approval(wallet.address, BSC.usdt, t.contract, 0n, snapshot, t.asset);
    if (this.store.snapshot().positions[wallet.address + ':' + t.asset]) plan.positionId = wallet.address + ':' + t.asset;
    await this.executor.submit(plan, snapshot, () => this.planner.revokeSnapshot(wallet, BSC.usdt)); return true;
  }
  async entries() {
    const candidates = this.store.snapshot().scan.candidates, now = Date.now();
    for (const t of this.cfg.templates) {
      if ((this.nextEntry.get(t.contract) || 0) > now) continue;
      const candidate = candidates[t.contract] ? this.scanner.context(candidates[t.contract]) : { agentCount: 0, burstCount: 0, heatTier: 0 };
      this.nextEntry.set(t.contract, now + (candidate.heatTier >= 1 ? this.cfg.scan.hotMs : this.cfg.scan.normalMs));
      for (const wallet of this.cfg.wallets) {
        const records = Object.values(this.store.snapshot().reservations);
        if (records.some(r => r.wallet === wallet.address && ['reserved', 'broadcasting', 'pending', 'unknown'].includes(r.status))) continue;
        try {
          if (await this.cleanupApproval(t, wallet, candidate)) continue;
          if (records.some(r => r.wallet === wallet.address && r.project === t.asset && r.action === 'mint' && r.status === 'confirmed')) continue;
          const snapshot = await this.planner.snapshot(t, wallet, candidate);
          if (snapshot.progressBps !== null && snapshot.progressBps >= this.cfg.entry.progressBps - 200) this.nextEntry.set(t.contract, now + this.cfg.scan.hotMs);
          const { plan } = await this.planner.mintPlan(t, wallet, candidate, snapshot);
          const result = await this.executor.submit(plan, snapshot, () => this.planner.snapshot(t, wallet, candidate));
          await this.notifier.send('entry:' + t.contract + ':' + wallet.address + ':' + result.status, '参与计划 ' + result.status + '\n' + t.contract + '\n钱包 ' + wallet.address, { intervalMs: 60000 });
        } catch (e) {
          await this.reportError('entry:' + t.contract, e);
          try { await this.cleanupApproval(t, wallet, candidate, true); } catch (cleanup) { await this.reportError('approval-cleanup:' + t.contract, cleanup); }
        }
      }
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
    schedule('holdings', () => this.holdings(), 5000);
    schedule('receipts', () => this.executor.reconcile(), 5000);
    schedule('refunds', () => this.refunds(), 60000);
  }
  async stop() { this.stopped = true; for (const t of this.timers) clearInterval(t); await Promise.allSettled([...this.running.values()]); }
}
