import { readFileSync } from 'node:fs';
import { units } from './money.mjs';
import { INHERITED_DENYLIST } from './denylist.mjs';
export const DEFAULTS = {
  schemaVersion: 1, mode: 'shadow', chainId: 56, rpcs: [], wallets: [], templates: [],
  limits: { perProjectUsd: '12', globalDailyBnb: '0.05', walletDailyBnb: '0.05', gasReserveBnb: '0.006', freeGasDailyBnb: '0.005', globalGasDailyBnb: '0.01', maxGasPerTransactionBnb: '0.001', maxFreeTransactions: 1000, maxPaidInWindow: 3, paidWindowSeconds: 180, maxFailures: 3 },
  entry: { progressBps: 6000, minAgents: 100, freeBurstMin: 25, burstSeconds: 180, minimumPaidHeat: 1 },
  sales: { backX: 2, earlyDropBps: 2500, earlyCoverBps: 10200, paidCrashBps: 4000, fastPaidCrashBps: 3500, fastSeconds: 1800, freeCrashBps: 5000, freeCoreBps: 3000, paidCoreBps: 5000, steps: [[10, 3000], [20, 5000]], slippageBps: 300, maxPriceImpactBps: 1000, maxRepriceBps: 500, maxPeakJumpBps: 10000, quoteMaxAgeSeconds: 15, confirmMaxGapSeconds: 30, dustUsd: '0.3' },
  scan: { pollMs: 3000, hotMs: 15000, normalMs: 60000, coldMs: 300000, activeHours: 24, maxEntryChecksPerTick: 8, entryConcurrency: 2, confirmations: 2, maxBlocksPerTick: 8, receiptConcurrency: 4, rpcTimeoutMs: 8000, maxCandidates: 1000 },
  market: { enabled: false, cacheSeconds: 60, timeoutMs: 5000, maxRequestsPerMinute: 30 },
  telegram: { chatId: '', tokenEnv: 'RADAR_TG_BOT_TOKEN' },
  blockedContracts: [], blockedDeployers: [], temporaryDailyLimit: null
};
export function address(a) { if (typeof a !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a) || /^0x0{40}$/i.test(a)) throw new Error('Invalid nonzero address'); return a.toLowerCase(); }
function object(v) { return v && typeof v === 'object' && !Array.isArray(v); }
export function config(input = {}) {
  if (!object(input)) throw new Error('Config must be an object');
  for (const key of Object.keys(input)) if (!Object.hasOwn(DEFAULTS, key)) throw new Error('Unknown config key: ' + key);
  const c = structuredClone(DEFAULTS);
  for (const [k, v] of Object.entries(input)) {
    if (object(DEFAULTS[k])) {
      if (!object(v)) throw new Error('Invalid config section: ' + k);
      for (const key of Object.keys(v)) if (!Object.hasOwn(DEFAULTS[k], key)) throw new Error('Unknown config key: ' + k + '.' + key);
      c[k] = { ...c[k], ...v };
    } else c[k] = v;
  }
  if (c.schemaVersion !== 1 || c.chainId !== 56 || !['shadow', 'live'].includes(c.mode)) throw new Error('Unsupported schema, chain or mode');
  for (const key of ['rpcs', 'wallets', 'templates', 'blockedContracts', 'blockedDeployers']) if (!Array.isArray(c[key])) throw new Error('Expected array: ' + key);
  for (const u of c.rpcs) { const url = new URL(u); if (url.protocol !== 'https:' || url.username || url.password) throw new Error('RPC requires HTTPS without URL credentials'); }
  const walletIds = new Set();
  for (const w of c.wallets) { w.address = address(w.address); if (walletIds.has(w.address)) throw new Error('Duplicate wallet'); walletIds.add(w.address); if (w.bawModule != null && typeof w.bawModule !== 'string') throw new Error('Invalid bawModule'); }
  for (const k of ['perProjectUsd', 'globalDailyBnb', 'walletDailyBnb', 'gasReserveBnb', 'freeGasDailyBnb', 'globalGasDailyBnb', 'maxGasPerTransactionBnb']) {
    const n = units(c.limits[k], k === 'perProjectUsd' ? 6 : 18); if (n <= 0n) throw new Error('A finite positive limit is required: ' + k);
  }
  if (units(c.limits.globalDailyBnb) > units('1') || units(c.limits.walletDailyBnb) > units('1') || units(c.limits.perProjectUsd, 6) > units('12', 6)) throw new Error('Beta budget ceiling exceeded');
  for (const [k, v] of Object.entries(c.limits)) if (typeof v === 'number' && (!Number.isSafeInteger(v) || v < 1)) throw new Error('Invalid limit: ' + k);
  for (const [k, v] of Object.entries(c.entry)) if (!Number.isSafeInteger(v) || v < 1 || (k === 'progressBps' && v > 10000)) throw new Error('Invalid entry parameter: ' + k);
  for (const [k, v] of Object.entries(c.scan)) if (!Number.isSafeInteger(v) || v < 1 || v > 1000000) throw new Error('Invalid scan parameter: ' + k);
  if (c.scan.entryConcurrency > 4 || c.scan.maxEntryChecksPerTick > 32 || c.scan.hotMs > c.scan.normalMs || c.scan.normalMs > c.scan.coldMs) throw new Error('Invalid entry scheduling limits');
  if (typeof c.market.enabled !== 'boolean') throw new Error('market.enabled must be a boolean');
  for (const k of ['cacheSeconds', 'timeoutMs', 'maxRequestsPerMinute']) if (!Number.isSafeInteger(c.market[k]) || c.market[k] < 1) throw new Error('Invalid market parameter: ' + k);
  if (c.market.cacheSeconds > 300 || c.market.timeoutMs > 10000 || c.market.maxRequestsPerMinute > 60) throw new Error('Market observation limits exceeded');
  for (const key of ['paidCrashBps', 'fastPaidCrashBps', 'freeCrashBps', 'freeCoreBps', 'paidCoreBps', 'slippageBps', 'maxPriceImpactBps', 'earlyDropBps']) if (!Number.isInteger(c.sales[key]) || c.sales[key] <= 0 || c.sales[key] >= 10000) throw new Error('Invalid sale BPS: ' + key);
  if (c.sales.slippageBps > 1000 || c.sales.maxPriceImpactBps > 2000) throw new Error('Beta slippage/impact ceiling exceeded');
  if (!Number.isSafeInteger(c.sales.maxRepriceBps) || c.sales.maxRepriceBps < 0 || c.sales.maxRepriceBps > 500 || !Number.isSafeInteger(c.sales.maxPeakJumpBps) || c.sales.maxPeakJumpBps < 1) throw new Error('Invalid repricing/peak limit');
  for (const key of ['backX', 'fastSeconds', 'quoteMaxAgeSeconds', 'confirmMaxGapSeconds', 'earlyCoverBps']) if (!Number.isSafeInteger(c.sales[key]) || c.sales[key] < 1) throw new Error('Invalid sale parameter: ' + key);
  units(c.sales.dustUsd, 6);
  if (!Array.isArray(c.sales.steps) || c.sales.steps.some(s => !Array.isArray(s) || s.length !== 2 || !Number.isInteger(s[0]) || s[0] < 2 || !Number.isInteger(s[1]) || s[1] < 1 || s[1] > 10000)) throw new Error('Invalid sale steps');
  c.blockedContracts = [...new Set([...INHERITED_DENYLIST, ...c.blockedContracts.map(address)])]; c.blockedDeployers = c.blockedDeployers.map(address);
  const seen = new Set();
  for (const t of c.templates) {
    t.contract = address(t.contract); t.asset = address(t.asset);
    if (seen.has(t.contract)) throw new Error('Duplicate template'); seen.add(t.contract);
    if (!/^sha256:[0-9a-f]{64}$/.test(t.identity || '') || !/^sha256:[0-9a-f]{64}$/.test(t.assetIdentity || '')) throw new Error('Pinned mint and asset identities are required');
    if (!['free-fixed', 'free-count', 'bnb-fixed', 'usdt-fixed'].includes(t.kind)) throw new Error('Unsupported mint adapter');
    if (!/^0x[0-9a-f]{8}([0-9a-f]{64})*$/.test(t.calldata || '')) throw new Error('Explicit reviewed calldata required');
    if (!t.review || !Number.isFinite(Date.parse(t.review.expiresAt)) || typeof t.review.note !== 'string' || !t.review.note.trim()) throw new Error('Local code review with expiration and note required');
    if (!['ERC20', 'ERC721', 'ERC1155'].includes(t.assetType)) throw new Error('Expected asset standard required');
    if (t.assetType === 'ERC1155') throw new Error('ERC1155 automatic mint adapter is not implemented; observe only');
    if (typeof t.minAssetQty !== 'string' || !/^\d+$/.test(t.minAssetQty) || BigInt(t.minAssetQty) < 1n) throw new Error('Explicit positive minimum delivery is required');
    if (t.progress && (!/^0x[0-9a-f]{8}$/.test(t.progress.soldSelector) || !/^0x[0-9a-f]{8}$/.test(t.progress.capSelector))) throw new Error('Explicit progress selectors required');
    if (t.invariants && (!Array.isArray(t.invariants) || t.invariants.some(x => !/^0x[0-9a-f]{8}([0-9a-f]{64})*$/.test(x.data || '') || !/^0x([0-9a-f]{64})+$/.test(x.expected || '')))) throw new Error('Invalid reviewed invariants');
    if (!t.kind.startsWith('free-')) { units(t.maxPayment, t.kind === 'bnb-fixed' ? 18 : 18); if (!t.refund || t.refund.reviewed !== true || !/^0x[0-9a-f]{8}$/.test(t.refund.liabilitySelector || '') || !/^0x[0-9a-f]{8}$/.test(t.refund.deadlineSelector || '')) throw new Error('Reviewed refund terms and on-chain coverage calls required'); t.refund.escrow = address(t.refund.escrow); }
  }
  if (c.temporaryDailyLimit !== null) {
    const t = c.temporaryDailyLimit;
    if (!object(t) || !Number.isFinite(Date.parse(t.expiresAt)) || units(t.globalDailyBnb) > units('0.08') || units(t.globalDailyBnb) <= 0n) throw new Error('Temporary limit requires an expiry and at most 0.08 BNB');
  }
  return c;
}
export const loadConfig = (path) => config(JSON.parse(readFileSync(path, 'utf8')));
export const dailyLimit = (c, now) => c.temporaryDailyLimit && now < Date.parse(c.temporaryDailyLimit.expiresAt) ? units(c.temporaryDailyLimit.globalDailyBnb) : units(c.limits.globalDailyBnb);
