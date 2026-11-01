import { config } from '../src/config.mjs';
import { BSC } from '../src/rpc.mjs';
import { selector } from '../src/abi.mjs';
import { units } from '../src/money.mjs';
export const W = '0x' + '1'.repeat(40), C = '0x' + '2'.repeat(40), T = '0x' + '3'.repeat(40), OTHER = '0x' + '4'.repeat(40);
export const NOW = Date.parse('2026-11-01T00:00:00Z'), HASH = '0x' + 'a'.repeat(64), IDENTITY = 'sha256:' + 'b'.repeat(64);
export function cfg(overrides = {}) { return config(overrides); }
export function snapshot(extra = {}) {
  return { wallet: W, chainId: 56, target: C, asset: T, assetType: 'ERC20', reviewed: true, reviewExpiresAt: NOW + 86400000, identity: IDENTITY, expectedIdentity: IDENTITY, assetIdentity: IDENTITY, expectedAssetIdentity: IDENTITY, invariantsOk: true, allowedData: selector('mint()'), mintSelector: selector('mint()'), nativeValueWei: String(units('0.001')), usdtValueWei: '0', balanceWei: String(units('1')), bnbPrice: '700000000', priceAgeMs: 0, progressBps: 6000, agentCount: 100, burstCount: 25, heatTier: 1, poolOpen: false, refund: { reviewed: true, covered: true, termsCurrent: true, deadline: NOW + 86400000 }, ...extra };
}
export function plan(extra = {}) {
  return { chainId: 56, action: 'mint', wallet: W, target: C, project: T, asset: T, assetType: 'ERC20', data: selector('mint()'), valueWei: String(units('0.001')), costBnbWei: String(units('0.001')), costUsdMicro: '700000', gasWei: String(units('0.0001')), minAssetQty: '1', maxDebits: { [BSC.native]: String(units('0.001')) }, identity: IDENTITY, assetIdentity: IDENTITY, ...extra };
}
export function sim(extra = {}) {
  return { authorityChanges: [], allowanceChanges: [], balanceChanges: [{ owner: W, contractAddress: BSC.native, tokenType: 'Native', change: '-' + units('0.001') }, { owner: W, contractAddress: T, tokenType: 'Erc20', change: '1000' }], ...extra };
}
export function reservation(id, wallet = W, extra = {}) {
  return { id, wallet, project: C, action: 'mint', bnbWei: String(units('0.005')), nativeValueWei: String(units('0.005')), gasWei: String(units('0.0001')), usdMicro: '3500000', freeMint: false, balanceWei: String(units('1')), ...extra };
}
export function envelope(p) { return { chainId: '0x38', from: p.wallet, to: p.target, data: p.data, value: '0x' + BigInt(p.valueWei).toString(16), gas: '0x186a0', gasPrice: '0x3b9aca00', nonce: '0x0' }; }
export const quote = (id, seconds, price, amount = 1000) => ({ sampleId: 'block-' + id, blockNumber: id, at: NOW + seconds * 1000, unitPrice: String(units(String(price), 6) * 10n ** 18n), usdMicro: String(units(String(price), 6) * BigInt(amount)) });
