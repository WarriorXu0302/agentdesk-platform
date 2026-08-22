# ADR-0063: 容器→宿主出站边界契约,以及"审批卡片必须展示将被执行的全部内容"

- **Status**: Accepted
- **Date**: 2026-08-23
- **Decider(s)**: 仓库所有者(拍板);coding agent(提案 + 执行 + 自审)
- **Tags**: `security`, `trust-boundary`, `approvals`, `delivery`
- **Supersedes**: 无

---

## Context

三 DB 模型里,`outbound.db` 是**不受信任侧唯一的写入面**:容器写,宿主读。
`messages_out.content` 的每一个字节都由 agent 撰写。

在本 ADR 之前,宿主对这块内容的解码是这样的:交付循环里一次 `JSON.parse`,
然后 11 个 delivery-action 处理器各自 `content.x as T`。也就是说**契约实际上
不存在**,存在的是 11 处保真度各异的类型断言。断言不是检查——
`content.apt as string[]` 对一个数字载荷照样编译通过,而运行时 TypeScript 已经不在场了。

审计 `self-mod` 模块(唯一带执行后果的 action 对)时,这个缺口的具体形状暴露出来:

1. **`add_mcp_server` 的审批卡片省略了决定"到底执行什么"的两个字段。**
   卡片正文是 `Agent "X" is attempting to add a new MCP server:\n<name> (<command>)`。
   而批准后写入的是 `cfg.mcpServers[name] = { command, args, env }`。
   `command: "node"` 本身平淡无奇,`args: ["-e", "<任意代码>"]` 才是全部载荷。
   **管理员被展示的恰好是无害的那一半。** `env` 同理(`NODE_OPTIONS=--require ...`
   也是执行面,不只是密钥面)。
2. **卡片正文是 Feishu markdown,且渲染前会把转义序列展开成真实换行**
   (`normalizeCardText`,`src/channels/feishu/primitives.ts`)。所以未转义的
   agent 字符串可以在"批准"按钮旁边注入整行看起来像系统文案的内容。
3. **类型混淆能穿过名字校验。** `/^[a-z0-9][a-z0-9._+-]*$/.test(123)` 为**真**
   ——`RegExp.test` 会把参数字符串化。旧的 `content.apt as string[]` 因此把数字
   放行进入了一个最终会出现在 apt 命令行上的列表。
4. **`name: "__proto__"` 会让写入静默失效。** `cfg.mcpServers["__proto__"] = entry`
   赋的是原型而非自有属性,`JSON.stringify` 不序列化原型——**什么都没落盘,
   而管理员被通知"已添加"**。(已实测:`Object.keys` 为空,JSON 为 `{"mcpServers":{}}`。)

这里的爆炸半径不是单个会话:`updateContainerConfig(agentGroup.folder, …)` 写的是
**组级** `container.json`,即该 agent 组下**每个用户**的容器。挡在它前面的只有
一个人点一次"批准"。

需要说清楚的一点:容器侧 MCP 工具确实先做了一层校验,但容器**就是不受信任的那一侧**
——那层检查约束的是配合型 agent,不是被攻陷的 agent。宿主侧才是真正的门。

## Options Considered

- **Option A**: 只修 self-mod 的卡片。工作量最小,直接消除已确认的最高危面;
  但十一个处理器里下一个新增的仍会重犯同样的类型断言错误,契约依然不存在。
- **Option B**: 引入 zod 之类的校验库,给每个 action 声明 schema。表达力最强;
  但要在一条**信任边界**上直接架一个供应链面,而这条边界正是本文件要防守的东西;
  且需要新增依赖类别。
- **Option C**: 手写一个零依赖的边界解码器 + 严格字段读取器,在交付层做**唯一一次**
  结构准入检查,并把带执行后果的处理器迁移到严格读取器上。表达力弱于 B,
  但整份契约就一页,可以逐行审。
- **Option D**: 给 `registerDeliveryAction` 加上 per-action schema 注册钩子。
  一致性最好;但当前只有 self-mod 一个真实使用者,属于为一个用户造框架。

## Decision

> **拍板**:选 Option C,并显式驳回 D 的框架化部分。

1. **`src/outbound-contract.ts` 是唯一的解码点。** 交付层在分发前调用
   `parseOutboundContent`,此后所有处理器拿到的一定是:一个普通对象、
   不含原型改写键、在体积与深度上界内。
2. **字段读取器一律严格,绝不强制转换。** 类型不对就是拒绝,不是修复。
   先判类型再判 pattern——否则 `RegExp.test` 的字符串化会替攻击者把关。
3. **契约违规是永久失败。** 载荷的字节不会变,重试必然同样失败,
   而交付是串行的:十次无谓重试会把该会话队列里后面每一行都堵住。
   首次即死信。
4. **审批卡片必须展示将被写入的确切对象。** 不是它的投影,不是它的摘要。
   卡片展示的 JSON 与 `apply.ts` 写入 `cfg.mcpServers[name]` 的对象是同一个形状。
5. **agent 撰写的文本一律围栏包裹,能逃出围栏的字符直接拒绝而非转义。**
   排除反引号(会提前闭合围栏)、控制字符与行分隔符(会分裂出可伪造的行)、
   以及格式字符 `\p{Cf}`(双向覆盖能让**显示**与**执行**不一致)。
   规则按 Unicode 类别定义而非 ASCII 白名单,所以中文等非拉丁文本正常可用。

## Consequences

- **Positive**
  - 一处审计点取代了十一处类型断言。新处理器默认继承结构保证。
  - 关闭了一个真实的知情同意缺陷:管理员现在看得到 `args` 与 `env`,
    也被告知变更是**组级**的。
  - 关闭了类型混淆(数字包名)、原型键静默失效、卡片伪造(换行/围栏/双向覆盖)。
  - 畸形载荷不再消耗 10 次重试与队列头部。
  - 被拒的请求现在会**明确告诉 agent 哪里不对**;此前要么是通用失败,
    要么是一个 TypeError 把行死信掉且谁都没被通知。
  - 新增 `*_outbound_contract_violations_total{kind}`:非零即信号——
    要么 runner 有 bug 在静默丢弃 agent 的产出,要么有人在做这个契约要拦的事。

- **Negative**
  - 严格化会拒掉**此前能通过**的载荷。已知的行为变更:非字符串包名、
    含控制字符的 `reason`、含反引号的 command/args。这些此前要么是漏洞、
    要么是下游会崩的输入,但操作者若依赖过它们会看到新的拒绝。
  - 深度上界(12)与体积上界(4 MiB)是拍脑袋定的,没有基于生产分布测量。
    过小会拒掉合法的大附件载荷;这两个数字需要在真实流量上复核。
  - 校验器是手写的。它没有 schema 库的表达力,复杂形状(嵌套对象数组)
    仍需处理器自己判。

- **Neutral / Trade-offs**
  - **只有 self-mod 被迁移到了严格读取器**,以及交付层里 `questionId` 一处
    (它是 `pending_questions` 的主键,类型错会写入一个任何回调都匹配不上的键)。
    其余 9 个处理器仍在用类型断言——它们现在拿到的至少是结构合法的对象,
    但字段级保真度未变。这是**已知的未完成部分**,不是"已覆盖"。
  - 拒绝了 per-action schema 注册表。若迁移的处理器超过 3-4 个,
    重审这个决定。
  - `env` 的值会**原样**显示在审批卡片里。这是刻意的:管理员必须看到
    将被应用的东西才能同意。代价是 agent 若把密钥放进 `env`,该密钥会出现在
    审批 DM 的聊天记录里。取舍理由:agent 本来就已经知道那个值,
    而"批准一个看不见的值"不构成同意。若某部署认为聊天记录留存不可接受,
    应改为禁止 agent 提供 `env`,而不是把它藏起来。

## Implementation Notes

- 新增:`src/outbound-contract.ts`、`src/outbound-contract.test.ts`
- 修改:`src/delivery.ts`(边界解码 + 契约违规首次死信 + `questionId` 严格读取)、
  `src/metrics.ts`(新计数器 + `delivery_failures_total` 的 `contract` 原因)、
  `src/modules/self-mod/request.ts`(严格读取 + 全量披露卡片)、
  `container/agent-runner/src/mcp-tools/self-mod.ts`(把同一套规则镜像到工具侧,
  让配合型 agent 立刻得到反馈而不是被宿主静默拒绝)
- 新增测试:`src/modules/self-mod/request.test.ts`、`src/delivery.test.ts` 末尾的
  contract 段落
- 上游 ADR:ADR-0016(交付重试/死信)、ADR-0019(审批卡片作用域)、
  ADR-0023(同意闸)、ADR-0055(三层边界)
- 验收(红先,逐条实测,不是"看起来会红"):
  - self-mod 14 项里 **13 项在旧实现下变红**;剩下 1 项是"非拉丁文本仍可用"的
    **非回归守卫**,旧实现下本就该绿,绿了才对。
  - 交付层 3 项里 **2 项变红**;第 3 项是"合法载荷仍走正常路径"的非回归守卫。
  - 红是红在**断言本身**而不是崩溃:收到的字符串证明旧代码确实为 `__proto__` 名、
    数字包名、含换行的名字弹出过审批卡。
  - 一处断言在写的时候是错的,被测试自己纠正了:契约违规时适配器确实被调用了一次,
    但内容是宿主给等待中的用户发的"投递失败"告知,不是那个被拒的载荷。
    断言已改为"被拒载荷从未上链路 + 恰好一条告知"。

## References

- LangGraph 工程实践对标(本轮 `/loop` 的调研输出):"在信任边界上一次性校验,
  而不是让每个消费者各自转换"
- 实测记录:`cfg.mcpServers["__proto__"] = {...}` → `Object.keys` 为空、
  `JSON.stringify` 为 `{"mcpServers":{}}`、`Object.prototype` 未被污染
- `/^[a-z0-9][a-z0-9._+-]*$/.test(123) === true`(测试中已固化为断言)
