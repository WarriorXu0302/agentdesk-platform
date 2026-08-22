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
然后各 delivery-action 处理器自行取字段。**契约实际上不存在**,存在的是若干处
保真度各异的读法。断言不是检查——`content.apt as string[]` 对一个数字载荷照样
编译通过,而运行时 TypeScript 已经不在场了。

准确的分布(初版写的"11 个处理器各自 cast"是错的;下面的数字由复核用运行时探针
逐个注册 action 数出来,并对 git 对象而非工作树 grep 过):

共 **14 个已注册 action**。用类型断言取字段的只有 **scheduling 的 5 个**
(`actions.ts` 14 处)和 **`create_agent`**(3 处),合计 **6 个 action**。
其余各自本来就读得住:`roster.invite` 用 `typeof content.member === 'string'` 守卫;
`classify_intent` / `escalate` / `routing_feedback` / `gateway_audit` 走闭集强制函数
(`toAction` / `coerceUrgency` / `coerceFeedbackKind` / `toStatus`);
`provider_error` 根本不读 `content`。

(我第一次数的时候把 `roster-invite.ts` 也算成了 cast——那是按目录统计的副作用,
`src/` 目录下的 cast 其实主要来自 `delivery.ts` 自己。复核纠正了这一点。)

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
   注意这条**只对 `__proto__` 成立**:`constructor` 与 `prototype` 作为普通字符串键
   就是普通自有属性,序列化正常(同样实测过)。它们一并被拒的理由更窄——
   这些名字在本契约里从不是合法业务字段,放行意味着每个用 `in` / `for...in` /
   裸属性读遍历该对象的下游都得自己考虑遮蔽问题。拒三个名字成本为零,
   审计每个下游成本很高。初版代码注释把 `__proto__` 的理由套给了三个键,是错的。

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

1. **`src/outbound-contract.ts` 是交付路径上唯一的解码点。** 交付层在分发前调用
   `parseOutboundContent`,此后所有处理器拿到的一定是:一个普通对象、
   不含原型改写键、在体积与深度上界内。
   初版写的是"唯一解码点",**不准确**:`kind='llm-usage'` 的行在 `deliverMessage`
   之前就被 `markDelivered` 短路掉了,从不经过契约;`host-sweep.ts` 另有一处
   `JSON.parse` 专门累计 token 用量。那处读法本身是收紧的(try/catch + 只接受
   `typeof totalTokens === 'number'`),但它确实在契约之外,所以这里把范围说准。
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
  - 深度上界(12)与体积上界(4 MiB)当初是拍脑袋定的。**复核补上了实测**:
    对 runner 全测试套件(394 项)插桩,抓取真实执行过的 **138 条
    `INSERT INTO messages_out`** 载荷全部过一遍 `parseOutboundContent`——
    **0 条被拒**,实测最大嵌套深度 **2**(上界 12),最大体积 **515 字节**
    (上界 4 MiB,约 8000 倍余量)。附件不走内联(`send_file` 只写文件名,
    a2a 委派用 `includeAttachments:false`),所以 4 MiB 不可达。
    余下未被证否的一种形状是 CLI 通道上极大累积批的 `formatMessages` 输出,
    复核未能构造出达到 4 MiB 的实例,故不作为已知风险列出。
  - 校验器是手写的。它没有 schema 库的表达力,复杂形状(嵌套对象数组)
    仍需处理器自己判。

- **Neutral / Trade-offs**
  - **14 个 action 里只迁移了 2 个**(`install_packages`、`add_mcp_server`),
    外加交付层里 `questionId` 一处(它是 `pending_questions` 的主键,
    类型错会写入一个任何回调都匹配不上的键)。**剩下 12 个未迁移**,
    其中真正还在用类型断言的是 **scheduling 的 5 个 + `create_agent`,共 6 个**
    (17 处 cast);其余 6 个本来就有 typeof 守卫或闭集强制函数。
    未迁移的处理器现在拿到的至少是结构合法的对象,但字段级保真度未变。
    这是**已知的未完成部分**,不是"已覆盖"。
    (初版写"11 个处理器 / 其余 9 个未迁移",两个数字都错,复核纠正。)
  - **`delivery.ts` 自身也还留着四处 cast**,它们在分发层而不在处理器里,
    一并点名以免被"处理器已覆盖"的说法盖过去:`content.title`、`content.options`
    (:697-698,已有 `Array.isArray` 兜底)、`content.action`(:1280,取不到只会
    落到"未知 action"分支)、以及 **`content.files as string[]`(:746),
    它直接喂给 `readOutboxFiles`**——这一处的字段级保真度最值得下一轮先看。
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
- 上游 ADR:ADR-0016(出站投递韧性——超时/退避重试/死信)、
  ADR-0019(三处 fail-open 收紧为 fail-closed,审批卡片的 operator 闸即出自此)、
  ADR-0023(名册定向私聊的宿主同意闸)、
  ADR-0055(per-user 状态作用域)
- 验收(红先,逐条实测,不是"看起来会红"):
  - self-mod 14 项里 **13 项在旧实现下变红**;剩下 1 项是"非拉丁文本仍可用"的
    **非回归守卫**,旧实现下本就该绿,绿了才对。
  - 交付层 3 项里 **2 项变红**;第 3 项是"合法载荷仍走正常路径"的非回归守卫。
  - 13 项里 **12 项红在断言本身**,收到的字符串证明旧代码确实为 `__proto__` 名、
    数字包名、含换行的名字弹出过审批卡;剩下 1 项("非数组 apt")红在
    `TypeError: apt.find is not a function`——即它所描述的那个崩溃本身。
    初版 ADR 笼统写成"全部红在断言而不是崩溃",不准确。
  - 一处断言在写的时候是错的,被测试自己纠正了:契约违规时适配器确实被调用了一次,
    但内容是宿主给等待中的用户发的"投递失败"告知,不是那个被拒的载荷。
    断言已改为"被拒载荷从未上链路 + 恰好一条告知"。

## References

- LangGraph 工程实践对标(本轮 `/loop` 的调研输出):"在信任边界上一次性校验,
  而不是让每个消费者各自转换"
- 实测记录:`cfg.mcpServers["__proto__"] = {...}` → `Object.keys` 为空、
  `JSON.stringify` 为 `{"mcpServers":{}}`、`Object.prototype` 未被污染
- `/^[a-z0-9][a-z0-9._+-]*$/.test(123) === true`(测试中已固化为断言)

## 合并前对抗性复核发现的四个洞(均已修,并各自补了红先守卫)

四路独立 lens + 逐条反驳。**初版在它声称已关闭的那条性质上仍有真洞**——
下面前三条都是"卡片可被伪造",而那正是本 ADR 的主张。

1. **`env` 的值从未过字符集校验(最高危)。** `readStringRecord` 当初只有
   `keyPattern`,**没有 `valuePattern`**——我写这个读取器时就没写。于是唯一一个
   未经校验就进入审批卡片的 agent 可控字符串,恰好是最可能承载载荷的那个。
   三路 lens 独立命中同一处。**修**:读取器补 `valuePattern`,self-mod 传入
   `SAFE_TEXT_RE`。
2. **反斜杠没被拒,而渲染器会在校验之后重写字符串。** `normalizeCardText` 会把
   两字符序列 反斜杠+n 折成真换行(它存在的目的就是让模型误输出转义时仍可读)。
   所以只拒真控制字符是不够的:含这两个字面字符的值能通过校验,然后在审批人屏幕上
   变成新的一行。而我原来那条"拒绝换行"的测试用的是**真换行**,那本就被
   `\p{Cc}` 挡住,所以它从未触及这条路径。**修**:字符集直接拒反斜杠——
   这样就不依赖于"追踪该 helper 当前展开哪些转义",而 Linux 容器里合法的
   MCP command/arg/env 值也不需要反斜杠。
3. **卡片抬头里的 agent 组名是 agent 可控的。** `create_agent` 本身就是一个
   容器可调用的 delivery action,而它把容器给的 `name` **原样落库**
   (只有 `folder` 被规范化)。于是容器可以先造一个"名字就是伪造文案"的组,
   再从该组发起 self-mod——整张卡片抬头被伪造,且**完全绕过本 ADR 校验的所有字段**。
   **修**:`create-agent.ts` 在源头拒绝此类名字;卡片侧另做**清洗**(不是拒绝)
   ——已落库的历史名字不该让一个本身合法的请求失败。
4. **新计数器用容器书写的 `kind` 做标签。** 无界基数:被攻陷的 runner 用随机
   `kind` + 一字节违规载荷,就能在宿主内存注册表里无限增生时间序列,
   顺带把这个指标本来要提供的信号淹掉——而这发生在一个主题就是"不信任那一侧"的改动里。
   **修**:收敛到闭集,未知归入 `other`;精确值本来就在结构化日志里,诊断力无损。

另外三条更正而非漏洞:`__proto__` 的理由被错误套用给了另两个键;容器/宿主
"镜像"的漂移后果在注释里写反了(此前是**容器更严**,于是宿主的洞被一个通过的
工具调用掩盖住了);以及上面已逐条改掉的数字与范围表述。

**复核同时给出的正面结论**(不是我自己声称的):138 条真实载荷 0 拒;
附件不走内联所以体积上界不可达;宿主/容器规则逐字段比对只有顺序差异;
死信分支非空转(移除即红);self-mod 的严格化是**软拒绝**(notifyAgent + 正常
markDelivered),不是消息丢失。

**已知的人机工程代价**:`reason` 里的反引号会被拒,而模型写散文时很爱用反引号。
这是软拒绝,agent 会被告知确切原因,且容器侧镜像在工具调用当场就报错——
代价是一次往返,不是一条消息。若这在实际使用中太吵,正确的解法是把 `reason`
移出围栏单独渲染,而不是放宽字符集。
