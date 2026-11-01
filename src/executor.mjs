import { createHash, randomUUID } from 'node:crypto';
import { Ledger } from './ledger.mjs';
import { WalletQueue } from './store.mjs';
import { entryGate, simulationGate, gasGate, planGate } from './guard.mjs';
import { bnbToUsd, usdToBnb, dayKey, max } from './money.mjs';
import { applySale, openPosition } from './positions.mjs';
import { TRANSFER, ZERO_TOPIC, topicAddress } from './abi.mjs';
import { BSC } from './rpc.mjs';
import { validateEnvelope } from './baw.mjs';
function planHash(plan) { return createHash('sha256').update(JSON.stringify(plan)).digest('hex'); }
export class Executor {
  constructor(store, cfg, { rpc, walletFor, clock = Date.now, liveArmed = false } = {}) {
    this.store = store; this.cfg = cfg; this.rpc = rpc; this.walletFor = walletFor; this.clock = clock; this.ledger = new Ledger(store, cfg, clock); this.queue = new WalletQueue(); this.liveArmed = liveArmed;
  }
  async submit(plan, snapshot, recheck) {
    return this.queue.run(plan.wallet, async () => {
      const now = this.clock();
      if (this.cfg.blockedContracts.includes(plan.target) || (plan.spender && this.cfg.blockedContracts.includes(plan.spender))) throw new Error('Interaction target or spender is on the denylist');
      planGate(plan, snapshot, now);
      if (plan.action === 'mint' && plan.pricingBnbPrice && plan.pricingBnbPrice !== snapshot.bnbPrice) throw new Error('Mint pricing is not bound to the initial snapshot');
      if (plan.action === 'mint' || (plan.action === 'approve' && !snapshot.exitApproval)) entryGate(snapshot, this.cfg, now);
      if (!['mint', 'approve', 'revoke', 'sell'].includes(plan.action) || plan.chainId !== 56 || plan.wallet !== snapshot.wallet) throw new Error('Unrecognized transaction plan');
      if (plan.action === 'approve' && (!snapshot.reviewed || snapshot.identity !== snapshot.expectedIdentity || now >= snapshot.reviewExpiresAt)) throw new Error('Approval requires a current reviewed target');
      gasGate(BigInt(plan.gasWei), BigInt(snapshot.balanceWei), this.cfg, !['sell', 'revoke'].includes(plan.action) && !plan.exitApproval);
      const wallet = this.walletFor(plan.wallet), bound = planHash(plan), preview = await wallet.preview(plan);
      simulationGate(preview.sim, plan);
      if (planHash(plan) !== bound) throw new Error('Plan changed during preview');
      const fresh = await recheck();
      planGate(plan, fresh, this.clock());
      if (plan.action === 'mint' || (plan.action === 'approve' && !snapshot.exitApproval)) entryGate(fresh, this.cfg, this.clock());
      if (fresh.identity !== snapshot.identity || fresh.assetIdentity !== snapshot.assetIdentity || !fresh.invariantsOk || planHash(plan) !== bound) throw new Error('Contract or plan changed after preview');
      const priceDelta = BigInt(fresh.bnbPrice) - BigInt(snapshot.bnbPrice);
      if ((priceDelta < 0n ? -priceDelta : priceDelta) * 10000n > BigInt(snapshot.bnbPrice) * BigInt(this.cfg.sales.maxRepriceBps) || fresh.balanceWei !== snapshot.balanceWei) throw new Error('Balance or price changed; rebuild the plan');
      if (plan.createdAt != null && this.clock() - plan.createdAt > this.cfg.sales.quoteMaxAgeSeconds * 1000) throw new Error('Prepared plan is stale');
      const id = randomUUID();
      const freshUsd = plan.action === 'mint' ? bnbToUsd(fresh.nativeValueWei, fresh.bnbPrice) + BigInt(fresh.usdtValueWei) / (10n ** 12n) : 0n;
      const freshBnb = plan.action === 'mint' ? BigInt(fresh.nativeValueWei) + usdToBnb(BigInt(fresh.usdtValueWei) / (10n ** 12n), fresh.bnbPrice) : 0n;
      const order = { id, wallet: plan.wallet, project: plan.project, action: plan.action, exitApproval: plan.exitApproval === true, bnbWei: String(max(BigInt(plan.costBnbWei), freshBnb)), nativeValueWei: plan.valueWei, gasWei: plan.gasWei, usdMicro: String(max(BigInt(plan.costUsdMicro), freshUsd) + bnbToUsd(plan.gasWei, fresh.bnbPrice)), freeMint: plan.action === 'mint' && snapshot.nativeValueWei === '0' && snapshot.usdtValueWei === '0', balanceWei: fresh.balanceWei, plan: structuredClone(plan) };
      if (this.cfg.mode !== 'live') {
        await this.ledger.preview(order);
        await this.store.event('shadow-plan', { action: plan.action, project: plan.project, target: plan.target, wallet: plan.wallet, planHash: bound }, now);
        return { status: 'shadow', planHash: bound };
      }
      if (!this.liveArmed) throw new Error('Live mode also requires the explicit --execute startup flag');
      validateEnvelope(preview.envelope, plan);
      // Persist before any possible broadcast. An interrupted request remains blocking across restarts.
      await this.ledger.reserve(order);
      if (plan.exitApproval) await this.store.transaction(s => {
        const p = s.positions[plan.positionId]; if (!p || p.pendingSale) throw new Error('Exit approval position is unavailable');
        p.preparedSale = structuredClone(plan.saleIntent);
      });
      if (plan.action === 'sell') {
        try { await this.store.transaction(s => { const p = s.positions[plan.positionId]; if (!p || p.pendingSale) throw new Error('Position already has a pending sale'); const available = BigInt(plan.includesCore ? p.qty : p.tradeQty); if (BigInt(plan.qty) > available) throw new Error('Sale would consume protected core'); p.pendingSale = id; }); }
        catch (e) { await this.ledger.release(id, e.message); throw e; }
      }
      await this.ledger.transition(id, 'broadcasting', { requestId: preview.requestId });
      try {
        const txHash = await wallet.broadcast(preview.requestId);
        await this.ledger.transition(id, 'pending', { txHash }); return { status: 'pending', id, txHash };
      } catch (e) {
        await this.ledger.transition(id, 'unknown', { reason: 'Broadcast outcome unknown; no automatic replacement' });
        throw e;
      }
    });
  }
  async reconcile() {
    for (const r of Object.values(this.store.snapshot().reservations)) {
      if (!['pending', 'unknown', 'broadcasting'].includes(r.status) || !r.txHash) continue;
      const receipt = await this.rpc.request('eth_getTransactionReceipt', [r.txHash]); if (!receipt) continue;
      const head = await this.rpc.head(), block = Number(BigInt(receipt.blockNumber));
      if (head - block + 1 < this.cfg.scan.confirmations) continue;
      const b = await this.rpc.block(block); if (!b || b.hash !== receipt.blockHash) continue;
      const tx = await this.rpc.request('eth_getTransactionByHash', [r.txHash]); if (!tx) continue;
      const p = r.plan;
      if (tx.from.toLowerCase() !== r.wallet || tx.to?.toLowerCase() !== p.target || tx.input?.toLowerCase() !== p.data.toLowerCase() || BigInt(tx.value) !== BigInt(p.valueWei)) throw new Error('Receipt transaction does not match the reserved plan');
      const gas = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
      const price = await this.rpc.bnbPrice(receipt.blockNumber), gasUsd = bnbToUsd(gas, price);
      let received = 0n, sent = 0n;
      for (const l of receipt.logs || []) {
        if (l.topics?.[0] !== TRANSFER || l.address.toLowerCase() !== p.asset || l.topics.length !== 3) continue;
        const n = BigInt(l.data); if (topicAddress(l.topics[2]) === r.wallet) received += n; if (topicAddress(l.topics[1]) === r.wallet) sent += n;
      }
      const succeeded = receipt.status === '0x1';
      let proceeds = 0n;
      if (succeeded && p.action === 'sell') {
        // Exact transaction net received is taken from the simulated bound router's WBNB Withdrawal event.
        // It is additionally bounded against minOut; missing event means manual reconciliation, not a guessed wallet delta.
        const withdrawal = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';
        for (const l of receipt.logs || []) if (l.address.toLowerCase() === BSC.wbnb && l.topics?.[0] === withdrawal && l.topics[1]?.slice(-40).toLowerCase() === BSC.router.slice(2)) proceeds += BigInt(l.data);
        if (proceeds < BigInt(p.minOutWei) || sent <= 0n || sent > BigInt(p.qty)) throw new Error('Unverified sale receipt; keep transaction and position locked for manual review');
      }
      if (p.assetType === 'ERC721') for (const l of receipt.logs || []) {
        if (l.address.toLowerCase() !== p.asset || l.topics?.[0] !== TRANSFER || l.topics.length !== 4) continue;
        if (topicAddress(l.topics[2]) === r.wallet) received++; if (topicAddress(l.topics[1]) === r.wallet) sent++;
      }
      if (p.action === 'mint') received -= sent;
      if (succeeded && p.action === 'mint' && received < BigInt(p.minAssetQty || '1')) throw new Error('Confirmed transaction did not deliver the expected asset');
      let principalUsd = 0n, principalBnb = 0n;
      if (succeeded && p.action === 'mint') {
        let usdtNet = 0n;
        for (const l of receipt.logs || []) if (l.address.toLowerCase() === BSC.usdt && l.topics?.[0] === TRANSFER && l.topics.length === 3) {
          if (topicAddress(l.topics[1]) === r.wallet) usdtNet += BigInt(l.data);
          if (topicAddress(l.topics[2]) === r.wallet) usdtNet -= BigInt(l.data);
        }
        if (usdtNet < 0n) usdtNet = 0n;
        if (usdtNet > BigInt(p.maxDebits[BSC.usdt] || '0')) throw new Error('Confirmed USDT debit exceeded the bound plan; stop for review');
        principalUsd = bnbToUsd(BigInt(tx.value), price) + usdtNet / (10n ** 12n);
        principalBnb = BigInt(tx.value) + usdToBnb(usdtNet / (10n ** 12n), price);
      }
      const at = Number(BigInt(b.timestamp)) * 1000;
      await this.store.transaction(s => {
        const current = s.reservations[r.id]; if (!current || !['pending', 'unknown', 'broadcasting'].includes(current.status)) return;
        current.status = succeeded ? 'confirmed' : 'failed'; current.confirmedAt = at; current.day = dayKey(at);
        current.actualBnbWei = String(gas + principalBnb);
        current.actualUsdMicro = String(gasUsd + principalUsd); current.gasWeiActual = String(gas);
        if (p.action === 'sell') {
          const position = s.positions[p.positionId]; if (!position || position.pendingSale !== r.id) throw new Error('Sale position journal mismatch');
          if (succeeded) applySale(position, { qty: String(sent), proceedsUsdMicro: String(proceeds * price / (10n ** 18n)), gasUsdMicro: String(gasUsd), includesCore: p.includesCore, multiple: p.multiple, complete: sent === BigInt(p.qty) }, this.cfg, at);
          else { position.pendingSale = null; position.costUsdMicro = String(BigInt(position.costUsdMicro) + gasUsd); position.sellFailures = (position.sellFailures || 0) + 1; }
          delete position.preparedSale;
        }
        if (p.positionId && ['approve', 'revoke'].includes(p.action) && s.positions[p.positionId]) {
          s.positions[p.positionId].costUsdMicro = String(BigInt(s.positions[p.positionId].costUsdMicro) + gasUsd);
          if (p.action === 'revoke' && succeeded) delete s.positions[p.positionId].preparedSale;
        }
        if (succeeded && p.action === 'mint' && p.assetType === 'ERC20') {
          const key = r.wallet + ':' + p.asset;
          if (s.positions[key]) { s.positions[key].needsReview = true; s.positions[key].extraReceipt = String(received); }
          else {
            const approvalFees = Object.values(s.reservations).filter(x => x.wallet === r.wallet && x.project === r.project && x.action === 'approve' && !x.exitApproval && x.status === 'confirmed' && !x.assignedPosition);
            const cost = BigInt(current.actualUsdMicro) + approvalFees.reduce((a, x) => a + BigInt(x.actualUsdMicro), 0n);
            s.positions[key] = openPosition({ wallet: r.wallet, asset: p.asset, qty: String(received), costUsdMicro: String(cost), free: r.freeMint, now: at, identity: p.identity, source: p.target }, this.cfg);
            s.positions[key].assetIdentity = p.assetIdentity;
            for (const x of approvalFees) x.assignedPosition = key;
          }
        }
        s.events.push({ type: 'receipt', at, intent: r.id, action: p.action, status: current.status, txHash: r.txHash, gasWei: String(gas) });
      });
    }
  }
}
