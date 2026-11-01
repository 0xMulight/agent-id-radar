import { units } from './money.mjs';
export const PERSONAL_DEFAULTS = Object.freeze({ mode: 'observe', globalDailyBnb: '0.05', globalGasDailyBnb: '0.01', perProjectUsd: '12', nftMaxUsd: '5', maxGasBnb: '0.001', keepBnb: '0.006', maxSlippage: '3', receiptWaitSeconds: 45, confirmations: 2 });
export const addr = x => { if (typeof x !== 'string' || !/^0x[0-9a-f]{40}$/i.test(x) || /^0x0{40}$/i.test(x)) throw new Error('无效钱包或合约地址'); return x.toLowerCase(); };
export function profile(input, argv = []) {
  if (input.schemaVersion || input.templates || input.limits) throw new Error('这是旧版审核模板配置。请保留原文件，在新解压目录运行一键配置，不要混用状态。');
  if (input.personal && (typeof input.personal !== 'object' || Array.isArray(input.personal))) throw new Error('personal 配置格式错误');
  for (const k of Object.keys(input.personal || {})) if (!Object.hasOwn(PERSONAL_DEFAULTS, k)) throw new Error('未知 personal 参数：' + k);
  const p = { ...PERSONAL_DEFAULTS, ...input.personal };
  if (!['observe', 'live'].includes(p.mode)) throw new Error('personal.mode 仅支持 observe / live');
  if ((p.mode === 'live') !== argv.includes('--execute')) throw new Error('交易模式需要 personal.mode=live 与 --execute 同时设置；观察模式不接受 --execute');
  for (const k of ['globalDailyBnb', 'globalGasDailyBnb', 'maxGasBnb', 'keepBnb']) if (units(p[k]) <= 0n) throw new Error('BNB 预算必须为正数：' + k);
  for (const k of ['perProjectUsd', 'nftMaxUsd']) if (units(p[k], 6) <= 0n || units(p[k], 6) > units('20', 6)) throw new Error('单项目预算必须在 0～20U 之间：' + k);
  if (units(p.nftMaxUsd, 6) > units(p.perProjectUsd, 6)) throw new Error('NFT 预算不能高于单项目预算');
  if (units(p.globalDailyBnb) > units('1') || units(p.maxGasBnb) > units('0.01')) throw new Error('个人版预算超过支持范围');
  if (!Number.isFinite(Number(p.maxSlippage)) || Number(p.maxSlippage) <= 0 || Number(p.maxSlippage) > 10) throw new Error('滑点需在 0～10% 之间');
  if (!Number.isSafeInteger(p.receiptWaitSeconds) || p.receiptWaitSeconds < 1 || p.receiptWaitSeconds > 180 || !Number.isSafeInteger(p.confirmations) || p.confirmations < 2 || p.confirmations > 20) throw new Error('确认参数无效');
  const seen = new Set(), names = new Set();
  for (const w of input.wallets || []) { w.address = addr(w.address); if (seen.has(w.address) || names.has(w.name) || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(w.name || '')) throw new Error('钱包名称／地址无效或重复'); seen.add(w.address); names.add(w.name); }
  if (!seen.size) throw new Error('请先运行一键配置，填写自己的 .ai 钱包');
  return p;
}
export function ownerMessage(message, telegram) {
  const chat = String(telegram?.chatId || ''), owner = String(telegram?.controlUserId || (/^\d+$/.test(chat) ? chat : ''));
  return Boolean(owner && String(message?.chat?.id) === chat && String(message?.from?.id) === owner && !message.from.is_bot);
}
