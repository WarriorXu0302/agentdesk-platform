# ADR-0058: 沙箱运行时可扩展性 — OCI 旋钮 + 成文接缝契约

- **状态**:Accepted
- **日期**:2026-08-18
- **关联**:服务化产品方向(用户 2026-08-18:"开箱即用服务、并发可能很重、容器这部分会换,可扩展即可");
  2026-08 编排/沙箱两轮调研;ADR-0053×0054(boot-blocking 配置错误的教训)

## Context

产品方向定为**开箱即用的服务**,容器运行时将来要换(目标未定:可能是 gVisor/Kata 的隔离升级,
可能是 Firecracker 池的密度/冷启动,也可能是云沙箱 API 的托管形态)。用户对抽象层的要求是
"**可扩展即可**"——不预设目标,不过度设计。

依赖面盘点(2026-08-18):

- **已经可换的**:运行时二进制(`CONTAINER_RUNTIME` env,docker/podman/nerdctl 同 CLI 语法);
  stop/info/ps/孤儿清理已集中在 `container-runtime.ts`(其自述章程:"换运行时=改一个文件")。
- **真正的耦合只有两样**:
  1. **CLI 参数语法**(`run --rm --name/--memory/--cpus/--network/-v/...`,散布于
     container-runner 的 args 构建器)——所有 OCI CLI 共享同一语法,故这层耦合对
     podman/nerdctl/gVisor/Kata **均不构成障碍**;
  2. **bind mount**(三库单写者靠宿主↔容器共享每会话 SQLite 文件)——这是平台命根子。
     Kata 经 virtio-fs 透明兼容;**云沙箱没有宿主文件系统,会打断此契约**。

## Decision

> 两档可扩展路径:**第 1 档(本 ADR 实现)**——OCI 运行时成为纯配置;
> **第 2 档(成文契约,第二个实现落地时才写代码)**——provider 接口边界在此声明。

### 第 1 档:OCI 运行时旋钮(已实现)

- 宿主级:`CONTAINER_OCI_RUNTIME` env(如 `runsc`、`kata-runtime`)→ `docker run --runtime=<v>`。
- 组级覆盖:`container.json` 新增 `ociRuntime` 字段——让运营者只对跑不可信代码的 worker
  组上 gVisor/Kata,不动其余舰队。优先级:组级 > 宿主 env > 引擎默认(runc)。
- **失败安全**:非法值(不匹配 `[a-zA-Z0-9_.-]+`)降级为"未设置"+ 警告,**绝不阻断 spawn**
  ——boot-blocking 配置错误会变成静默 60s 重试环(ADR-0053×0054 教训,ADR-0056 红队实证)。

由此,隔离升级(gVisor 用户态内核 / Kata microVM)= 装好运行时 + 一行配置,零代码。

### 第 2 档:provider 接口边界(成文,不实现)

将来接**非 OCI-CLI** 形态(Firecracker 直驱、云沙箱 API)时,provider 必须实现的语义面
(即今日 `container-runtime.ts` + args 构建器共同承担的职责):

1. **spawn**(输入:容器名、镜像、mounts、env、network 模式、资源上限、install 标签;
   语义:前台进程句柄,退出即会话执行器结束);
2. **stop**(有界超时,幂等);
3. **liveness**(按 install 标签枚举存活实例——孤儿清理依赖它);
4. **runtime 健康检查**(启动前置);
5. **mounts 契约**:必须提供宿主目录↔沙箱的双向文件可见性(bind mount 或等价物如
   virtio-fs)。**做不到的 provider(云沙箱)= 三库通道需网络化**——该改造与多机扩展
   (并发第 2 级)是**同一笔投资**,届时一并设计,不在本 ADR 预支。

### 不做什么

- **不引入只有一个实现的 provider registry/interface**——单实现的接口只是间接层
  (与本仓一贯的反过度设计立场一致);第二个实现落地时,按上面的语义面提炼接口,
  届时的重构面已被本 ADR 圈定。
- 不动 args 构建器的位置:env/mount 组装是平台逻辑而非运行时逻辑,搬家只有搬动成本。

## Consequences

- gVisor/Kata/podman/nerdctl:**今天就是配置题**;调研中"隔离原语最弱"的差距有了零代码补法。
- 换更远的形态(Firecracker 池/云沙箱)的重构面**有了成文边界**,不再靠考古。
- `ociRuntime` 配错不会造成不可启动的组(失败安全)。
- 诚实边界:本 ADR 不改变隔离现状(默认仍 runc);上 gVisor/Kata 是运营者动作。

## 验证

- `container-runtime.test.ts`:缺省无 flag / env 选择 / 组级覆盖优先 / 非法值降级+警告(注入样式串)。
- `container-config.test.ts`:`ociRuntime` round-trip 与非法值降级为 unset。
- 全套本地 CI + 真实 CI 双 job。
