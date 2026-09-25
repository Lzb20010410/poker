# DECISIONS.md — 技术决策记录

> AI 每做一个**有取舍的技术决定**时必须在此记录。
> 目的：① 换会话/换 AI 时不会推翻已有决定 ② 用户能在里程碑验收时复核 ③ 作品集能讲出决策理由
>
> **什么算「需要记录的决策」**：有多个合理选项、且选择会影响后续工作的决定。
> 例：用哪个 GSAP 插件、状态同步怎么组织、筹码堆叠怎么渲染、配对码映射怎么实现。
> **什么不算**：变量命名、常规实现细节、规格里已经写明的东西。
>
> 最新的写在最上面。不要删除历史，若决定被推翻，在原条目下追加「已推翻」并注明新条目编号。

---

## 模板（复制这个格式追加）

```
### D-【编号】· 【一句话概括决定】

**日期**：YYYY-MM-DD　**任务**：M1.2　**决定者**：AI 自主 / 用户批准

**背景**
为什么需要做这个决定，约束是什么。

**选项**
- A：…… — 优点 / 缺点
- B：…… — 优点 / 缺点
- C：…… — 优点 / 缺点

**决定**
选了 X。

**理由**
为什么 X 在这个项目的约束下最优。要说清权衡，不要只说"X 更好"。

**影响**
这个决定后续会影响什么、如果以后要改代价多大。
```

---

## 已由用户批准的顶层决策（AI 不得推翻）

这些是项目启动前用户已确认的选型，记录在此避免 AI 反复重新评估。

### D-000 · 项目定位：朋友私局 + 求职作品集

**决定**：不做公开产品。配对码入房，无账号系统，无战绩持久化，不开放注册，不上架。

**理由**：① 中国棋牌类游戏公开运营需版号，而棋牌版号 2018 年后基本停发；② 开发者现雇主为科研院所体系，兼职合规约束高于普通互联网公司，棋牌品类观感风险更高；③ 定位作品集时，实时系统 + 复杂规则引擎 + 前端动画这三点已足够支撑技术叙事，不需要用户量。

**影响**：v1 无数据库，进程重启房间丢失（可接受，需 UI 提示）；部署走单台 VPS；任何充值/兑换/提现功能永久排除。

### D-001 · 渲染方案：DOM + React + GSAP + SVG，不用 Canvas/WebGL

**决定**：牌桌所有元素都是 HTML/SVG，动画用 GSAP。不用 PixiJS，不用 Cocos/Unity。

**备选**：PixiJS（游戏级渲染，可做粒子/光影）；Cocos/Unity WebGL（美术管线成熟）。

**理由**：DOM+GSAP 的视觉天花板足够达到「比 90% 开源 demo 好看」；手机适配靠 CSS media query 天然响应式，Pixi 需自己处理多分辨率缩放；开发者熟 React，学习成本最低；在 9h/周的预算下，Pixi 会让动画部分工时翻倍（+25-40h）。

**影响**：放弃粒子特效与动态光影。8 人满桌时 DOM 元素需控制在 ~200 以内，动画元素加 `will-change: transform` 并在结束后移除。若未来确实需要粒子效果，升级路径是给牌桌局部引入 Pixi，UI 外壳保持 React（即混合方案）。

### D-002 · 联机层：Colyseus 0.18，不用裸 Socket.IO

**决定**：用 Colyseus 做房间管理与状态同步。

**备选**：裸 Socket.IO（+15-25h，但面试可讲"自己实现了状态同步"）；Java + Spring Boot（开发者强项，但前后端类型不共享，工时最高）。

**理由**：Colyseus 7319★、TypeScript、2026-09-24 仍在提交、npm 0.18.8 上周发布，维护活跃。它自带房间生命周期、schema 增量同步、`allowReconnection` 断线重连、心跳——正好覆盖本项目最脏最累的 20-30h。断线重连自己实现极易出错（双开、幽灵座位、状态分叉），不值得为了叙事自己造。

**影响**：前后端可共享一份 TypeScript 类型定义，改一处两端都报错。技术栈锁定 Node，Java 经验用不上。作品集叙事重点转为「复杂规则引擎的纯函数化设计 + 服务端权威 + 动画状态解耦」，而非「手写实时同步」。

### D-003 · 规则引擎放在 shared 包，纯函数、零 IO

**决定**：`packages/shared/src/engine/` 不含任何网络、框架、时间、随机依赖。对外接口是 `applyAction(state, seat, action) → { newState, events[] }`。

**理由**：① 边池与 all-in 是本项目最容易写错的逻辑，纯函数才能做到 100% 单测覆盖；② 服务端只做权威判定与同步，不重复实现规则；③ 随机源可注入，测试能用固定 seed 复现任何一手牌；④ 前端回放器可直接复用同一套引擎生成测试场景。

**影响**：`shared` 包的 `package.json` 里不许出现 react / colyseus / express 任何依赖，CI 应校验这一点。所有金额用整数筹码，禁止浮点。

### D-004 · 动画由事件流驱动，状态 schema 只保证最终一致

**决定**：Colyseus schema 负责「重连后画面正确」，广播事件流负责「过程好看」。重连时直接渲染终态，不补播历史动画。

**理由**：若用状态 diff 驱动动画，断线重连会触发大量补播（可能几十秒），体验灾难。事件流 + 串行动画队列可以保证正常进行时动画完整，重连时干净落地。

**影响**：需要维护两条数据通道，一致性靠「事件是 schema 变化的副产物」来保证——即服务端先改 engine 状态、写 schema、再把 engine 返回的 events 广播。前端动画队列积压 >5 时清空并渲染终态，作为兜底。

---

## AI 后续追加的决策

### D-005 · 版本选型按实测生态修正，不照抄 SPEC 初稿

**日期**：2026-09-25　**任务**：M0.1　**决定者**：AI 自主（属实现细节，已在此登记备查）

**背景**
SPEC.md 初稿写的是 React 18 / Vite 5+ / vitest 2+。开工前逐个查 npm registry，发现生态已经往前走了，且有两处版本选择有真实风险。

**实测到的情况**
- `typescript` 的 `latest` 标签已是 **7.0.2**（Go 原生重写版），5.x 最新为 **5.9.3**
- `react` latest 已是 **19.3.0**
- `vite` latest 是 **8.3.1**（2026-09-24 发布，很新），7.x 最新 **7.3.6**（2026-06-25）
- `@vitejs/plugin-react` latest **6.1.1** 的 peer 只接受 `vite ^8.0.0`；**5.2.0** 的 peer 接受 `^4||^5||^6||^7||^8`
- `vitest` latest **5.0.1**，peer 接受 vite `^6.4||^7||^8`
- `colyseus.js` 停在 **0.16.22**，0.18 的客户端已改名为 **`@colyseus/sdk`**（0.18.4）

**决定**
- TypeScript 锁 **5.9.3**，不用 7.0.2
- Vite 用 **7.3.6** + `@vitejs/plugin-react` **5.2.0**，不用 Vite 8
- React 用 **19.3.0**（SPEC 初稿的 18 已过时）
- 客户端用 **`@colyseus/sdk`**，不是 `colyseus.js`
- vitest **5.0.1** + `@vitest/coverage-v8` **5.0.1**（两者必须同版本）

**理由**
TS 7 是原生端口重写版，而 Colyseus schema 重度依赖装饰器；`@colyseus/schema` 的 peer 写 `typescript >=5.0.0` 虽不排除 7，但在一个把「规则正确性」当命脉的项目里，不值得为省不了的时间赌装饰器元数据行为。Vite 8 发布仅一天，插件生态（尤其 plugin-react 6 要求 `oxc-transform-react` / `babel-plugin-react-compiler` 等新 peer）尚未沉淀，Vite 7 已有三个月生产验证。

**影响**
SPEC.md 的技术栈表需要按此更新。后续若升 Vite 8，必须同时升 plugin-react 6 并处理其新增 peer。

---

### D-006 · shared 包用「源码导出」模式，server 生产打包推迟到 M4.3

**日期**：2026-09-25　**任务**：M0.1　**决定者**：AI 自主（**含一处已知推迟，需用户在 M4.3 前知晓**）

**背景**
monorepo 里 server 与 web 都要 import `@poker-room/shared`。若 shared 只导出编译产物 `dist/`，dev 时就必须先构建 shared、且要保持 watch，构建顺序成为持续摩擦源。

**选项**
- A：shared 编译到 dist，server/web 消费 dist —— 干净，但 dev 需要 watch 链与构建顺序管理
- B：shared 的 `exports` 直接指向 `./src/index.ts`（Turborepo 所称 internal packages 模式）—— dev 零摩擦，但 server 的生产构建（`tsc` 只编译自己）会产出 `import '@poker-room/shared'` 而运行时解析到 `.ts` 文件，**跑不起来**
- C：全部用 tsup 打包 —— 最稳，但 M0.1 就引入打包链，超出本任务范围

**决定**
选 **B**，并在 **M4.3 用 tsup 打包 server** 解决生产构建。web 不受影响（Vite 构建时会自行把 workspace 依赖的 TS 源码打进产物）。

**理由**
B 让 M0-M3 全程零构建顺序摩擦，这对 AI 逐步开发尤其重要。生产打包是 M4.3「Docker 与部署」的固有部分，届时加一个 tsup 配置即可，不会返工前面的代码。

**影响**
**M4.3 之前，`pnpm --filter @poker-room/server start`（即 `node dist/index.js`）是不可用的**，dev 必须走 `pnpm dev`（tsx watch）。这是已知且刻意的状态，不是 bug。M4.3 的验收标准里必须包含「生产模式能真正跑起来」。

---

### D-007 · 架构守卫做成仓库根脚本，而不是 shared 包的单元测试

**日期**：2026-09-25　**任务**：M0.1　**决定者**：AI 自主

**背景**
DECISIONS.md D-003 规定 shared 包零 IO、零框架依赖。最初我把这个约束写成了 `packages/shared/test/smoke.test.ts` 里的单元测试，用 `node:fs` 读 `package.json` 来断言依赖列表。

**问题**
这**自相矛盾**：为了验证「shared 包零 IO」，我在 shared 包里写了 IO 代码。ESLint 的 `no-restricted-imports` 也会正确地把它拦下来。这是我在 M0.1 实际犯下并当场发现的错误。

**决定**
把守卫移到仓库根的 `scripts/check-arch.mjs`，作为 `pnpm lint` 的第二步运行。shared 的测试回归纯逻辑断言。

**理由**
守卫本质是**仓库级策略检查**，不是被测单元的行为。它需要读文件系统和 package.json，天然属于构建工具层，不属于领域逻辑层。

**影响**
守卫检查 6 项：shared 依赖白名单、shared/src 禁止框架与 IO 导入、禁止 `Math.random()`（随机源必须注入）、禁止环境全局、全仓库禁止 `any`/`@ts-ignore`、禁止 TODO/FIXME/占位实现。

**踩坑记录（别再犯）**：守卫第一版把注释也算进扫描范围，结果 `index.ts` 文档注释里那句「不许直接调用 Math.random()」被误判为真调用。修法是用逐字符状态机剥离注释（保留行号、保留字符串字面量内容），并区分两类检查——代码构造（import / Math.random / `: any`）在**剥离后**的源码上查，注释指令（`@ts-ignore` / `TODO`）在**原始**源码上查。脚本内置了 `selftest` 断言来防止注释剥离逻辑被改坏：**一个有假阴性的守卫比没有守卫更危险**。

---

### D-008 · 不写"理论上走不到"的防御分支——覆盖率门槛反向约束写法

**日期**：2026-09-25　**任务**：M0.2　**决定者**：AI 自主

**背景**
M0.1 给 shared 包设死了覆盖率门槛：statements / functions / lines 100%，branches 95%。M0.2 开始写真代码后，这个门槛立刻和一种常见写法冲突：**用类型系统已经保证不可能发生的情况，再写一遍运行时判空**。

**问题**
这类分支永远走不到，因此永远无法被测试覆盖，于是 `pnpm test:cov` 恒红。两个具体例子：

1. `parseCardId` 最初用正则 `/^(10|[2-9]|[JQKA])([shdc])$/` 解析，然后对 `match[1]`/`match[2]` 判空。正则匹配成功时两个捕获组必然存在，判空是死代码。
2. `cryptoRandom` 最初写 `new Uint32Array(1)` 再取 `word[0]`。`noUncheckedIndexedAccess` 让它类型变成 `number | undefined`，逼出一段永远走不到的判空。

**决定**
不留死分支，改写实现方式让每条分支都真实可达：

1. `parseCardId` 改成查 `CARD_BY_ID`（52 个合法牌标识 → 牌的 Map）。**表的键集合本身就是「合法输入」的完整定义**，查不到即非法——非法输入是一条真实可达、被 12 个用例覆盖的分支。顺带消灭了正则和字符串之间的双重真相来源。
2. `cryptoRandom` 改成 `new DataView(buffer).getUint32(0)`，返回类型就是 `number`，无需判空。

**理由**
覆盖率门槛的价值不在数字本身，而在于它把「这段错误处理从来没被验证过」这件事变成可见的。一段走不到的 throw 意味着：如果哪天它真的走到了（说明前提假设错了），没人知道它会不会正常工作。绕过门槛的正确方式是消灭死代码，不是调低门槛或加 ignore 注释。

**影响 / 后续照此办理**
- 需要 `noUncheckedIndexedAccess` 下访问数组元素时，优先选返回确定类型的 API（`DataView.getUint32`、`Array.shift()`、`Map.get` + 显式判空），而不是 `arr[i]!`。
- 确实无法避免时用非空断言 `!`，**但必须在旁边写出它为什么安全**（本次 `shuffle` 的两处 `!` 就是这么处理的：`i < length` 由循环条件保证，`j ∈ [0,i]` 由 `randomInt` 的上下界校验保证）。说不清理由就换写法。
- 例外：`cryptoRandom` 里 `globalThis.crypto === undefined` 的 throw 保留。它在 Node 20+ 与现代浏览器中确实不可达，但**它是可测的**（`Reflect.deleteProperty(globalThis, 'crypto')` + `finally` 恢复，已在 `test/random.test.ts` 里实测覆盖）。可测的防御分支不算死代码。
- **`pnpm test` 通过不等于类型正确**：vitest 只转译不做类型检查。本任务里 `buckets[randomInt(...)] += 1` 在 vitest 下全绿，`pnpm typecheck` 才报错。收尾一律跑 `pnpm verify`。

---

### D-009 · 配对码就是 roomId，砍掉 LobbyRoom（对 SPEC §2.4 的偏离）

**日期**：2026-09-25　**任务**：M0.3　**决定者**：AI 自主（**已改动已批准的 SPEC，需要用户过目**）

**背景**
SPEC.md §2.4 原本写的方案是：单独开一个 `LobbyRoom`，客户端先连它、提交配对码、查到目标 roomId 后再 `joinById`。配对码和 roomId 是两个东西，中间靠一张映射表连接。

**触发点**
写代码前去实测 Colyseus 0.18 的 API（0.16 → 0.18 破坏性变更很多，网上教程大半是旧的，不能凭记忆写）。`Room.d.ts` 里明确写着：

```
You may replace `this.roomId` during `onCreate()`.
Setting the roomId, is restricted in room lifetime except upon room creation.
```

并且用一个一次性探针脚本实测确认：**即使 `onCreate` 里先 `await` 过一次，之后再赋 `this.roomId` 依然生效**，客户端 `joinById(那个码)` 能正确进房。

**决定**
`PokerRoom.onCreate()` 里：

1. 生成一个候选配对码
2. 用 `matchMaker.findRoomsByIds([code])` 查重，被占用就重试（最多 5 次）
3. `this.roomId = code`
4. `this.state.joinCode = code`（同步给前端，用来拼分享链接）

`LobbyRoom` 整个删掉。客户端进房只需 `sdk.joinById(配对码, { nickname })`；码不存在时 Colyseus 自己抛 `MatchMakeError code=522 room "..." not found`，前端据此显示"房间不存在或已解散"。

**理由**
砍掉的东西：一个 LobbyRoom 类、一张配对码→roomId 映射表（以及它的生命周期/清理逻辑）、客户端进房前多的一次 WebSocket 连接与往返、一个 HTTP 解析端点。换来的是 `onCreate` 里 4 行代码和一次 `findRoomsByIds` 查询。

原方案唯一的实质优势是「配对码可以短且可复用」——即同一个码在房间销毁后能立刻再发出去，甚至可以让码和房间解耦（房间重建后老链接仍然有效）。本项目是朋友私局，房间销毁就意味着这局结束了，链接失效是**正确**行为而不是缺陷；码空间 32^6 ≈ 10.7 亿也完全不需要靠复用来省。这个优势对本项目为零。

**影响**
- TASKS.md M0.3 的「做」里删掉了 LobbyRoom；5 条验收标准一条没少，第 5 条因此变成字面意义上的「两个客户端用同一配对码 `joinById`」。
- SPEC.md §1.1 的 server 目录树同步更新（新增 `main.ts` / `routes.ts` / `pairing.ts`）。
- 前端（M0.4）路由 `/t/:code` 直接就是 roomId，不需要任何解析步骤。

**必须一并记住的坑（实测得来，不是推测）**
1. **Colyseus 不会拒绝重复的 roomId。** 探针实测：用同一个码再 `create` 一次会成功，然后把第一个房间的缓存条目顶掉 —— 结果是两个房间共用一个码、后来的玩家进新房间、先进来的人成了孤儿。所以上面第 2 步的查重**不是可选优化，是唯一的防线**。
2. `roomId` 只能在 `onCreate` 期间覆写，之后赋值会抛错。别想着在 `onJoin` 里改。
3. `maxClients` 默认是 `Infinity`，必须显式设成 `DEFAULT_TABLE_CONFIG.maxPlayers`（8）。
4. `onCreate` / `onJoin` / `onLeave` 在基类里是**可选属性**，配合 `noImplicitOverride` 必须写 `override`，否则编译失败。

**残余风险（已记入 PROGRESS.md 遗留问题）**
查重和赋值之间是 TOCTOU：两个 `create` 请求同时查重，理论上可能都认为某个码空闲。概率量级 ≈ 同时创建数 / 10.7 亿，私局可忽略。真要根治就上 Redis presence 锁把「查重+占位」做成原子操作，但那会引入一个外部依赖，对这个项目是过度设计。

---

### D-010 · 前端直连 Colyseus origin，放弃 vite `/ws` 代理（对 TASKS.md M0.4 的偏离）

**日期**：2026-09-25　**任务**：M0.4　**决定者**：AI 自主（**已改动已批准的任务书，需要用户过目**）

**背景**
TASKS.md M0.4 的「做」里写着「vite proxy 配 `/ws`」，目的是让前端同源访问、绕开跨域。`packages/web/vite.config.ts` 里已经按这句话配好了。

**触发点**
动手写 client 封装前，用真实 HTTP 打了一遍 Colyseus 0.18 的配对流程，拿到两个硬事实：

1. `@colyseus/sdk` 的连接不是一个固定的 WS 路径。它先 `POST /matchmake/{method}/{roomName}` 拿到 `{ roomId, processId, name, sessionId }`，再往 `ws://host:port/{processId}/{roomId}?...` 开 WebSocket。`processId` 是随机的根级路径段。
2. **路径前缀代理盖不住随机的根级路径段。** 要代理就得写 `rewrite` 把 `/{processId}/{roomId}` 猜出来，或者代理整个根 —— 后者会把 vite 自己的 HMR、静态资源、`/health` 全吞掉。这条路实测走不通，不是"麻烦"，是结构上不成立。

同时实测了 Colyseus 的 CORS：响应里 `Access-Control-Allow-Origin` 原样回显请求的 `Origin`，带 `Access-Control-Allow-Credentials: true`，预检 `OPTIONS` 返回 204。**即它本来就允许跨域**，代理解决的问题在 Colyseus 这边根本不存在。

**决定**
删掉 vite 的 `/ws` 代理。前端 SDK 直连 Colyseus 的 origin，按下面的优先级解析（`packages/web/src/net/serverUrl.ts`）：

1. `import.meta.env.VITE_SERVER_URL` 有值 → 用它（部署到线上、或本地想连远端时的开关）
2. 否则 DEV 模式 → `${location.protocol}//${location.hostname}:2567`
3. 否则（生产同源部署）→ `location.origin`

第 2 条用 `location.hostname` 而不是 `localhost`，是为了让「手机连同局域网」这个验收项直接成立：vite 已经开了 `host: true`，server 绑的是 `0.0.0.0:2567`，手机访问 `http://<电脑IP>:5173` 时 hostname 就是那个 IP，拼出来的 `http://<电脑IP>:2567` 正好是同一个局域网地址。写成 `localhost` 的话手机端会去连手机自己。

**理由**
代理方案要付出的代价：一段脆弱的 `rewrite` 正则、一个「dev 走代理 / prod 走直连」的双路径分歧（分歧就意味着 dev 测不到真实的生产路径）、以及 HMR 被吞的风险。直连方案的代价只有一个：Colyseus 端口要对浏览器可达。而它本来就可达（`0.0.0.0:2567`），且 Colyseus 默认 CORS 放行。

顺带一个额外好处：dev 和 prod 走的是**同一条代码路径**（都是跨 origin 直连），验收时测的就是上线后跑的那条。

**影响**
- `packages/web/vite.config.ts` 的 `server.proxy` 整块删除，并留下注释说明为什么不能加回来（否则下一个人会照直觉再配上）。
- TASKS.md M0.4 的「做」里「vite proxy 配 `/ws`」这一句作废；6 条验收标准一条没少。
- 生产部署（M4.3）时前后端不同源是常态，`VITE_SERVER_URL` 这个开关本来就是必需的，等于提前把部署要做的事做了。
- **残余风险**：如果将来把 Colyseus 放到反向代理后面（例如 nginx 统一域名 + WSS 终结），那时才真的同源，`location.origin` 分支会自然生效，无需改代码。

---

### D-011 · 头像用 DiceBear 本地生成，schema 里只同步 seed 不同步图片

**日期**：2026-09-25　**任务**：M0.4　**决定者**：AI 自主

**背景**
用户要求「人物、牌桌背景等都做的好看一点」。M0.4 的大厅需要每个玩家有个头像。项目定位是朋友私局 + 作品集，没有账号系统、没有上传服务、没有对象存储。

**选项**
- A：让用户上传/选一张图片，存到服务端 — 需要上传端点、存储、体积校验、内容审核。私局项目里这一整套是纯负债。
- B：内置一小组固定头像图片，用户挑一张 — 8 个人可能撞同一张；素材版权要自己逐个确认。
- C：DiceBear 按 seed 本地生成 SVG，seed 由用户/系统产生，**只把 seed 同步出去**，各端本地渲染。

**决定**
选 C。具体做法：

- 依赖 `@dicebear/core@^9.4.3` + `@dicebear/notionists@^9.4.2`（npm 自托管，**绝不走 `api.dicebear.com`**：那会把玩家 seed 发给第三方，而且是可用性单点）。
- `createAvatar(notionists, { seed, size, radius }).toDataUri()` → `data:image/svg+xml;utf8,...`，同一个 seed 永远得到同一张图（已实测确认确定性 + seed 敏感性）。
- Colyseus schema 里 `PlayerSlot` 的字段是 `avatarSeed: t.string()`，**不是图片**。
- seed 也过服务端清洗：`sanitizeAvatarSeed(raw, fallback)` 只保留 `[A-Za-z0-9]`、按码点截断到 24，没传时回落到 sessionId。清洗的目的不是防 XSS（seed 只进 DiceBear 不进 DOM innerHTML），而是**防止有人用一个畸形 seed 把别人的渲染搞崩**，以及保证 seed 长度可控。

**理由**
同步 seed 而不是 SVG 是这条决定的核心。一个 DiceBear data URI 实测约 14.7 KB，8 个人就是 ~118 KB —— 这些会进 Colyseus 的全量同步与 diff 基线，每次有人进出房都要重新推一遍，而房间状态里 99% 的字段变化跟头像毫无关系。seed 只有十几个字符，成本约千分之一，且各端算出来的图**逐字节相同**（DiceBear 是纯函数）。

「把重活推到客户端、网络上只传能重建它的最小信息」——这条原则在 M1 会更重要（底牌、动画事件都是同一类问题），所以在第一个遇到的地方就立规矩。

**许可证（用户会亲自核对，故在此登记）**
- `@dicebear/core`：MIT。
- `@dicebear/notionists`：MIT。DiceBear 的设计资产按风格包分别授权，**MIT 的风格包才是干净的**。
- **禁用名单**：`@dicebear/avataaars`、`@dicebear/bottts` —— 这两个包里写的是 "See LICENSE file"，授权链不清晰，不用。
- **需署名**：`@dicebear/personas` —— MIT **且** CC-BY-4.0，用了就必须在 README 署名。当前未使用；若将来想换风格，优先 `@dicebear/lorelei` / `@dicebear/identicon` / `@dicebear/rings` / `@dicebear/shapes`（均 MIT）。

**影响**
- `PlayerSlot` schema 定型为 `{ nickname, avatarSeed }`，服务端集成测试已覆盖「脏 seed 被裁剪」「不传 seed 回落 sessionId」「双方看到同一个 seed」。
- 前端需要一个 `avatarDataUri(seed, size)` 并带 Map 缓存（每次渲染重算 14.7 KB 的 SVG 是浪费），缓存要能被测试清空。
- 打包体积：DiceBear 两个包进 bundle，vite 生产构建当前 222.80 kB / gzip 69.61 kB，可接受。M4 打磨期若嫌大，可改成按需 `import()`。
- **坑（实测）**：`@dicebear/notionists` **没有** `notionists` 这个具名导出，运行时只有 `{ create, meta, schema }`。必须写 `import * as notionists from '@dicebear/notionists'`，然后把整个命名空间当 `Style` 传给 `createAvatar`（它恰好满足 `Style<O> = { meta?, schema?, create }`）。两个包都是 CJS，没有 `exports` map。
