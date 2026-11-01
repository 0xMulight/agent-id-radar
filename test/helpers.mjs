import { WalletGateway, NATIVE, USDT } from '../personal/wallet.mjs';
import { PersonalLedger } from '../personal/ledger.mjs';
import { PERSONAL_DEFAULTS } from '../personal/profile.mjs';
import { units } from '../personal/money.mjs';
export { NATIVE, USDT, units };
export const W = '0x' + '1'.repeat(40), C = '0x' + '2'.repeat(40), T = '0x' + '3'.repeat(40), OTHER = '0x' + '4'.repeat(40);
export const HASH = '0x' + 'a'.repeat(64), NOW = Date.parse('2026-11-01T00:00:00Z');
export const word = n => BigInt(n).toString(16).padStart(64, '0'), topic = a => '0x' + a.slice(2).padStart(64, '0');
export const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const log = (token, from, to, qty) => ({ address: token, topics: [TRANSFER, topic(from), topic(to)], data: '0x' + word(qty) });
export const ZERO = '0x' + '0'.repeat(40);
export function simulation(extra = {}) { return { balanceChanges: [{ owner: W, contractAddress: NATIVE, tokenType: 'Native', change: '-' + units('0.001') }, { owner: W, contractAddress: T, tokenType: 'Erc20', change: '1000' }], allowanceChanges: [], authorityChanges: [], ...extra }; }
export const previewArgs = (value = '1000000000000000', data = '0x1249c58b') => ['contract-call', 'preview', '--binanceChainId', '56', '--from', W, '--to', C, '--value', value, '--inputData', data];
export const order = (extra = {}) => ({ wallet: W, project: C, principalWei: String(units('0.005')), nativeDebitWei: String(units('0.005')), gasWei: String(units('0.001')), price: '700000000', balanceWei: String(units('1')), exit: false, ...extra });
export function fixture(options = {}) {
  let now = NOW, sends = 0, polls = 0, sim = options.sim || simulation(); const calls = [];
  const p = { ...PERSONAL_DEFAULTS, mode: 'live', ...options.personal }, ledger = new PersonalLedger(null, p, () => now);
  const receipt = { transactionHash: HASH, blockHash: 'block10', blockNumber: '0xa', status: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', logs: [log(T, ZERO, W, 1000)], ...options.receipt };
  const rpc = async (method) => {
    if (method === 'eth_chainId') return options.chain || '0x38'; if (method === 'eth_getBalance') return '0x' + units('1').toString(16);
    if (method === 'eth_getTransactionReceipt') return options.noReceipt ? null : receipt;
    if (method === 'eth_blockNumber') return '0xb'; if (method === 'eth_getBlockByNumber') return { hash: options.reorg ? 'fork' : 'block10' };
    if (method === 'eth_call') return '0x12'; throw new Error('Unexpected RPC method: ' + method);
  };
  const raw = async args => {
    calls.push(args); const key = args.slice(0, 2).join(' ');
    if (key === 'contract-call preview') return { j: { success: true, data: { requestId: 'bound', simulationResult: sim } }, t: '' };
    if (key === 'contract-call execute') { sends++; if (options.transportFailure) throw new Error('timeout'); return { j: { success: true, data: options.pendingApp ? { orderId: 'one', status: 'PENDING_CONFIRMATION', txHash: null } : { txHash: HASH, status: 'BROADCASTED' } }, t: '' }; }
    if (key === 'market-order quote') return { j: { success: true, data: { toCoinAmount: '7' } }, t: '' };
    if (key === 'market-order swap') { sends++; return { j: { success: true, data: { orderId: 'one' } }, t: '' }; }
    if (key === 'market-order list') { polls++; const row = { orderId: 'one', chain: '56', fromToken: T, fromTokenQty: '1', toToken: NATIVE, toTokenActualQty: '0.02', status: polls <= (options.pendingPolls || 0) ? 'PENDING' : 'FINISHED', txHash: HASH, ...options.market }; return { j: { success: true, data: { list: [row] } }, t: '' }; }
    return { j: { success: true, data: {} }, t: '' };
  };
  const gateway = new WalletGateway({ wallets: [{ name: 'test.ai', address: W }], personal: p }, '.', { argv: p.mode === 'live' ? ['--execute'] : [], rpc, bnbUsd: async () => 700, clock: () => now, pause: async ms => { now += ms; }, rawFor: () => raw, ledger });
  const run = gateway.runner({ name: 'test.ai', address: W });
  return { gateway, ledger, run, calls, receipt, sends: () => sends, polls: () => polls, setSim: s => { sim = s; }, advance: ms => { now += ms; } };
}
