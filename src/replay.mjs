import { config } from './config.mjs';
import { units, WAD, bp, format } from './money.mjs';
import { openPosition, observePosition, saleDecision, applySale, coreReminders } from './positions.mjs';
export function replay(tape, cfg = config()) {
  if (!Array.isArray(tape.scenarios)) throw new Error('Replay requires scenarios');
  return tape.scenarios.map((scenario) => {
    const start = Date.parse('2026-11-01T00:00:00Z');
    const p = openPosition({ wallet: '0x' + '1'.repeat(40), asset: '0x' + '2'.repeat(40), qty: scenario.qty, costUsdMicro: String(units(scenario.costUsd, 6)), free: scenario.free, now: start }, cfg);
    const trades = [], notices = [], fee = units(scenario.feeUsd || '0.02', 6);
    let lastPrice = 0n;
    for (let i = 0; i < scenario.quotes.length; i++) {
      const row = scenario.quotes[i], now = start + row.seconds * 1000, price = units(row.priceUsd, 6);
      lastPrice = price;
      const q = { sampleId: row.sampleId || 'block-' + i, blockNumber: row.block || i + 1, at: now, unitPrice: String(price * WAD), usdMicro: String(price * (BigInt(p.tradeQty) || BigInt(p.coreQty))) };
      const fresh = observePosition(p, q, cfg, now); notices.push(...coreReminders(p, now));
      const d = fresh ? saleDecision(p, q, cfg, { now, exitGasUsdMicro: String(fee) }) : null;
      if (d) {
        const proceeds = bp(BigInt(d.qty) * price, 10000 - (scenario.assumedSlippageBps || 0));
        applySale(p, { ...d, proceedsUsdMicro: String(proceeds), gasUsdMicro: String(fee), complete: true }, cfg, now);
        trades.push({ seconds: row.seconds, kind: d.kind, qty: d.qty, receivedUsd: format(proceeds, 6), feeUsd: format(fee, 6), coreQty: p.coreQty });
      }
    }
    const residual = BigInt(p.qty) * lastPrice;
    return { name: scenario.name, label: 'Synthetic scenario, not a historical backtest or executable-price guarantee', trades, coreRemindersHours: notices, remainingQty: p.qty, coreQty: p.coreQty, realizedUsd: format(p.realizedUsdMicro, 6), remainingMarkedUsd: format(residual, 6), netMarkedPnlUsd: format(BigInt(p.realizedUsdMicro) + residual - BigInt(p.costUsdMicro), 6) };
  });
}
