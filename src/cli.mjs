import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { config, loadConfig, DEFAULTS } from './config.mjs';
import { Store } from './store.mjs';
import { Runtime } from './runtime.mjs';
import { Rpc } from './rpc.mjs';
import { replay } from './replay.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), command = args[0] || 'help';
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const configPath = resolve(option('--config', join(ROOT, 'config.json')));
const statePath = resolve(option('--state', join(ROOT, 'data', 'guard-state.json')));
try {
  if (command === 'help' || args.includes('--help')) {
    console.log('Agent ID Radar 0.1.0-beta.1\n\ninit                 创建默认观察配置\ncheck                校验配置\ninspect <contract>   只读查看合约代码身份\nwatch                运行扫描、预演和仓位观察\nwatch --execute      仅在配置 mode=live 时允许真实广播\nstatus               查看本地状态（不显示凭证）\ndemo                 运行内置离线场景\nreplay <file>        运行指定合成场景\n\n可选 --config <path> --state <path>\n未设置模板的项目只观察。此版本没有远程聊天交易指令或自动更新。');
  } else if (command === 'init') {
    if (existsSync(configPath)) throw new Error('Config already exists; refusing to overwrite');
    writeFileSync(configPath, JSON.stringify(DEFAULTS, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log('已创建观察模式配置：' + configPath + '\n先填写 HTTPS BSC RPC；钱包地址和模板可稍后添加。');
  } else if (command === 'demo' || command === 'replay') {
    const tape = JSON.parse(readFileSync(command === 'demo' ? join(ROOT, 'examples', 'replay.json') : resolve(args[1]), 'utf8'));
    console.log(JSON.stringify(replay(tape), null, 2));
  } else if (command === 'check') {
    const c = loadConfig(configPath);
    console.log(JSON.stringify({ valid: true, mode: c.mode, chain: c.chainId, wallets: c.wallets.length, reviewedTemplates: c.templates.length, dailyGlobalBnb: c.limits.globalDailyBnb, perProjectUsd: c.limits.perProjectUsd, paidNft: 'notify-only', timeZone: 'Asia/Shanghai' }, null, 2));
  } else if (command === 'request-sale') {
    if (!args.includes('--all') || !args[1]) throw new Error('明确使用 request-sale <positionId> --all；本请求包含底仓');
    const c = loadConfig(configPath), store = new Store(statePath);
    try {
      await store.transaction(s => {
        const p = s.positions[args[1]];
        if (!p || !c.wallets.some(w => w.address === p.wallet)) throw new Error('仓位或钱包不在当前配置');
        if (p.pendingSale || p.needsReview) throw new Error('仓位有待确认交易或数量待核对；先处理原交易');
        p.manualExit = true; p.sellFailures = 0;
      });
      console.log('已写入包含底仓的退出请求。重启观察模式可先查看计划；只有已配置并验证的 live 通道才能实际广播。');
    } finally { store.close(); }
  } else if (command === 'status') {
    if (!existsSync(statePath)) { console.log('尚无运行状态。先运行 demo 或配置 watch。'); }
    else {
      const s = JSON.parse(readFileSync(statePath, 'utf8'));
      console.log(JSON.stringify({ schemaVersion: s.schemaVersion, scan: { lastBlock: s.scan?.lastBlock, candidates: Object.keys(s.scan?.candidates || {}).length }, orders: Object.values(s.reservations || {}).map(r => ({ id: r.id, action: r.action, status: r.status, wallet: r.wallet, txHash: r.txHash })), positions: Object.entries(s.positions || {}).map(([id, p]) => ({ id, qty: p.qty, tradeQty: p.tradeQty, coreQty: p.coreQty, coreLocked: p.coreLocked, needsReview: p.needsReview || false })), recentEvents: (s.events || []).slice(-10) }, null, 2));
    }
  } else if (command === 'inspect') {
    const c = loadConfig(configPath), rpc = new Rpc(c.rpcs, c.scan.rpcTimeoutMs);
    const x = await rpc.identity(args[1]);
    console.log(JSON.stringify({ contract: args[1], identity: x.fingerprint, components: x.parts.map(p => ({ address: p.address, bytes: p.code.length / 2 - 1 })), note: '代码指纹仅用于绑定审核版本，不能代替退款、权限和资金流审核。' }, null, 2));
  } else if (command === 'watch') {
    const c = loadConfig(configPath);
    if (!c.rpcs.length) throw new Error('请先填写 HTTPS BSC RPC');
    if (c.mode === 'live' && !args.includes('--execute')) throw new Error('配置为 live；缺少 --execute，拒绝启动真实广播');
    if (c.mode === 'shadow' && args.includes('--execute')) throw new Error('观察模式不接受 --execute；不会自动切换模式');
    if (c.mode === 'live' && (!c.wallets.length || !c.templates.length)) throw new Error('Live mode requires configured wallets and reviewed templates');
    const store = new Store(statePath), runtime = new Runtime(c, store, { liveArmed: args.includes('--execute') });
    console.log(JSON.stringify({ mode: c.mode, limits: c.limits, entry: c.entry, sales: c.sales, wallets: c.wallets.map(w => w.address), reviewedTemplates: c.templates.length }, null, 2));
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await runtime.stop(); store.close(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    runtime.start();
  } else throw new Error('Unknown command; run node src/cli.mjs help');
} catch (e) {
  console.error(String(e.message || e).replace(/https?:\/\/\S+/g, '[provider]').slice(0, 300));
  process.exitCode = 1;
}
