import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { profile } from './profile.mjs';
const root = resolve(import.meta.dirname, '..'), file = join(root, 'config.json'), args = process.argv.slice(2);
try {
  if (args.some(a => a !== '--execute')) throw new Error('启动参数仅支持 --execute');
  if (!existsSync(file)) throw new Error('请先双击「一键安装.bat」填写钱包配置');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.personal = { ...(config.personal || {}), mode: args.includes('--execute') ? 'live' : 'observe' };
  const p = profile(config, args);
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  console.log('Agent ID Radar · 上游完整版个人配置\n模式：' + p.mode + '\n所有钱包新增参与日预算：' + p.globalDailyBnb + ' BNB 等值\n每钱包每项目累计：' + p.perProjectUsd + 'U；付费 NFT：' + p.nftMaxUsd + 'U\n回本后剩余数量的 20% 长抱；停止请关闭窗口或创建 WATCH_STOP 文件。');
  const child = spawn(process.execPath, [join(root, 'watch.mjs'), ...args], { cwd: root, stdio: 'inherit', shell: false });
  child.on('error', e => { console.error(e.message); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
} catch (e) { console.error(e.message); process.exitCode = 1; }
