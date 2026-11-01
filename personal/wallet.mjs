import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { profile, addr } from './profile.mjs';
import { PersonalLedger } from './ledger.mjs';
import { units, WAD, usdToBnb } from './money.mjs';
import { WalletQueue } from './store.mjs';
export const NATIVE = '0x' + 'e'.repeat(40), USDT = '0x55d398326f99059ff775485246999027b3197955';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const hex = x => '0x' + BigInt(x).toString(16), word = x => BigInt(x).toString(16).padStart(64, '0');
const flag = (args, name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const integer = x => { if (typeof x !== 'string' || !/^-?\d+$/.test(x)) throw new Error('预演金额必须是精确整数'); return BigInt(x); };
const txHash = x => typeof x === 'string' && /^0x[0-9a-f]{64}$/i.test(x);
const success = data => ({ j: { success: true, data }, t: JSON.stringify({ success: true, data }) });
export function cliRunner(wallet, root) {
  return async (args, timeout = 180000) => {
    const candidates = wallet.bawModule ? [isAbsolute(wallet.bawModule) ? wallet.bawModule : resolve(root, wallet.bawModule)] : [
      join(root, wallet.bawPkg || 'tools/wallet', 'node_modules/@binance/agentic-wallet/dist/index.js'),
      join(root, 'node_modules/@binance/agentic-wallet/dist/index.js'),
      ...(process.env.APPDATA ? [join(process.env.APPDATA, 'npm/node_modules/@binance/agentic-wallet/dist/index.js')] : []),
      join(dirname(process.execPath), '../lib/node_modules/@binance/agentic-wallet/dist/index.js')
    ];
    const module = candidates.find(existsSync); if (!module) throw new Error('找不到官方钱包 CLI，请运行一键安装或配置 bawModule');
    const env = { ...process.env, ...(wallet.bawDir ? { BINANCE_BAW_DIR: resolve(root, wallet.bawDir), BINANCE_INSTANCE_ID: wallet.instanceId || wallet.name } : {}) };
    return new Promise(res => execFile(process.execPath, [module, ...args, '--json'], { shell: false, windowsHide: true, timeout, maxBuffer: 4 << 20, env }, (e, stdout) => {
      let j = null; try { const s = String(stdout || ''); j = JSON.parse(s.slice(s.indexOf('{'))); } catch {}
      res({ j, t: j ? JSON.stringify(j) : '官方 CLI 无有效响应或超时', transportError: Boolean(e) });
    }));
  };
}
export function simulationPlan(sim, args, wallet, price) {
  if (!sim || !Array.isArray(sim.balanceChanges) || !Array.isArray(sim.allowanceChanges) || !Array.isArray(sim.authorityChanges)) throw new Error('缺少完整预演结果');
  if (sim.authorityChanges.length) throw new Error('预演存在账户权限变化');
  const target = addr(flag(args, '--to')), value = BigInt(flag(args, '--value', '0')), data = flag(args, '--inputData', '0x').toLowerCase();
  if (addr(flag(args, '--from')) !== wallet || flag(args, '--binanceChainId') !== '56' || value < 0n || !/^0x([0-9a-f]{2})*$/.test(data)) throw new Error('预演钱包、链或参数不符');
  const sums = new Map(), assets = new Set(); let nft = false;
  for (const b of sim.balanceChanges) {
    const amount = integer(b.change); if (String(b.owner).toLowerCase() !== wallet) continue;
    const token = addr(b.contractAddress); sums.set(token, (sums.get(token) || 0n) + amount);
    if (amount > 0n && token !== NATIVE && token !== USDT) { assets.add(token); nft ||= /erc721|erc1155/i.test(b.tokenType || ''); }
  }
  let native = 0n, usdt = 0n;
  for (const [token, amount] of sums) if (amount < 0n) {
    if (token === NATIVE) native -= amount; else if (token === USDT) usdt -= amount; else throw new Error('预演扣减了 BNB／USDT 以外的已有资产');
  }
  if (native > value) throw new Error('预演 BNB 扣减超过声明金额');
  let project = target, exit = false, approvalAmountWei = '0';
  if (/^0x095ea7b3[0-9a-f]{128}$/.test(data)) {
    const spender = addr('0x' + data.slice(34, 74)), amount = BigInt('0x' + data.slice(74));
    if (native || usdt || value) throw new Error('授权不能夹带付款');
    project = spender; exit = amount === 0n;
    approvalAmountWei = String(amount);
    if (amount > 0n && target !== USDT) throw new Error('只允许独立的定额 USDT 授权');
    if (sim.allowanceChanges.length !== 1) throw new Error('无法确认独立授权');
    const a = sim.allowanceChanges[0], allowed = a.newAllowance ?? a.newAmount ?? a.allowance ?? a.amount;
    if (addr(a.spender) !== spender || addr(a.tokenContract || a.contractAddress) !== target || integer(allowed) !== amount) throw new Error('授权对象或金额不符');
  } else {
    if (sim.allowanceChanges.length) throw new Error('铸造预演夹带额外授权');
    if (!sim.balanceChanges.some(b => String(b.owner).toLowerCase() === wallet && integer(b.change) > 0n)) throw new Error('预演没有收到资产');
  }
  const principal = (value > native ? value : native) + usdToBnb(usdt / 10n ** 12n, price);
  return { target, data, valueWei: String(value), nativeDebitWei: String(value), usdtDebitWei: String(usdt), principalWei: String(principal), project, exit, nft, approvalAmountWei, receivedAssets: [...assets], previewArgs: args };
}
export class WalletGateway {
  constructor(config, root, { argv = [], rpc, bnbUsd, rawFor = null, clock = Date.now, pause = ms => new Promise(r => setTimeout(r, ms)), ledger = null } = {}) {
    this.cfg = profile(config, argv); this.root = root; this.rpc = rpc; this.bnbUsd = bnbUsd; this.clock = clock; this.pause = pause; this.rawFor = rawFor || (w => cliRunner(w, root));
    this.ledger = ledger || new PersonalLedger(join(root, 'data/personal-orders.json'), this.cfg, clock); this.queue = new WalletQueue(); this.previews = new Map(); this.chainChecked = false;
  }
  close() { this.ledger.close(); }
  async chain() { if (!this.chainChecked) { if (await this.rpc('eth_chainId', []) !== '0x38') throw new Error('需要 BSC 56 节点'); this.chainChecked = true; } }
  async price() { const p = await this.bnbUsd(); if (!Number.isFinite(p) || p <= 0 || p > 100000) throw new Error('没有有效 BNB 价格，不能付款'); return BigInt(Math.round(p * 1e6)); }
  buyBudgetUsd(wallet, project, price, nft = false) {
    if (!Number.isFinite(price) || price <= 0) return 0;
    const p = BigInt(Math.round(price * 1e6)), available = this.ledger.remainingUsd(wallet, project, p), cap = units(nft ? this.cfg.nftMaxUsd : this.cfg.perProjectUsd, 6);
    const gasBuffer = units(this.cfg.maxGasBnb) * p * 2n / WAD, result = (available < cap ? available : cap) - gasBuffer;
    return result > 0n ? Number(result) / 1e6 : 0;
  }
  assetCostUsd(wallet, asset) {
    const rows = this.ledger.records().filter(r => r.wallet === wallet && r.status === 'confirmed'), projects = new Set(rows.filter(r => r.receivedAssets?.includes(asset)).map(r => r.project));
    return rows.filter(r => projects.has(r.project) && !r.exit && r.kind !== 'funding').reduce((s, r) => s + Number(r.spentUsdMicro || 0) / 1e6, 0);
  }
  runner(wc) {
    const wallet = addr(wc.address), raw = this.rawFor(wc);
    return async (args, timeout) => {
      const key = args.slice(0, 2).join(' ');
      if (key === 'contract-call preview') {
        const r = await raw(args, timeout), id = r.j?.data?.requestId;
        if (r.j?.success && typeof id === 'string') { this.previews.set(wallet + ':' + id, { args: [...args], sim: r.j.data.simulationResult, at: this.clock() }); if (this.previews.size > 200) this.previews.delete(this.previews.keys().next().value); }
        return r;
      }
      if (['wallet status', 'wallet settings', 'auth signin', 'auth verify', 'approvals list', 'market-order quote', 'market-order list'].includes(key)) return raw(args, timeout);
      if (!['contract-call execute', 'market-order swap', 'approvals revoke'].includes(key)) throw new Error('个人版不支持此钱包操作');
      if (this.cfg.mode !== 'live') throw new Error('观察模式：未发送交易；交易模式需配置 live 并显式启动 --execute');
      return this.queue.run(wallet, () => this.execute(wallet, raw, args, timeout));
    };
  }
  async execute(wallet, raw, originalArgs, timeout) {
    await this.chain(); const price = await this.price(), args = [...originalArgs], key = args.slice(0, 2).join(' ');
    let plan, qty, from, to;
    if (key === 'contract-call execute') {
      const id = flag(args, '--requestId'), bound = this.previews.get(wallet + ':' + id);
      if (!bound || this.clock() - bound.at > 90000) throw new Error('预演已过期或没有匹配此钱包');
      plan = simulationPlan(bound.sim, bound.args, wallet, price); plan.kind = 'contract'; plan.requestId = id; this.previews.delete(wallet + ':' + id);
      if (BigInt(plan.approvalAmountWei) > units(this.cfg.perProjectUsd)) throw new Error('授权超过单项目最高付款额');
    } else if (key === 'market-order swap') {
      if (flag(args, '--binanceChainId') !== '56') throw new Error('仅支持 BSC 56');
      from = addr(flag(args, '--fromToken')); to = addr(flag(args, '--toToken')); qty = flag(args, '--fromTokenQty');
      if (!/^\d+(\.\d+)?$/.test(qty || '') || Number(qty) <= 0 || (to !== NATIVE && !(from === NATIVE && to === USDT))) throw new Error('不支持此换币方向／金额');
      const requestedSlip = flag(args, '--slippage', this.cfg.maxSlippage);
      if (!Number.isFinite(Number(requestedSlip)) || Number(requestedSlip) <= 0 || Number(requestedSlip) > Number(this.cfg.maxSlippage)) throw new Error('滑点超过个人限额');
      if (!args.includes('--slippage')) args.push('--slippage', this.cfg.maxSlippage);
      const mev = args.indexOf('--mev'); if (mev >= 0) args[mev + 1] = 'true'; else args.push('--mev', 'true');
      const quote = await raw(['market-order', 'quote', ...args.slice(2).filter((_, i, a) => a[i - 1] !== '--mev' && a[i] !== '--mev')], timeout);
      if (!quote.j?.success || !(Number(quote.j.data?.toCoinAmount) > 0)) throw new Error('换币报价不可用');
      const funding = from === NATIVE && to === USDT;
      plan = { kind: funding ? 'funding' : 'sale', project: funding ? null : from, exit: !funding, principalWei: funding ? String(units(qty)) : '0', nativeDebitWei: funding ? String(units(qty)) : '0', from, to, qty, receivedAssets: [] };
    } else {
      if (flag(args, '--binanceChainId') !== '56') throw new Error('仅支持 BSC 56');
      plan = { kind: 'revoke', project: addr(flag(args, '--tokenContract')), exit: true, principalWei: '0', nativeDebitWei: '0', receivedAssets: [] };
    }
    const balance = BigInt(await this.rpc('eth_getBalance', [wallet, 'latest'])), gas = units(this.cfg.maxGasBnb);
    const id = await this.ledger.reserve({ ...plan, wallet, gasWei: String(gas), price: String(price), balanceWei: String(balance) });
    await this.ledger.set(id, 'broadcasting'); let submitted;
    try { submitted = await raw(args, timeout); }
    catch { await this.ledger.set(id, 'unknown'); throw new Error('結果不明：钱包请求中断，保留预占，不自动重发'); }
    let data = submitted.j?.data;
    if (!submitted.j?.success) { await this.ledger.set(id, 'unknown'); throw new Error('結果不明：执行没有确认，先核对钱包再处理'); }
    await this.ledger.set(id, 'broadcasting', { txHash: txHash(data?.txHash) ? data.txHash : null, orderId: data?.orderId || null });
    const deadline = this.clock() + this.cfg.receiptWaitSeconds * 1000;
    try {
      if (key === 'market-order swap') {
        if (!data?.orderId) throw new Error('缺少订单编号');
        let terminal = null;
        do {
          const r = await raw(['market-order', 'list', '--orderId', String(data.orderId), '--binanceChainId', '56']);
          const row = r.j?.data?.list?.find(x => String(x.orderId) === String(data.orderId));
          if (row && ['FINISHED', 'FAILED'].includes(row.status)) { terminal = row; break; }
          await this.pause(3000);
        } while (this.clock() < deadline);
        if (!terminal) throw new Error('订单仍在处理中');
        if (addr(terminal.fromToken) !== from || addr(terminal.toToken) !== to || String(terminal.chain) !== '56' || units(terminal.fromTokenQty) !== units(qty)) throw new Error('订单与提交内容不符');
        if (terminal.status === 'FAILED' && !txHash(terminal.txHash)) { await this.ledger.finish(id, { gasWei: String(gas), principalWei: '0', failed: true }); return { j: { success: false, error: { message: '换币订单失败，已保守计入 Gas 预留额' } }, t: '换币订单失败' }; }
        data = { ...data, ...terminal };
        await this.ledger.set(id, 'broadcasting', { txHash: data.txHash || null });
      }
      if (!txHash(data?.txHash)) throw new Error('没有已广播的交易 hash，可能等待 App 确认');
      const receipt = await this.receipt(data.txHash, deadline);
      const actualGas = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
      if (receipt.status !== '0x1') { await this.ledger.finish(id, { gasWei: String(actualGas), principalWei: '0', failed: true }); return { j: { success: false, error: { message: '链上交易失败' } }, t: '链上交易失败' }; }
      let principal = BigInt(plan.principalWei), actualReceived;
      if (plan.kind === 'contract') {
        const delta = this.tokenDelta(receipt, wallet, USDT), paid = delta < 0n ? -delta : 0n;
        principal = BigInt(plan.valueWei) + usdToBnb(paid / 10n ** 12n, price);
        if (paid > BigInt(plan.usdtDebitWei)) {
          await this.ledger.set(id, 'broadcasting', { gasWeiActual: String(actualGas), reservedBnbWei: String(principal + actualGas), reservedUsdMicro: String((principal + actualGas) * price / WAD) });
          throw new Error('实际 USDT 扣款超过预演，暂停核对');
        }
      }
      await this.ledger.set(id, 'broadcasting', { gasWeiActual: String(actualGas), reservedBnbWei: String(principal + actualGas), reservedUsdMicro: String((principal + actualGas) * price / WAD) });
      if (plan.kind === 'sale') {
        const d = await this.rpc('eth_call', [{ to: from, data: '0x313ce567' }, receipt.blockNumber]);
        const decimals = Number(BigInt(d)); if (decimals < 0 || decimals > 36) throw new Error('无法核对卖出数量');
        if (-this.tokenDelta(receipt, wallet, from) !== units(qty, decimals)) throw new Error('卖出部分成交或数量待核对');
        if (Array.isArray(data.refund) && data.refund.some(r => Number(r.amount) > 0)) throw new Error('存在退款，部分成交待核对');
        if (typeof data.toTokenActualQty !== 'string' || !/^\d+(\.\d+)?$/.test(data.toTokenActualQty) || units(data.toTokenActualQty) <= 0n) throw new Error('实际卖出收入待核对');
        actualReceived = data.toTokenActualQty;
      } else if (plan.kind === 'funding') {
        const received = this.tokenDelta(receipt, wallet, USDT); if (received <= 0n) throw new Error('USDT 到账待核对');
        const credited = usdToBnb(received / 10n ** 12n, price);
        principal = principal > credited ? principal - credited : 0n; // Conversion is wallet funding: charge its spread + Gas, not the same principal twice.
      } else if (plan.kind === 'contract' && plan.receivedAssets.length) {
        if (!plan.receivedAssets.some(asset => this.tokenDelta(receipt, wallet, asset) > 0n)) throw new Error('实际收货待核对');
      }
      await this.ledger.finish(id, { gasWei: String(actualGas), principalWei: String(principal) });
      return success({ ...data, actualReceived, personalGasBnb: String(Number(actualGas) / 1e18), personalCostUsd: Number((principal + actualGas) * price / WAD) / 1e6, status: 'CONFIRMED' });
    } catch (e) {
      await this.ledger.set(id, 'unknown'); throw new Error('結果不明：' + String(e.message).slice(0, 100) + '；保留请求记录，不自动重发');
    }
  }
  tokenDelta(receipt, wallet, token) {
    let net = 0n;
    for (const l of receipt.logs || []) if (String(l.address).toLowerCase() === token && l.topics?.[0] === TRANSFER && [3, 4].includes(l.topics.length)) {
      const amount = l.topics.length === 4 ? 1n : BigInt(l.data), from = '0x' + l.topics[1].slice(-40), to = '0x' + l.topics[2].slice(-40);
      if (from.toLowerCase() === wallet) net -= amount; if (to.toLowerCase() === wallet) net += amount;
    }
    return net;
  }
  async receipt(hash, deadline) {
    do {
      const r = await this.rpc('eth_getTransactionReceipt', [hash]);
      if (r && r.transactionHash?.toLowerCase() === hash.toLowerCase()) {
        const head = Number(BigInt(await this.rpc('eth_blockNumber', []))), n = Number(BigInt(r.blockNumber));
        if (head - n + 1 >= this.cfg.confirmations && (await this.rpc('eth_getBlockByNumber', [r.blockNumber, false]))?.hash === r.blockHash) return r;
      }
      await this.pause(3000);
    } while (this.clock() < deadline);
    throw new Error('回执尚未确认');
  }
}
