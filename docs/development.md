# 开发与验证

使用 Node.js 内置模块，没有第三方 npm 运行时依赖。

~~~sh
npm test
npm run check
npm run demo
~~~

| 模块 | 职责 |
| --- | --- |
| scanner.mjs／rpc.mjs | 只读 BSC 扫描、回执确认、代理代码身份与受限 V2 报价 |
| entry-schedule.mjs | 有界并发的快速／普通／不活跃检查队列，不改变入场条件 |
| market.mjs | 可选的固定公开池子收录观察，只提醒或否决新参与，不提供交易报价 |
| guard.mjs | 进场条件、交易计划绑定、授权／资产变动检查 |
| ledger.mjs／store.mjs | 预算预占、北京时间日切、订单日记、单进程锁和钱包队列 |
| planner.mjs | 审核模板固定调用、精确授权、带 minOut 的 V2 卖出计划 |
| executor.mjs／baw.mjs | 唯一广播网关、官方 CLI 预演、签名封装检查与回执对账 |
| positions.mjs | 交易仓和底仓、真实回本、固定分批目标、提醒及退出决策 |
| runtime.mjs | 扫描、进场、持仓、回执、退款提醒的独立周期 |
| replay.mjs | 有明确假设的合成场景，不声称真实历史回测 |

## 交易状态

reserved → broadcasting → pending → confirmed／failed。

广播结果未知时进入 unknown。unknown、broadcasting、pending 都持续占用钱包和预算；跨日和重启不释放。没有交易 hash 的未知请求需要人工核对官方钱包，不能靠超时自动清空。

如果发生回执不匹配、没有收到预期资产、额度或状态异常，应保留状态和本地日志。不要通过删除 data 文件夹“解除锁定”。

## 实盘协议验证清单

当前测试中的钱包和链上回执均为 mock。本版尚未验证任何真实用户的钱包。

1. 确认官方 CLI 的 JSON 字段和数值单位，特别是 simulationResult、allowanceChanges、transactionRequest。
2. 确认 requestId 绑定的交易封装、签名 sender／to／value／data／chainId／nonce 与最高 Gas。
3. 确认请求执行后返回实际交易 hash，及交易回执在 BSC 上的组织方式。智能账户／打包交易需独立的回执证明适配器。
4. 缺失封装或证据字段时维持拒绝状态，不能把验证改成默认 true。
5. 只有使用者另外明确授权后的受控金额测试才能验证真实广播，本次开发不包含该步骤。

## 状态与移植

使用独立 data/guard-state.json。不要直接把上游状态改名放入。本版没有自动迁移旧成本记录，外部转入或补铸时会标记 needsReview，避免重复回本或重置底仓。

真实订单和钱包会话不进入测试夹具或 Git。模拟测试在内存／临时目录运行。新增适配器时必须同时覆盖收货、授权对象、最高支出、签名封装、失败／未知状态和回执对账。

beta.2 兼容原配置：新增选项会补入默认值，观察 API 默认关闭。原状态保留；旧观察记录没有 isAgent=true 证明时不用于热度，等待新的成功交易重新积累，不释放任何未确认预算。调度状态只存内存，重启只会重排只读检查，不会重置仓位和订单。
