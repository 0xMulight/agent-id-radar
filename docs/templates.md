# 本地审核模板

templates 默认为空。未知项目被发现后只记录／提醒，不自动进入审核名单。

模板由使用者在本地配置文件中维护。不要从项目公告、TG 群消息、NFT 元数据或外部 JSON 自动导入并标记为已审核。

## 支持范围

- free-fixed／free-count：付款为零，固定 calldata。
- bnb-fixed：固定 BNB 付款、固定 calldata。
- usdt-fixed：固定 USDT 支付；只授权本次额度，余额不足不自动换币。
- 支持预期 ERC20 或免费 ERC721；ERC1155、付费 NFT 自动参与关闭。

“固定调用”意味着数量、收货人和参数已经按实际 ABI 审核。程序不猜测参数，不扫描字节后盲目替换地址。mint(uint256) 调用同样需要提供明确编码。没有自动调整份数或邀请参数的适配器。

## 关键字段

| 字段 | 要求 |
| --- | --- |
| contract／asset／assetType | 实际铸造合约、预期收货资产及其标准 |
| identity／assetIdentity | inspect 输出的 sha256 代码身份；包含解析到的代理／实现／Beacon 组件 |
| calldata | 审核后的完整调用数据，选择器必须在受支持的 mint 方法集合中 |
| minAssetQty | 预期最小实际收货数量，以代币最小单位表示 |
| review.note／expiresAt | 审核范围、依据、明确失效时间；不能留空 |
| progress.soldSelector／capSelector | 经 ABI 确认的零参数计数函数，不能根据名字猜测含义 |
| invariants | 关键权限／税率／交易开关的只读调用及预期原始返回值；变化后停止参与 |
| poolReview.noOtherDex | 首版不能全面检测其他 DEX，需要本地人工核实；此声明无法自动保证将来不会新建其他池 |
| maxPayment | 付费模板的固定付款上限，字符串；BNB 和 BSC USDT 都按 18 位小数处理 |
| refund.reviewed | 已审核真实退款流程及管理员权限；单独设置 true 不能自动构成安全证明 |
| refund.escrow | 实际退款资金所在地，包括可验证的托管账户 |
| refund.liabilitySelector | 合约中已经承担的同币种退款总负债，uint256；语义必须人工核实 |
| refund.deadlineSelector | 实际退款期限，Unix 秒时间戳；不能混淆募集期和退款申请期 |
| allowPaidHeatFallback | 默认为 false；只有完整审核后，才可以为未知进度的付费模板启用 |

退款余额／期限检查是已审核业务语义的运行时复核，不能判断虚假的函数返回值是否诚实，不能防止被遗漏的管理员提款能力。

## 不通过检查时

- 代码或权限变化：停止新增自动付款，保留事件与警报。
- 读不到进度：免费可以使用人数信号；付费要满足额外的本地审核条件。
- USDT 已有宽泛授权：先在官方钱包核实并撤销，避免继承旧授权。
- 无法确认其他 DEX 池子、退款条款或预期资产：只观察，不通过手动 force 参数绕过。

请保留配置在本地。不要提交真实钱包登录目录、请求 ID、TG Bot Token 或会话文件。
