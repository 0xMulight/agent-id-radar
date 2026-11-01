import { address } from './config.mjs';
import { BSC } from './rpc.mjs';
import { ALLOWED_MINT_SELECTORS, APPROVE, addrWord, word, encodeSwap } from './abi.mjs';
import { units, bnbToUsd, usdToBnb } from './money.mjs';
export class GuardError extends Error { constructor(code, message = code) { super(message); this.code = code; } }
const reject = (code) => { throw new GuardError(code); };
export function entryGate(ctx, c, now = Date.now()) {
  if (ctx.chainId !== 56) reject('WRONG_CHAIN');
  if (ctx.malicious || c.blockedContracts.includes(ctx.target) || c.blockedDeployers.includes(ctx.deployer)) reject('BLOCKED');
  if (!ctx.reviewed || !ctx.reviewExpiresAt || now >= ctx.reviewExpiresAt) reject('REVIEW_REQUIRED');
  if (!ctx.identity || ctx.identity !== ctx.expectedIdentity) reject('CODE_CHANGED');
  if (!ctx.assetIdentity || ctx.assetIdentity !== ctx.expectedAssetIdentity) reject('ASSET_CODE_CHANGED');
  if (!ctx.invariantsOk) reject('CONTRACT_RULES_CHANGED');
  const paid = BigInt(ctx.nativeValueWei || '0') > 0n || BigInt(ctx.usdtValueWei || '0') > 0n;
  if (paid && ctx.assetType !== 'ERC20') reject('PAID_NFT_NOTIFY_ONLY');
  if (!ctx.mintSelector || !ALLOWED_MINT_SELECTORS.has(ctx.mintSelector)) reject('UNREVIEWED_CALL');
  if (paid && (!ctx.refund?.reviewed || !ctx.refund?.covered || !ctx.refund?.termsCurrent || ctx.refund.deadline <= now)) reject('REFUND_UNVERIFIED');
  if (paid && (!Number.isSafeInteger(ctx.agentCount) || ctx.agentCount < c.entry.minAgents)) reject('PAID_AGENT_COUNT_TOO_LOW');
  if (paid && ctx.heatTier < c.entry.minimumPaidHeat) reject('HEAT_TOO_LOW');
  if (ctx.progressBps === null) {
    const crowd = ctx.agentCount >= c.entry.minAgents;
    if (paid ? !(crowd && ctx.allowPaidHeatFallback === true) : !(crowd || ctx.burstCount >= c.entry.freeBurstMin)) reject('WAIT_FOR_PROGRESS');
  } else if (!Number.isInteger(ctx.progressBps) || ctx.progressBps < c.entry.progressBps || ctx.progressBps > 10000) reject('WAIT_FOR_PROGRESS');
  if (ctx.poolOpen === true) reject('POOL_ALREADY_OPEN');
  if (ctx.poolOpen !== false) reject('POOL_STATE_UNKNOWN');
  if (ctx.priceAgeMs > c.sales.quoteMaxAgeSeconds * 1000 || BigInt(ctx.bnbPrice || '0') <= 0n) reject('PRICE_STALE');
  return { paid };
}
export function planGate(plan, snapshot, now = Date.now()) {
  if (plan.wallet !== snapshot.wallet || plan.chainId !== 56) reject('PLAN_WALLET_MISMATCH');
  if (plan.action === 'mint') {
    if (plan.target !== snapshot.target || plan.asset !== snapshot.asset || plan.data !== snapshot.allowedData || plan.valueWei !== snapshot.nativeValueWei || plan.assetType !== snapshot.assetType) reject('PLAN_CHANGED');
    const native = BigInt(snapshot.nativeValueWei), paidUsdtMicro = BigInt(snapshot.usdtValueWei) / (10n ** 12n), price = plan.pricingBnbPrice || snapshot.bnbPrice;
    if (BigInt(price) <= 0n || plan.project !== snapshot.asset || BigInt(plan.costUsdMicro) !== bnbToUsd(native, price) + paidUsdtMicro || BigInt(plan.costBnbWei) !== native + usdToBnb(paidUsdtMicro, price)) reject('UNDERSTATED_COST');
    const expectedDebits = { ...(native > 0n ? { [BSC.native]: String(native) } : {}), ...(BigInt(snapshot.usdtValueWei) > 0n ? { [BSC.usdt]: snapshot.usdtValueWei } : {}) };
    if (Object.keys(plan.maxDebits || {}).length !== Object.keys(expectedDebits).length || Object.entries(expectedDebits).some(([k, v]) => plan.maxDebits[k] !== v)) reject('EXPANDED_DEBIT_ALLOWLIST');
  } else if (plan.action === 'approve' || plan.action === 'revoke') {
    if (plan.target !== plan.token || plan.data !== APPROVE + addrWord(plan.spender) + word(plan.approvalAmount) || plan.valueWei !== '0') reject('INVALID_APPROVAL_CALL');
    if (plan.action === 'revoke' && BigInt(plan.approvalAmount) !== 0n) reject('INVALID_REVOKE');
    if (plan.action === 'approve') {
      if (snapshot.exitApproval) {
        if (plan.spender !== BSC.router || plan.token !== snapshot.asset || BigInt(plan.approvalAmount) > BigInt(snapshot.allowedQty || '0')) reject('INVALID_EXIT_APPROVAL');
      } else if (plan.token !== BSC.usdt || plan.spender !== snapshot.target || BigInt(plan.approvalAmount) !== BigInt(snapshot.usdtValueWei)) reject('INVALID_MINT_APPROVAL');
    }
  } else if (plan.action === 'sell') {
    const data = encodeSwap('swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)', plan.qty, plan.minOutWei, plan.path, plan.wallet, plan.deadline);
    if (plan.target !== BSC.router || plan.valueWei !== '0' || plan.path[0] !== plan.asset || plan.path.at(-1) !== BSC.wbnb || plan.data !== data) reject('INVALID_SALE_CALL');
    if (BigInt(plan.minOutWei) <= 0n || BigInt(plan.minOutWei) < BigInt(snapshot.allowedMinOutWei || '0') || BigInt(plan.qty) !== BigInt(snapshot.allowedQty || '0') || plan.deadline * 1000 <= now || plan.deadline * 1000 > now + 120000) reject('UNSAFE_SALE_BOUNDS');
  } else reject('UNKNOWN_ACTION');
  if (plan.action !== 'mint' && (plan.costBnbWei !== '0' || plan.costUsdMicro !== '0')) reject('UNEXPECTED_PRINCIPAL');
  return true;
}
export function simulationGate(sim, plan) {
  if (!sim || !Array.isArray(sim.balanceChanges) || !Array.isArray(sim.allowanceChanges) || !Array.isArray(sim.authorityChanges)) reject('INCOMPLETE_SIMULATION');
  if (sim.authorityChanges.length) reject('AUTHORITY_CHANGE');
  const wallet = address(plan.wallet), target = address(plan.target);
  const allowance = sim.allowanceChanges;
  if (plan.action === 'approve' || plan.action === 'revoke') {
    if (allowance.length !== 1) reject('UNEXPECTED_ALLOWANCE');
    const a = allowance[0];
    const amount = a.newAllowance ?? a.newAmount ?? a.allowance ?? a.amount;
    if (typeof amount !== 'string' || !/^\d+$/.test(amount) || address(a.spender) !== address(plan.spender) || address(a.tokenContract || a.contractAddress) !== address(plan.token) || BigInt(amount) !== BigInt(plan.approvalAmount)) reject('UNEXPECTED_ALLOWANCE');
    if (a.owner && address(a.owner) !== wallet) reject('UNEXPECTED_ALLOWANCE_OWNER');
  } else if (allowance.length) reject('UNEXPECTED_ALLOWANCE');
  const sum = new Map();
  for (const b of sim.balanceChanges) {
    if (typeof b.change !== 'string' || !/^-?\d+$/.test(b.change)) reject('INVALID_BALANCE_DELTA');
    if (String(b.owner).toLowerCase() !== wallet) continue;
    const token = address(b.contractAddress), key = token + '|' + (b.tokenId ?? '');
    const old = sum.get(key); sum.set(key, { token, tokenType: b.tokenType, delta: (old?.delta || 0n) + BigInt(b.change) });
  }
  const negatives = new Map();
  for (const b of sum.values()) if (b.delta < 0n) negatives.set(b.token, (negatives.get(b.token) || 0n) - b.delta);
  const allowed = plan.maxDebits || {};
  for (const [token, n] of negatives) if (!Object.hasOwn(allowed, token) || n > BigInt(allowed[token])) reject('UNEXPECTED_ASSET_DEBIT');
  // Approval/revocation is a separate operation. A mint cannot smuggle it in.
  if (plan.action === 'mint') {
    const got = [...sum.values()].filter(b => b.token === address(plan.asset) && b.delta > 0n);
    if (!got.length) reject('EXPECTED_ASSET_NOT_RECEIVED');
    if (plan.assetType === 'ERC20' && got.some(b => !/^Erc20$/i.test(b.tokenType || ''))) reject('WRONG_ASSET_STANDARD');
    if (plan.assetType === 'ERC721' && got.some(b => !/^Erc721$/i.test(b.tokenType || ''))) reject('WRONG_ASSET_STANDARD');
    if (plan.assetType === 'ERC1155' && got.some(b => !/^Erc1155$/i.test(b.tokenType || ''))) reject('WRONG_ASSET_STANDARD');
    if (got.reduce((a, b) => a + b.delta, 0n) < BigInt(plan.minAssetQty || '1')) reject('INSUFFICIENT_DELIVERY');
  } else if (plan.action === 'sell') {
    const netNative = [...sum.values()].filter(b => b.token === BSC.native).reduce((a, b) => a + b.delta, 0n);
    if (netNative < BigInt(plan.minOutWei)) reject('SELL_OUTPUT_TOO_LOW');
    if ((negatives.get(address(plan.asset)) || 0n) !== BigInt(plan.qty)) reject('WRONG_SELL_QUANTITY');
  }
  return true;
}
export function gasGate(gasWei, balanceWei, c, buying = true) {
  if (gasWei <= 0n || gasWei > units(c.limits.maxGasPerTransactionBnb)) reject('GAS_LIMIT');
  if (buying && balanceWei - gasWei < units(c.limits.gasReserveBnb)) reject('GAS_RESERVE');
}
