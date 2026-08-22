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
  - ~~**14 个 action 里只迁移了 2 个**~~ **已补完(见文末"迁移收尾")。**

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

### 一条关于我自己的更正

复核期间某个 agent 在工作树里留下了 `src/modules/self-mod/zz-redteam.test.ts`。
我的 `git add -A` 把它扫进提交,CI 的 format 门拦下,我就把它删了,
并在提交信息(`6c310ef`,已随 squash 进入 main)里写:
"它是已在本提交内的文件的逐字副本,删掉不损失任何东西。"

**那句话是错的。** 那个文件不是副本,它多了两个我没有的断言:

```
it('env value with backticks + newline escapes the disclosure fence')
it('env value with a bidi RLO override reaches the card')
```

也就是说,**一个审查 agent 把命名了本 ADR 最严重那个洞的失败测试直接放在了我面前,
而我没有跑它就删了**——理由还是我自己编的"重复"。如果当时跑一次,env 那个洞会早一个
小时被发现。CI 之所以拦下它,是因为格式,不是因为它红了。

规矩:**agent 留在树里的测试,删之前先跑。它的失败可能就是结论本身。**
(已在当前 main 上复跑那两条:2/2 通过,洞确已堵住。)

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

## 迁移收尾(2026-08-23,同日后续 PR)

初版把"只迁移了 2 个 action"列为已知未完成。现在做完了:

- **已迁到严格读取器的 action:8 个**——`install_packages`、`add_mcp_server`
  (本 ADR),加上 scheduling 的 5 个与 `create_agent`。
- **其余 6 个本来就读得住**,复核逐个确认过:`roster.invite` 用 `typeof` 守卫,
  `classify_intent` / `escalate` / `routing_feedback` / `gateway_audit` 走闭集
  强制函数,`provider_error` 不读 `content`。
- 所以 **14 个 action 现在全部按类型读**,没有剩余的裸 cast。

scheduling 那批的 cast 不是装饰:非字符串 `taskId` 会落一个后续 cancel/pause/resume
**再也寻址不到**的行(任务既不会执行也无法取消,且无人报错);非字符串 `processAfter`
被 SQLite `datetime()` 比较强制转换成"永不触发"或"立即触发";
`platformId`/`channelType` 决定被唤醒的消息投到哪。`update_task` 是部分更新语义
(缺省=不动,显式 null=清空),此前**类型不对的字段被静默跳过而调用仍报成功**;
现在整条更新拒绝——半应用的更新等于 agent 以为自己改了而实际没改。

`create_agent` 的 `instructions` 会被直接写成 `groups/<folder>/instructions.md`
(新 agent 的角色提示词),即容器可以在宿主磁盘上写文件——现在有类型与 64 KiB 上限。

### 一处"看着像洞、实测不是"的:`content.files`

初版 ADR 把 `content.files as string[]` 点名为"下一轮先看的字段级缺口",
理由是它直接喂给读文件的 `readOutboxFiles`。**动手改完才发现理由是错的**:
`isSafeAttachmentName`(`attachment-safety.ts`)第一行就是
`typeof name !== 'string'`,所以非字符串元素被跳过,既不会被强制转换也不会拼进路径。
实测方法是给测试**真的建出** outbox 目录(否则 `readOutboxFiles` 提前返回,
根本走不到那段代码——我第一版测试就是这样,红得莫名其妙),然后投递
`files: ['ok.txt', 123]`:未迁移的代码**正常投递**,带上那个合法附件。

于是这处**保持 cast 不变**,并把理由写进代码注释。收紧它会把优雅降级换成更差的结果:
一个坏文件名会让**整条用户可见的回复**被死信,而不是只丢掉一个附件。

### 仍未覆盖的一层:通道适配器

迁移过程中点出的新残留——**出站内容在分发之后还会被通道适配器再读一遍**,那一层仍是 cast:
`src/channels/chat-sdk-bridge.ts` 约 10 处(`messageId` / `text` / `markdown` /
`emoji` / `questionId` / `title` / `question` / `options` / `card` / `fallbackText`)、
`src/channels/feishu/primitives.ts` 2 处(`fallbackText`)、
`src/modules/permissions/index.ts` 1 处(`author`)。
其中 `messageId` 被送进 `adapter.editMessage` / `addReaction`,是最值得先看的。
这是下一层,不在本 ADR 范围。
