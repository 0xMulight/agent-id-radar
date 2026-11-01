// 登入 config.json 裡第 N 個錢包（預設第 1 個）：node login.mjs 2
// 會印出登入連結，用該錢包的幣安 App 手機點開確認（約 5 分鐘內有效）
import { cliRunner } from './personal/wallet.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(readFileSync(join(DIR, 'config.json'), 'utf8'));
const wc = CONFIG.wallets[(Number(process.argv[2]) || 1) - 1];
if (!wc) { console.error('找不到這個錢包'); process.exit(1); }
const run = cliRunner(wc, DIR);
const si = await run(['auth', 'signin']);
const d = si.j?.data; if (!d?.qrCodeId) { console.log(si.t); process.exit(1); }
console.log(`\n[${wc.name}] 用手機打開這個連結確認登入：\n${d.urlForWeb}\n配對碼：${d.pairingCode}\n等待確認中…`);
const v = await run(['auth', 'verify', '--qrCodeId', d.qrCodeId], 330000);
console.log(v.j?.data?.status === 'SUCCESS' ? '✅ 登入成功' : '❌ ' + v.t.slice(0, 300));
