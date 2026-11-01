import test from 'node:test';
import assert from 'node:assert/strict';
import { entryGate, simulationGate, planGate } from '../src/guard.mjs';
import { config } from '../src/config.mjs';
import { keccak256 } from '../src/keccak.mjs';
import { selector, APPROVE, addrWord, word } from '../src/abi.mjs';
import { BSC } from '../src/rpc.mjs';
import { W, C, T, OTHER, NOW, cfg, snapshot, plan, sim } from './helpers.mjs';
test('upstream-derived Keccak matches published Ethereum vectors', () => {
  assert.equal(keccak256(''), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(selector('approve(address,uint256)'), '0x095ea7b3');
  assert.equal(selector('transfer(address,uint256)'), '0xa9059cbb');
  assert.equal(selector('swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)'), '0x791ac947');
});
test('60% progress never bypasses known malicious or code changes', () => {
  for (const changes of [{ malicious: true }, { identity: 'changed' }, { assetIdentity: 'changed' }, { invariantsOk: false }, { refund: null }]) assert.throws(() => entryGate(snapshot(changes), cfg(), NOW));
});
test('paid NFT never auto-enters even with high progress and heat', () => {
  assert.throws(() => entryGate(snapshot({ assetType: 'ERC721', progressBps: 10000, agentCount: 10000 }), cfg(), NOW), /PAID_NFT/);
});
test('high progress cannot replace the verified Agent sender requirement for paid entries', () => {
  assert.throws(() => entryGate(snapshot({ progressBps: 9900, agentCount: 99, heatTier: 100 }), cfg(), NOW), /PAID_AGENT_COUNT_TOO_LOW/);
  assert.throws(() => entryGate(snapshot({ progressBps: null, agentCount: 99, allowPaidHeatFallback: true }), cfg(), NOW), /PAID_AGENT_COUNT_TOO_LOW/);
  assert.doesNotThrow(() => entryGate(snapshot({ progressBps: 6000, agentCount: 100 }), cfg(), NOW));
});
test('actual zero progress does not become unknown-progress heat fallback', () => {
  assert.throws(() => entryGate(snapshot({ progressBps: 0, agentCount: 10000 }), cfg(), NOW), /WAIT_FOR_PROGRESS/);
  assert.throws(() => entryGate(snapshot({ progressBps: null }), cfg(), NOW), /WAIT_FOR_PROGRESS/);
  assert.doesNotThrow(() => entryGate(snapshot({ progressBps: null, allowPaidHeatFallback: true }), cfg(), NOW));
});
test('free heat fallback still requires no native or USDT payment', () => {
  assert.doesNotThrow(() => entryGate(snapshot({ nativeValueWei: '0', usdtValueWei: '0', progressBps: null, refund: null, agentCount: 0, burstCount: 25 }), cfg(), NOW));
  assert.throws(() => entryGate(snapshot({ nativeValueWei: '1', progressBps: null, refund: null }), cfg(), NOW), /REFUND/);
});
test('unknown pool state, stale price and expired review fail closed', () => {
  for (const x of [{ poolOpen: null }, { priceAgeMs: 20000 }, { reviewExpiresAt: NOW - 1 }]) assert.throws(() => entryGate(snapshot(x), cfg(), NOW));
});
test('mint preview must deliver the exact expected asset, not any NFT', () => {
  const fake = sim(); fake.balanceChanges[1] = { owner: W, contractAddress: OTHER, tokenType: 'Erc721', change: '1' };
  assert.throws(() => simulationGate(fake, plan()), /EXPECTED_ASSET_NOT_RECEIVED/);
  assert.equal(simulationGate(sim(), plan()), true);
});
test('negative and positive deltas for the same token are netted', () => {
  const x = sim(); x.balanceChanges.push({ owner: W, contractAddress: T, tokenType: 'Erc20', change: '-1000' });
  assert.throws(() => simulationGate(x, plan()), /EXPECTED_ASSET_NOT_RECEIVED|UNEXPECTED_ASSET_DEBIT/);
});
test('unexpected asset debits and hidden permissions are blocked', () => {
  const x = sim(); x.balanceChanges.push({ owner: W, contractAddress: OTHER, tokenType: 'Erc20', change: '-1' });
  assert.throws(() => simulationGate(x, plan()), /UNEXPECTED_ASSET_DEBIT/);
  assert.throws(() => simulationGate(sim({ authorityChanges: [{}] }), plan()), /AUTHORITY_CHANGE/);
  assert.throws(() => simulationGate(sim({ allowanceChanges: [{}] }), plan()), /UNEXPECTED_ALLOWANCE/);
});
test('missing simulation data and imprecise numeric amounts are rejected', () => {
  assert.throws(() => simulationGate({ balanceChanges: [] }, plan()), /INCOMPLETE/);
  const x = sim(); x.balanceChanges[0].change = -1;
  assert.throws(() => simulationGate(x, plan()), /INVALID_BALANCE/);
});
test('exact approval only; unlimited or wrong spender is blocked', () => {
  const p = { action: 'approve', wallet: W, target: BSC.usdt, token: BSC.usdt, spender: C, approvalAmount: '10', maxDebits: {} };
  const x = { balanceChanges: [], authorityChanges: [], allowanceChanges: [{ owner: W, spender: C, tokenContract: BSC.usdt, newAllowance: '10' }] };
  assert.equal(simulationGate(x, p), true);
  x.allowanceChanges[0].newAllowance = ((1n << 256n) - 1n).toString();
  assert.throws(() => simulationGate(x, p), /UNEXPECTED_ALLOWANCE/);
});
test('cannot relabel arbitrary transfer as approval', () => {
  const p = { chainId: 56, action: 'approve', wallet: W, target: BSC.usdt, token: BSC.usdt, spender: C, approvalAmount: '10', valueWei: '0', costBnbWei: '0', costUsdMicro: '0', data: selector('transfer(address,uint256)') + addrWord(C) + word(10) };
  assert.throws(() => planGate(p, snapshot({ usdtValueWei: '10' }), NOW), /INVALID_APPROVAL_CALL/);
});
test('tampered plan cannot understate cost or expand debit allowlist', () => {
  assert.throws(() => planGate(plan({ costUsdMicro: '0' }), snapshot(), NOW), /UNDERSTATED_COST/);
  const x = plan(); x.maxDebits[OTHER] = '100000';
  assert.throws(() => planGate(x, snapshot(), NOW), /EXPANDED_DEBIT/);
});
test('unknown configuration and bypass switches are not silently accepted', () => {
  assert.throws(() => config({ allowForce: true }), /Unknown config/);
  assert.throws(() => config({ limits: { globalDailyBnb: 'Infinity' } }));
  assert.throws(() => config({ sales: { slippageBps: 9000 } }));
  assert.throws(() => config({ limits: { perProjectUsd: '20' } }));
});
