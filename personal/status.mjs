import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const file = resolve(import.meta.dirname, '../data/personal-orders.json');
if (!existsSync(file)) console.log('尚无本地订单记录。');
else {
  const state = JSON.parse(readFileSync(file, 'utf8'));
  console.log(JSON.stringify(Object.values(state.reservations || {}).map(r => ({ id: r.id, wallet: r.wallet, kind: r.kind, status: r.status, project: r.project, txHash: r.txHash, orderId: r.orderId, spentBnbWei: r.spentBnbWei, reservedBnbWei: r.reservedBnbWei })), null, 2));
}
