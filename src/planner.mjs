import { BSC } from './rpc.mjs';
import { selector, addrWord, word, uint, APPROVE, ALLOWANCE, encodeSwap } from './abi.mjs';
import { units, WAD, bnbToUsd, usdToBnb, bp, max } from './money.mjs';
import { entryGate } from './guard.mjs';
export class Planner {
  constructor(rpc, cfg, clock = Date.now) { this.rpc = rpc; this.cfg = cfg; this.clock = clock; }
  async snapshot(template, wallet, candidate = {}) {
    const now = this.clock(), head = await this.rpc.head(), block = '0x' + head.toString(16);
    const [identity, assetIdentity, balance, price] = await Promise.all([
      this.rpc.identity(template.contract, block), this.rpc.identity(template.asset, block), this.rpc.balance(wallet.address, BSC.native, block), this.rpc.bnbPrice(block)
    ]);
    let progressBps = null;
    if (template.progress) {
      try {
        const [sold, cap] = await Promise.all([template.progress.soldSelector, template.progress.capSelector].map(s => this.rpc.call(template.contract, s, block).then(uint)));
        if (cap > 0n && sold <= cap) progressBps = Number(sold * 10000n / cap);
        // A malformed counter is unknown, never clamped to a fabricated 100%.
      } catch {}
    }
    let invariantsOk = true;
    for (const test of template.invariants || []) {
      try { if ((await this.rpc.call(test.to || template.contract, test.data, block)).toLowerCase() !== test.expected.toLowerCase()) invariantsOk = false; } catch { invariantsOk = false; }
    }
    const native = template.kind === 'bnb-fixed' ? units(template.maxPayment) : 0n, usdt = template.kind === 'usdt-fixed' ? units(template.maxPayment) : 0n;
    let refund = null;
    if (native > 0n || usdt > 0n) {
      try {
        const [liability, deadline, escrow] = await Promise.all([
          this.rpc.call(template.contract, template.refund.liabilitySelector, block).then(uint),
          this.rpc.call(template.contract, template.refund.deadlineSelector, block).then(uint),
          this.rpc.balance(template.refund.escrow, usdt > 0n ? BSC.usdt : BSC.native, block)
        ]);
        refund = { reviewed: template.refund.reviewed === true, covered: escrow >= liability, deadline: Number(deadline) * 1000, termsCurrent: invariantsOk && identity.fingerprint === template.identity };
      } catch {}
    }
    let poolOpen = null;
    try {
      const factory = '0xca143ce32fe78f1f7019d7d551a6402fc5350c73';
      const pairs = await Promise.all([BSC.wbnb, BSC.usdt].filter(t => t !== template.asset).map(async quote => {
        const raw = await this.rpc.call(factory, selector('getPair(address,address)') + addrWord(template.asset) + addrWord(quote), block);
        if (uint(raw) === 0n) return false;
        const r = await this.rpc.call('0x' + raw.slice(-40), selector('getReserves()'), block);
        return uint(r) > 0n && BigInt('0x' + r.slice(66, 130)) > 0n;
      }));
      poolOpen = pairs.some(Boolean);
      // v0.1 only has a verified V2 pool adapter. An explicit local review must
      // confirm the launch is not on V3/Infinity/another DEX before auto-entry.
      if (!poolOpen && template.poolReview?.noOtherDex !== true) poolOpen = null;
    } catch {}
    return {
      wallet: wallet.address, chainId: 56, target: template.contract, asset: template.asset, assetType: template.assetType,
      identity: identity.fingerprint, expectedIdentity: template.identity, assetIdentity: assetIdentity.fingerprint, expectedAssetIdentity: template.assetIdentity,
      reviewed: Boolean(template.review?.note), reviewExpiresAt: Date.parse(template.review.expiresAt), invariantsOk,
      allowedData: template.calldata, mintSelector: template.calldata.slice(0, 10), nativeValueWei: String(native), usdtValueWei: String(usdt),
      balanceWei: String(balance), bnbPrice: String(price), priceAgeMs: this.clock() - now,
      progressBps, agentCount: candidate.agentCount || 0, burstCount: candidate.burstCount || 0,
      heatTier: candidate.heatTier || 0, allowPaidHeatFallback: template.allowPaidHeatFallback === true,
      deployer: candidate.deployer, malicious: false, poolOpen, refund, blockNumber: head
    };
  }
  async gas(plan) {
    const [limit, price] = await Promise.all([
      this.rpc.request('eth_estimateGas', [{ from: plan.wallet, to: plan.target, value: '0x' + BigInt(plan.valueWei).toString(16), data: plan.data }]),
      this.rpc.request('eth_gasPrice')
    ]);
    return BigInt(limit) * BigInt(price) * 150n / 100n;
  }
  async mintPlan(template, wallet, candidate, preparedSnapshot = null) {
    const s = preparedSnapshot || await this.snapshot(template, wallet, candidate); entryGate(s, this.cfg, this.clock());
    if (template.kind === 'usdt-fixed') {
      const need = BigInt(s.usdtValueWei), balance = await this.rpc.balance(wallet.address, BSC.usdt);
      if (balance < need) throw new Error('USDT insufficient; automatic BNB conversion is disabled in this beta');
      const allowance = uint(await this.rpc.call(BSC.usdt, ALLOWANCE + addrWord(wallet.address) + addrWord(template.contract)));
      if (allowance < need) return { snapshot: s, plan: await this.approval(wallet.address, BSC.usdt, template.contract, need, s, template.asset) };
      if (allowance > need) throw new Error('Existing approval is broader than this mint; revoke it before buying');
    }
    const native = BigInt(s.nativeValueWei), usdt = BigInt(s.usdtValueWei);
    const principalUsd = bnbToUsd(native, s.bnbPrice) + usdt / (10n ** 12n);
    const plan = {
      chainId: 56, action: 'mint', wallet: wallet.address, target: template.contract, project: template.asset,
      asset: template.asset, assetType: template.assetType, data: template.calldata, valueWei: String(native), identity: s.identity, assetIdentity: s.assetIdentity,
      minAssetQty: template.minAssetQty || '1', costBnbWei: String(native + usdToBnb(usdt / (10n ** 12n), s.bnbPrice)), costUsdMicro: String(principalUsd),
      pricingBnbPrice: s.bnbPrice, createdAt: this.clock(),
      maxDebits: { ...(native > 0n ? { [BSC.native]: String(native) } : {}), ...(usdt > 0n ? { [BSC.usdt]: String(usdt) } : {}) }
    };
    plan.gasWei = String(await this.gas(plan));
    return { plan, snapshot: s };
  }
  async approval(wallet, token, spender, amount, snapshot, project) {
    const plan = { chainId: 56, action: amount === 0n ? 'revoke' : 'approve', wallet, target: token, token, spender, approvalAmount: String(amount), project,
      data: APPROVE + addrWord(spender) + word(amount), valueWei: '0', costBnbWei: '0', costUsdMicro: '0', maxDebits: {} };
    plan.gasWei = String(await this.gas(plan)); return plan;
  }
  async revokeSnapshot(wallet, token) {
    const [id, balance, price] = await Promise.all([this.rpc.identity(token), this.rpc.balance(wallet.address), this.rpc.bnbPrice()]);
    return { wallet: wallet.address, target: token, asset: token, identity: id.fingerprint, expectedIdentity: id.fingerprint, assetIdentity: id.fingerprint, expectedAssetIdentity: id.fingerprint, invariantsOk: true, reviewed: true, reviewExpiresAt: this.clock() + 15000, balanceWei: String(balance), bnbPrice: String(price) };
  }
  async sale(positionId, position, decision, wallet, blockInfo) {
    const token = position.asset, now = this.clock(), qty = BigInt(decision.qty);
    const tokenIdentity = await this.rpc.identity(token);
    if (!position.assetIdentity || tokenIdentity.fingerprint !== position.assetIdentity) throw new Error('Token code changed or lacks a reviewed identity; exit requires manual review');
    const [balance, tokenBalance] = await Promise.all([this.rpc.balance(wallet.address), this.rpc.balance(wallet.address, token)]);
    if (tokenBalance !== BigInt(position.qty)) throw new Error('Position balance differs; reconcile manual transfers first');
    const q = await this.rpc.saleQuote(token, qty, BigInt(position.originalQty), blockInfo);
    if (q.priceImpactBps > this.cfg.sales.maxPriceImpactBps) throw new Error('Sale price impact exceeds configured cap; manual smaller chunks required');
    const allowance = uint(await this.rpc.call(token, ALLOWANCE + addrWord(wallet.address) + addrWord(BSC.router)));
    const snapshot = { wallet: wallet.address, identity: tokenIdentity.fingerprint, expectedIdentity: tokenIdentity.fingerprint, assetIdentity: tokenIdentity.fingerprint, expectedAssetIdentity: tokenIdentity.fingerprint, invariantsOk: true,
      reviewed: true, reviewExpiresAt: now + 15000, balanceWei: String(balance), bnbPrice: q.bnbPrice,
      target: token, asset: token, assetType: 'ERC20', allowedSpender: BSC.router, exitApproval: true, allowedQty: String(qty),
      allowedMinOutWei: String(bp(BigInt(q.outWei), 10000 - this.cfg.sales.slippageBps)) };
    if (allowance < qty) {
      const plan = await this.approval(wallet.address, token, BSC.router, qty, snapshot, token);
      Object.assign(plan, { exitApproval: true, positionId, includesCore: decision.includesCore, saleIntent: structuredClone(decision) }); return { snapshot, plan };
    }
    if (allowance > qty) throw new Error('Sale approval is broader than the planned sale; revoke first');
    const minOut = bp(BigInt(q.outWei), 10000 - this.cfg.sales.slippageBps), deadline = Math.floor(now / 1000) + 60;
    const plan = {
      chainId: 56, action: 'sell', wallet: wallet.address, target: BSC.router, project: token, asset: token, positionId, qty: String(qty),
      data: encodeSwap('swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)', qty, minOut, q.path, wallet.address, deadline),
      path: q.path, deadline, minOutWei: String(minOut), valueWei: '0', costBnbWei: '0', costUsdMicro: '0',
      maxDebits: { [token]: String(qty) }, includesCore: decision.includesCore, multiple: decision.multiple || null,
      balanceBeforeWei: String(balance), identity: tokenIdentity.fingerprint, assetIdentity: tokenIdentity.fingerprint
    };
    plan.gasWei = String(await this.gas(plan));
    if (decision.minNetUsdMicro && bnbToUsd(minOut, q.bnbPrice) - bnbToUsd(plan.gasWei, q.bnbPrice) < BigInt(decision.minNetUsdMicro)) throw new Error('Quoted sale cannot cover net outstanding cost; rebuild a larger recovery plan');
    return { plan, snapshot };
  }
}
