import { WAD, BPS, bp, ceilDiv, max, min, units } from './money.mjs';
export function openPosition({ wallet, asset, qty, costUsdMicro = '0', symbol = '', now = Date.now(), free = false, identity = null, source = null }, c) {
  qty = BigInt(qty); if (qty <= 0n) throw new Error('A confirmed positive token quantity is required');
  const cost = BigInt(costUsdMicro); if ((!free && cost <= 0n) || cost < 0n) throw new Error('Confirmed cost required');
  const core = free ? bp(qty, c.sales.freeCoreBps) : 0n;
  return { wallet, asset, symbol: String(symbol).replace(/[\u0000-\u001f]/g, '').slice(0, 64), originalQty: String(qty), qty: String(qty), coreQty: String(core), tradeQty: String(qty - core), entryCostUsdMicro: String(cost), costUsdMicro: String(cost), realizedUsdMicro: '0', free, coreLocked: free, coreSince: null, openedAt: now, marketOpenedAt: null, peak: '0', lastSample: null, dropCount: 0, earlyCount: 0, lastQuoteAt: null, steps: [], reminders: [], pendingSale: null, identity, source, hold: false };
}
export function observePosition(p, q, c, now = Date.now()) {
  if (!q || !q.sampleId || !Number.isSafeInteger(q.blockNumber) || !Number.isFinite(q.at) || q.at > now + 1000 || now - q.at > c.sales.quoteMaxAgeSeconds * 1000 || BigInt(q.unitPrice || '0') <= 0n) return false;
  if (p.lastSample === q.sampleId || (p.lastBlock != null && q.blockNumber <= p.lastBlock)) return false;
  if (p.lastQuoteAt != null && now - p.lastQuoteAt > c.sales.confirmMaxGapSeconds * 1000) { p.dropCount = 0; p.earlyCount = 0; }
  p.lastSample = q.sampleId; p.lastBlock = q.blockNumber; p.lastQuoteAt = q.at;
  p.marketOpenedAt ??= now;
  if (p.coreLocked) p.coreSince ??= now;
  const price = BigInt(q.unitPrice), peak = BigInt(p.peak);
  const abnormalJump = peak === 0n || price * BPS > peak * BigInt(10000 + c.sales.maxPeakJumpBps);
  if (price > peak && abnormalJump) {
    const pending = p.peakCandidate;
    if (pending && now - pending.at <= c.sales.confirmMaxGapSeconds * 1000 && price * 100n >= BigInt(pending.price) * 90n) {
      p.peak = String(price); delete p.peakCandidate;
    } else p.peakCandidate = { price: String(price), at: now };
  } else if (price > peak) { p.peak = String(price); delete p.peakCandidate; }
  if (!p.free && BigInt(p.peak) === 0n) p.peak = String(BigInt(p.entryCostUsdMicro) * WAD / BigInt(p.originalQty));
  const crash = p.free ? c.sales.freeCrashBps : now - p.marketOpenedAt < c.sales.fastSeconds * 1000 ? c.sales.fastPaidCrashBps : c.sales.paidCrashBps;
  p.dropCount = BigInt(p.peak) > 0n && price * BPS <= BigInt(p.peak) * BigInt(10000 - crash) ? p.dropCount + 1 : 0;
  p.earlyCount = price * BPS <= BigInt(p.peak) * BigInt(10000 - c.sales.earlyDropBps) ? p.earlyCount + 1 : 0;
  return true;
}
export function coreReminders(p, now = Date.now()) {
  if (!p.coreLocked || !p.coreSince || BigInt(p.coreQty) <= 0n) return [];
  const out = []; for (const h of [24, 48]) if (now - p.coreSince >= h * 3600000 && !p.reminders.includes(h)) { p.reminders.push(h); out.push(h); }
  return out;
}
export function saleDecision(p, q, c, { now = Date.now(), emergency = false, manualAll = false, exitGasUsdMicro = '0' } = {}) {
  const qty = BigInt(p.qty), trade = BigInt(p.tradeQty), gas = BigInt(exitGasUsdMicro);
  if (qty <= 0n || p.pendingSale || (p.sellFailures || 0) >= c.limits.maxFailures) return null;
  if (emergency || manualAll) { p.exitIntent = emergency ? 'emergency' : 'manual-all'; return { kind: p.exitIntent, qty: String(qty), includesCore: true }; }
  if (p.hold || p.needsReview || !q || !p.lastSample || p.lastSample !== q.sampleId || now - q.at > c.sales.quoteMaxAgeSeconds * 1000 || q.at > now + 1000 || trade <= 0n) return null;
  if (BigInt(q.usdMicro || '0') < units(c.sales.dustUsd, 6)) return null;
  if (p.exitIntent) return { kind: p.exitIntent, qty: String(trade), includesCore: false };
  if (p.dropCount >= 2) { p.exitIntent = 'trailing-exit'; return { kind: 'trailing-exit', qty: String(trade), includesCore: false }; }
  if (p.free) return null;
  const remainingCost = max(0n, BigInt(p.costUsdMicro) - BigInt(p.realizedUsdMicro));
  const fullValue = BigInt(q.unitPrice) * BigInt(p.originalQty) / WAD;
  if (!p.coreLocked && remainingCost > 0n) {
    const quoteAvailable = BigInt(q.usdMicro), early = p.earlyCount >= 2 && (quoteAvailable - gas) * BPS >= remainingCost * BigInt(c.sales.earlyCoverBps);
    if (fullValue >= BigInt(p.entryCostUsdMicro) * BigInt(c.sales.backX) || early) {
      const needed = remainingCost + gas, amount = min(trade, ceilDiv(trade * needed * 103n, max(quoteAvailable, 1n) * 100n));
      return { kind: 'recover', qty: String(amount), minNetUsdMicro: String(remainingCost), includesCore: false };
    }
  }
  if (!p.coreLocked) return null;
  for (const [multiple, bps] of c.sales.steps) if (!p.steps.includes(multiple) && fullValue >= BigInt(p.entryCostUsdMicro) * BigInt(multiple)) {
    p.stepPlans ||= {};
    p.stepPlans[multiple] ||= { qty: String(bp(trade, bps)), filled: '0' };
    const amount = min(trade, BigInt(p.stepPlans[multiple].qty) - BigInt(p.stepPlans[multiple].filled));
    if (amount > 0n) return { kind: 'step', multiple, qty: String(amount), includesCore: false };
  }
  return null;
}
export function applySale(p, fill, c, now = Date.now()) {
  const amount = BigInt(fill.qty), current = BigInt(p.qty);
  if (amount <= 0n || amount > current) throw new Error('Invalid sale fill quantity');
  const coreBefore = BigInt(p.coreQty), tradeBefore = BigInt(p.tradeQty), includesCore = fill.includesCore === true;
  if (!includesCore && amount > tradeBefore) throw new Error('Sale would consume protected core');
  const fromTrade = min(tradeBefore, amount); p.tradeQty = String(tradeBefore - fromTrade);
  p.coreQty = String(coreBefore - (amount - fromTrade)); p.qty = String(current - amount);
  p.costUsdMicro = String(BigInt(p.costUsdMicro) + BigInt(fill.gasUsdMicro || '0'));
  p.realizedUsdMicro = String(BigInt(p.realizedUsdMicro) + BigInt(fill.proceedsUsdMicro));
  if (!p.free && !p.coreLocked && BigInt(p.realizedUsdMicro) >= BigInt(p.costUsdMicro)) {
    p.coreQty = String(bp(BigInt(p.qty), c.sales.paidCoreBps)); p.tradeQty = String(BigInt(p.qty) - BigInt(p.coreQty));
    p.coreLocked = true; p.coreSince = now;
  }
  if (fill.multiple) {
    const stage = p.stepPlans?.[fill.multiple]; if (!stage) throw new Error('Missing persistent sale-stage target');
    stage.filled = String(BigInt(stage.filled) + amount);
    if (BigInt(stage.filled) >= BigInt(stage.qty) && !p.steps.includes(fill.multiple)) p.steps.push(fill.multiple);
  }
  p.pendingSale = null; p.dropCount = 0; p.earlyCount = 0;
  p.closedAt = BigInt(p.qty) === 0n ? now : null;
  if (BigInt(p.tradeQty) === 0n && p.exitIntent === 'trailing-exit') delete p.exitIntent;
}
export function reconcileExternalBalance(p, actual) {
  actual = BigInt(actual);
  if (actual !== BigInt(p.qty)) { p.needsReview = true; p.observedBalance = String(actual); return false; }
  return true;
}
