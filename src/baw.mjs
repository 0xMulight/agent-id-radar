import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
export class BroadcastUnknown extends Error {}
export function validateEnvelope(envelope, plan) {
  if (!envelope || typeof envelope !== 'object') throw new Error('Live signing envelope unavailable; inspect the official CLI protocol before enabling broadcasts');
  const n = x => { if (typeof x !== 'string' || !/^(0x[0-9a-fA-F]+|\d+)$/.test(x)) throw new Error('Unverified signing envelope numeric field'); return BigInt(x); };
  if (String(envelope.from).toLowerCase() !== plan.wallet || String(envelope.to).toLowerCase() !== plan.target || String(envelope.data ?? envelope.input).toLowerCase() !== plan.data.toLowerCase() || n(envelope.value ?? '0') !== BigInt(plan.valueWei) || n(envelope.chainId) !== 56n) throw new Error('Signing envelope does not match the bound plan');
  if (envelope.authorizationList?.length || envelope.delegation) throw new Error('Unexpected account delegation in signing envelope');
  const gas = n(envelope.gasLimit ?? envelope.gas), price = n(envelope.maxFeePerGas ?? envelope.gasPrice);
  if (gas <= 0n || price <= 0n || gas * price > BigInt(plan.gasWei)) throw new Error('Signing envelope Gas exceeds the reservation');
  if (envelope.nonce === undefined) throw new Error('Signing envelope nonce is required');
  n(envelope.nonce);
  return true;
}
export class BawWallet {
  constructor(wallet, { runner = null, live = false } = {}) { this.wallet = wallet; this.live = live; this.runner = runner || this.run.bind(this); }
  run(args) {
    const module = this.wallet.bawModule;
    if (!module || !isAbsolute(module) || !existsSync(module) || !/\.(m?js|cjs)$/.test(module)) throw new Error('Set bawModule to the absolute official CLI JS entry; no shell command is accepted');
    const env = { ...process.env };
    if (this.wallet.bawDir) env.BINANCE_BAW_DIR = this.wallet.bawDir;
    if (this.wallet.instanceId) env.BINANCE_INSTANCE_ID = this.wallet.instanceId;
    return new Promise((resolve, reject) => execFile(process.execPath, [module, ...args, '--json'], { shell: false, windowsHide: true, timeout: 90000, maxBuffer: 4 << 20, env }, (error, stdout) => {
      if (error) { reject(new BroadcastUnknown('CLI failed or timed out; submission may be unknown')); return; }
      try { const j = JSON.parse(String(stdout).trim()); if (!j || typeof j.success !== 'boolean') throw new Error(); resolve(j); }
      catch { reject(new BroadcastUnknown('Unrecognized CLI JSON; do not retry automatically')); }
    }));
  }
  async preview(plan) {
    const j = await this.runner(['contract-call', 'preview', '--binanceChainId', '56', '--from', plan.wallet, '--to', plan.target, '--value', plan.valueWei, '--inputData', plan.data]);
    if (!j.success || typeof j.data?.requestId !== 'string' || !j.data?.simulationResult) throw new Error('Official preview did not return a bound request and complete simulation');
    return { requestId: j.data.requestId, sim: j.data.simulationResult, envelope: j.data.transactionRequest || j.data.transaction || null };
  }
  async broadcast(requestId) {
    if (!this.live) throw new Error('Live broadcasts are disabled');
    const j = await this.runner(['contract-call', 'execute', '--requestId', requestId]);
    if (!j.success) throw new BroadcastUnknown('Execution was not confirmed; reconcile before retry');
    const hash = j.data?.txHash;
    if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new BroadcastUnknown('No transaction hash returned; keep intent locked');
    return hash.toLowerCase();
  }
}
