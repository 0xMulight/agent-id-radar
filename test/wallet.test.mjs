import test from 'node:test';
import assert from 'node:assert/strict';
import { simulationPlan } from '../personal/wallet.mjs';
import { fixture, simulation, previewArgs, W, C, T, OTHER, ZERO, HASH, NATIVE, USDT, TRANSFER, topic, word, units, log } from './helpers.mjs';
const execute = ['contract-call', 'execute', '--requestId', 'bound'];
const sale = ['market-order', 'swap', '--binanceChainId', '56', '--fromToken', T, '--toToken', NATIVE, '--fromTokenQty', '1'];
test('observation blocks both contract execution and SDK swaps without sending', async () => {
  const f = fixture({ personal: { mode: 'observe' } }); await f.run(previewArgs());
  await assert.rejects(f.run(execute), /观察模式/); await assert.rejects(f.run(sale), /观察模式/);
  assert.equal(f.sends(), 0); assert.equal(f.ledger.records().length, 0);
});
test('execute requires a current successful preview bound to this wallet', async () => {
  const f = fixture(); await assert.rejects(f.run(execute), /没有匹配/); await f.run(previewArgs()); f.advance(91000);
  await assert.rejects(f.run(execute), /过期/); assert.equal(f.sends(), 0);
});
test('complete simulation accepts paid NFT without refund or per-project templates', async () => {
  const s = simulation(); s.balanceChanges[1] = { owner: W, contractAddress: T, tokenType: 'Erc721', change: '1' };
  const nft = { address: T, topics: [TRANSFER, topic(ZERO), topic(W), '0x' + word(1)], data: '0x' };
  const f = fixture({ sim: s, receipt: { logs: [nft] } }); await f.run(previewArgs());
  const r = await f.run(execute); assert.equal(r.j.data.status, 'CONFIRMED'); assert.equal(f.ledger.records()[0].nft, true);
});
test('paid NFT participation retains its smaller cumulative budget', async () => {
  const s = simulation(); s.balanceChanges[0].change = '-' + units('0.01'); s.balanceChanges[1].tokenType = 'Erc721';
  const f = fixture({ sim: s }); await f.run(previewArgs(String(units('0.01'))));
  await assert.rejects(f.run(execute), /累计/); assert.equal(f.sends(), 0);
});
test('unexpected existing token debit, account delegation and incomplete previews cannot execute', () => {
  const s = simulation(); s.balanceChanges.push({ owner: W, contractAddress: OTHER, change: '-1' });
  assert.throws(() => simulationPlan(s, previewArgs(), W, 700000000n), /已有资产/);
  assert.throws(() => simulationPlan(simulation({ authorityChanges: [{}] }), previewArgs(), W, 700000000n), /权限/);
  assert.throws(() => simulationPlan({ balanceChanges: [] }, previewArgs(), W, 700000000n), /完整/);
});
test('exact USDT approval is separate and unlimited approval cannot broadcast', async () => {
  const amount = (1n << 256n) - 1n, data = '0x095ea7b3' + C.slice(2).padStart(64, '0') + word(amount);
  const s = simulation({ balanceChanges: [], allowanceChanges: [{ spender: C, tokenContract: USDT, newAllowance: String(amount) }] });
  const args = previewArgs('0', data); args[args.indexOf('--to') + 1] = USDT;
  const f = fixture({ sim: s }); await f.run(args); await assert.rejects(f.run(execute), /授权超过/); assert.equal(f.sends(), 0);
});
test('wrong chain fails before a transaction is sent', async () => {
  const f = fixture({ chain: '0x1' }); await f.run(previewArgs()); await assert.rejects(f.run(execute), /BSC/); assert.equal(f.sends(), 0);
});
test('confirmed contract receipt accounts exact Gas and real asset delivery', async () => {
  const f = fixture(); await f.run(previewArgs()); const r = await f.run(execute);
  assert.equal(r.j.data.status, 'CONFIRMED'); const record = f.ledger.records()[0];
  assert.equal(record.status, 'confirmed'); assert.equal(record.gasWeiActual, '21000000000000'); assert.equal(record.spentBnbWei, '1021000000000000');
});
test('concurrent same-wallet execution cannot broadcast the same preview twice', async () => {
  const f = fixture(); await f.run(previewArgs()); const results = await Promise.allSettled([f.run(execute), f.run(execute)]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1); assert.equal(f.sends(), 1);
});
test('missing receipt, reorganization and App confirmation stay unknown with funds reserved', async () => {
  for (const options of [{ noReceipt: true }, { reorg: true }, { pendingApp: true }, { transportFailure: true }]) {
    const f = fixture(options); await f.run(previewArgs()); await assert.rejects(f.run(execute), /結果不明/);
    assert.equal(f.ledger.records()[0].status, 'unknown'); await f.run(previewArgs()); await assert.rejects(f.run(execute), /結果不明/); assert.equal(f.sends(), 1);
  }
});
test('a receipt with missing expected delivery does not become a successful mint', async () => {
  const f = fixture({ receipt: { logs: [] } }); await f.run(previewArgs()); await assert.rejects(f.run(execute), /收货待核对/); assert.equal(f.ledger.records()[0].status, 'unknown');
});
test('reverted transactions charge real Gas without charging successful principal', async () => {
  const f = fixture({ receipt: { status: '0x0', logs: [] } }); await f.run(previewArgs()); const r = await f.run(execute);
  assert.equal(r.j.success, false); assert.equal(f.ledger.records()[0].status, 'failed'); assert.equal(f.ledger.records()[0].spentBnbWei, '21000000000000');
});
test('market orderId alone is not success; pending orders are polled to FINISHED', async () => {
  const f = fixture({ pendingPolls: 2, receipt: { logs: [log(T, W, C, units('1'))] } });
  const r = await f.run(sale); assert.equal(f.polls(), 3); assert.equal(r.j.data.status, 'CONFIRMED'); assert.equal(r.j.data.actualReceived, '0.02');
  const sent = f.calls.find(a => a[0] === 'market-order' && a[1] === 'swap');
  assert.equal(sent[sent.indexOf('--mev') + 1], 'true'); assert.equal(sent[sent.indexOf('--slippage') + 1], '3');
});
test('FAILED market orders are not reported as completed sales', async () => {
  const f = fixture({ market: { status: 'FAILED', txHash: null } }); const r = await f.run(sale);
  assert.equal(r.j.success, false); assert.equal(f.ledger.records()[0].status, 'failed');
});
test('partial fills, refunds, missing income and permanently pending orders remain locked', async () => {
  for (const options of [{ receipt: { logs: [log(T, W, C, units('0.5'))] } }, { market: { refund: [{ amount: '0.001' }] }, receipt: { logs: [log(T, W, C, units('1'))] } }, { market: { toTokenActualQty: undefined }, receipt: { logs: [log(T, W, C, units('1'))] } }, { market: { status: 'PENDING' } }]) {
    const f = fixture(options); await assert.rejects(f.run(sale), /結果不明/); assert.equal(f.ledger.records()[0].status, 'unknown');
  }
});
test('conversion funds become wallet USDT and are not counted again as project principal', async () => {
  const f = fixture({ market: { fromToken: NATIVE, toToken: USDT, fromTokenQty: '0.01', toTokenActualQty: '7' }, receipt: { logs: [log(USDT, C, W, units('7'))] } });
  await f.run(['market-order', 'swap', '--binanceChainId', '56', '--fromToken', NATIVE, '--toToken', USDT, '--fromTokenQty', '0.01']);
  assert.equal(f.ledger.records()[0].spentBnbWei, '21000000000000');
  f.setSim(simulation({ balanceChanges: [{ owner: W, contractAddress: USDT, change: '-' + units('7') }, { owner: W, contractAddress: T, tokenType: 'Erc20', change: '1000' }] }));
  f.receipt.logs = [log(USDT, W, C, units('7')), log(T, ZERO, W, 1000)];
  await f.run(previewArgs('0')); await f.run(execute);
  const total = f.ledger.records().reduce((s, r) => s + BigInt(r.spentBnbWei), 0n); assert.equal(total, 10042000000000000n);
});
test('unexpected extra USDT payment updates held cost and pauses reconciliation', async () => {
  const s = simulation({ balanceChanges: [{ owner: W, contractAddress: USDT, change: '-' + units('7') }, { owner: W, contractAddress: T, change: '1000' }] });
  const f = fixture({ sim: s, receipt: { logs: [log(USDT, W, C, units('8')), log(T, ZERO, W, 1000)] } }); await f.run(previewArgs('0'));
  await assert.rejects(f.run(execute), /USDT 扣款超过/); assert.equal(f.ledger.records()[0].status, 'unknown'); assert.ok(BigInt(f.ledger.records()[0].reservedBnbWei) > units('0.011'));
});
