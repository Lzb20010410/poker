# SPEC.md — 架构 / 协议 / 动画 / UI 技术规格

> 规则引擎的算法在 `RULES-SPEC.md`，本文档不重复。
> 任务清单与验收标准在 `TASKS.md`。

---

## 1. 架构

### 1.1 Monorepo

```
pnpm-workspace.yaml
package.json              scripts: dev / build / test / lint
tsconfig.base.json        strict: true, target ES2022, moduleResolution bundler
vitest.workspace.ts
packages/
  shared/                 纯逻辑，零 IO，零框架依赖
    src/types.ts          领域类型（Card, PlayerView, TableView, TableConfig, Action...）
    src/protocol.ts       C/S 消息定义
    src/pairing.ts        配对码生成 / 归一化 / 校验 / 查重分配（server 与 web 都要用，故放 shared）
    src/profile.ts        昵称 / 头像 seed 清洗（服务端权威的最后一道裁剪）
    src/engine/
      deck.ts             洗牌、发牌
      evaluator.ts        包 pokersolver，HandResult / compare
      betting.ts          下注轮、动作校验、最小加注
      sidepot.ts          边池计算与派彩
      table.ts            牌桌状态机（对外唯一入口）
      random.ts           可注入随机源
    test/                 vitest
  server/                 Colyseus
    src/index.ts          工厂与导出（无副作用，测试可安全 import）
    src/main.ts           进程入口（唯一有副作用的文件：listen）
    src/routes.ts         HTTP 路由（/health）
    src/rooms/PokerRoom.ts 房间生命周期、动作路由、超时、重连
    src/schema/           Colyseus schema 同步结构（builder API）
    src/engine-bridge.ts  把 shared/engine 的状态映射成 schema
    test/                 单测 + 集成测试（模拟客户端）
  web/                    React + Vite
    src/main.tsx
    src/net/              Colyseus client 封装、连接/重连
    src/state/            同步状态 → React 状态、动画事件生成
    src/lobby/            大厅：创建房间 / 输入配对码 / 昵称头像
    src/table/            牌桌场景与组件
    src/anim/             GSAP 动画队列、timeline 工厂
    src/assets/           SVG 资产
    src/dev/              回放器（dev-only 调试工具）
```

### 1.2 分层职责（不要越界）

| 层 | 职责 | 禁止 |
|---|---|---|
| `shared/engine` | 纯规则计算：给定状态+动作 → 新状态 | 任何 IO、网络、Colyseus/React 依赖、`Date.now()`、直接 `Math.random()` |
| `server` | 权威判定、同步、房间生命周期、超时 | 自己实现规则逻辑（必须调用 engine） |
| `web` | 渲染状态、播动画、收集并上送操作 | 自己判断动作是否合法、自己算谁赢 |

**前端可以做「软提示」**（比如本地预判 raise 滑杆的合法范围），但**最终判定权永远在服务端**。

### 1.3 状态同步策略

- **公共状态** → Colyseus schema 自动增量同步（座位、筹码、公共牌、阶段、底池、当前行动者、倒计时截止时间戳）
- **私密信息** → 定向消息 `client.send()`，只发给当事人：
  - 自己的底牌
  - showdown 时其他人的底牌（此时已可公开）
- **烧牌** → 从不下发
- **动作历史** → 广播事件（用于驱动动画），见 §3

---

## 2. 协议（`shared/protocol.ts`）

### 2.1 客户端 → 服务端

```ts
// 房间消息（Colyseus message）
type C2S =
  | { t: 'table:setConfig'; config: Partial<TableConfig> }   // 仅房主，IDLE 时
  | { t: 'table:start' }                                     // 仅房主
  | { t: 'action'; action: Action }                         // 见 RULES-SPEC §3.2
  | { t: 'rebuy' }                                           // 筹码为 0 时
  | { t: 'sit'; seatIndex: number }
  | { t: 'stand' }
  | { t: 'emoji'; emoji: 'fold-face'|'laugh'|'angry'|'wave' }   // 快捷表情，非自由聊天
  | { t: 'ping' }
```

### 2.2 服务端 → 客户端

```ts
// 定向（仅本人）
type S2C_Private =
  | { t: 'deal:holeCards'; cards: [Card, Card]; handId: string }
  | { t: 'showdown:reveal'; seatIndex: number; cards: [Card, Card] }
  | { t: 'timeoutWarning'; remainingSec: number }
  | { t: 'error'; code: ErrorCode; message: string; ref?: unknown }

// 广播（动画驱动事件）
type S2C_Broadcast =
  | { t: 'hand:start'; handId: string; dealerSeat: number; sbSeat: number; bbSeat: number }
  | { t: 'shuffle' }
  | { t: 'deal:start'; count: number; startSeat: number }
  | { t: 'board:deal'; phase: 'flop'|'turn'|'river'; cards: Card[] }   // 牌值走 schema，此事件仅触发动画
  | { t: 'action:made'; seatIndex: number; action: Action; chipsDelta: number }
  | { t: 'turn:change'; seatIndex: number; deadline: number }          // deadline = Date.now() + timeout
  | { t: 'round:end'; phase: Phase }
  | { t: 'showdown:start'; pots: Pot[] }
  | { t: 'pot:awarded'; potIndex: number; winners: number[]; amount: number; handName: string; bestFive: Card[] }
  | { t: 'hand:end'; results: PlayerResult[] }
  | { t: 'player:joined'; seatIndex: number; profile: PlayerProfile }
  | { t: 'player:left'; seatIndex: number }
  | { t: 'player:emoji'; seatIndex: number; emoji: string }
  | { t: 'chips:rebuy'; seatIndex: number }

type ErrorCode =
  | 'NOT_YOUR_TURN' | 'INVALID_ACTION' | 'RAISE_TOO_SMALL' | 'INSUFFICIENT_CHIPS'
  | 'ALREADY_FOLDED' | 'ALREADY_ALLIN' | 'HAND_NOT_STARTED' | 'NOT_SEATED'
  | 'NOT_HOST' | 'ROOM_FULL' | 'CONFIG_LOCKED'
```

### 2.3 关键设计：动画由「事件」驱动，不由「状态 diff」驱动

状态 schema 用于**保证最终一致**（重连后画面正确），事件流用于**驱动动画**（保证过程好看）。两者并存：

- 重连时：直接按 schema 渲染终态，**不播历史动画**（或只播一个 0.5s 的淡入）
- 正常进行时：事件按序入动画队列

这样断线重连不会出现「补播 30 秒动画」的灾难。

### 2.4 配对码

- 6 位，字符集 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`（**剔除 I/O/0/1**）
- 大小写不敏感，输入时自动转大写
- 生成后查重，冲突则重生成（最多 5 次）
- **实现方案（M0.3 实测后改定，见 DECISIONS.md D-009）：配对码就是 Colyseus 的 `roomId`。**
  `PokerRoom.onCreate()` 里先用 `matchMaker.findRoomsByIds([code])` 查重，拿到一个没被占用的码后
  直接 `this.roomId = code`（0.18 允许在 `onCreate` 内、甚至在 `await` 之后覆写）。
  客户端进房只需 `sdk.joinById(配对码)`，码不存在时 Colyseus 自己返回
  `MatchMakeError code=522 room "..." not found`，前端据此提示"房间不存在或已解散"。
  原方案的 `LobbyRoom` + 配对码→roomId 映射表 + 额外一跳 WebSocket + HTTP 解析端点**全部不需要**。
- 代价：配对码在房间存活期间不可复用，房间销毁即释放。私局场景下 32^6 ≈ 10.7 亿的码空间足够。
- 已知残余风险（TOCTOU）：两个 `create` 请求同时查重，可能都认为某个码空闲。
  概率量级 ≈ 同时创建数 / 10.7 亿，私局可忽略。真要根治就上 Redis presence 锁，见 PROGRESS.md 遗留问题。

### 2.5 房间生命周期

- 空闲（无玩家）**30 分钟**自动 `dispose()`
- 一手牌进行中若玩家掉线 → 保留座位 **120 秒**，允许 `allowReconnection`
- 超过 120 秒 → 该玩家自动 `stand`，筹码保留至本桌结束
- 房主离开 → 房主转移给座位号最小的在场玩家

---

## 3. 动画系统（`web/src/anim/`）

### 3.1 核心设计：串行动画队列

```ts
class AnimQueue {
  private queue: AnimEvent[] = [];
  private playing = false;

  push(e: AnimEvent): void;          // 服务端事件 → 入队
  private async run(): Promise<void>; // 顺序播放，一次一个
  skip(): void;                       // 用户点击"跳过动画"→ 立即跳到终态
}
```

**规则**：
- 队列**严格串行**。上一个动画 `onComplete` 后才开始下一个
- **操作按钮在队列非空时禁用**（灰显）。这是消除「牌还没到就能操作」割裂感的关键
- 提供「加速」开关（0.5× 时长）和「跳过」按钮（老玩家会需要）
- 若队列积压 > 12 段（例如重连后），直接清空并渲染终态 <!-- 2026-09-27 由 5 抬到 12：5 段装不下"三个池依次派彩"（那一帧天生 6 段）。冲突的来龙去脉见 D-035，抬到 12 的裁决见 D-036 -->

### 3.2 动画事件 → timeline 映射

| 事件 | 动画 | 时长 |
|---|---|---|
| `shuffle` | 牌堆 20 张牌交错抖动 + 切牌位移 | 900ms |
| `deal:start` | 从牌堆位置沿**二次贝塞尔曲线**飞向各座位；每人 1 张轮两次；单张 260ms，间隔 120ms；自己的两张落地后 `rotateY` 3D 翻面 | 依人数，8人≈3.2s |
| `board:deal(flop)` | 1 张烧牌飞向弃牌堆淡出 → 3 张依次从牌堆飞入公共牌区 → 逐张 `rotateY` 翻开，间隔 180ms | 1400ms |
| `board:deal(turn/river)` | 同上但 1 张 | 700ms |
| `action:made(bet/raise/call)` | 筹码从座位沿弧线飞向 pot 区，落地时按面额堆叠（每 20 单位 1 枚，最多显示 8 枚 + "×N"） | 420ms |
| `action:made(fold)` | 两张底牌飞向牌堆 + 淡出 + 座位变暗 | 380ms |
| `action:made(check)` | 座位轻敲动效（向下位移 4px 回弹）+ "过牌"文字气泡 | 300ms |
| `pot:awarded` | pot 区筹码飞向赢家座位，同时弹出牌型名称 + 数字滚动 | 1200ms |
| `showdown:reveal` | 未亮玩家的底牌 `rotateY` 翻开 | 500ms |
| `turn:change` | 目标座位呼吸光圈（CSS animation 循环）+ 倒计时环（SVG stroke-dashoffset，由 `deadline` 驱动） | 持续 |
| `hand:end` | 输家筹码淡出、赢家数字滚动、"下一手 5s 后开始"倒计时 | 2000ms |

### 3.3 技术要点

- **卡牌**：SVG `<g>`，正反面通过 CSS `transform: rotateY()` + `backface-visibility: hidden` 实现 3D 翻转。不要用 GSAP 的 CSSPlugin 做 rotateY 之外的 3D，容易出问题。
- **飞行路径**：用 GSAP `MotionPathPlugin`。
  **许可已核实（2026-09-25，来源 gsap.com/standard-license）**：GSAP 3.13+ 采用 "Standard License"，**全部插件（含原 Club GSAP 付费插件 MotionPathPlugin / SplitText / MorphSVG / ScrollSmoother）均免费，且允许商用**。npm 上 `gsap@3.15.0` 的 license 字段已不再包含 "Club GSAP members get more" 条款，可佐证。因此**不需要额外购买许可，也不需要绕开 MotionPathPlugin**。
  实现时若发现 `MotionPathPlugin` 需单独 `gsap.registerPlugin()`，照做即可；若因版本原因确实不可用，改用 `gsap.to` + 自算二次贝塞尔的 `onUpdate`，并在 `DECISIONS.md` 记录。
- **筹码堆**：单枚筹码是一个 SVG 组件，堆叠用 `translateY(-Npx)` + 轻微 `translateX` 抖动模拟不整齐感
- **性能**：8 人满桌同时动画时，DOM 元素数控制在 ~200 以内。给动画元素加 `will-change: transform`，动画结束后移除
- **手机**：动画时长在窄屏（<640px）统一 ×0.8，避免等待感

### 3.4 状态回放器（`web/src/dev/ReplayTool.tsx`）— **必须做**

一个 dev-only 页面，**不连服务端**，用硬编码的事件序列驱动整套动画：

```ts
const FIXTURE_HAND: S2C_Broadcast[] = [
  { t: 'hand:start', handId: 'demo-1', dealerSeat: 0, sbSeat: 1, bbSeat: 2 },
  { t: 'shuffle' },
  { t: 'deal:start', count: 2, startSeat: 1 },
  // ... 完整一手的 8 人 all-in + 边池场景
];
```

价值：**没有真人也能反复调动画**。这是 M3 能按时完成的关键。提供播放/暂停/单步/变速控制，以及 3 个预置场景（正常一手、多人 all-in 边池、heads-up）。

---

## 4. UI 规格

### 4.1 页面

```
/            大厅：昵称输入 + 头像选择 + [创建房间] / [输入配对码加入]
/r/:code     房间等待区：座位选择、桌况配置（房主）、玩家列表、[开始游戏]
/t/:code     牌桌
/dev/replay  回放器（仅 dev）
```

### 4.2 牌桌布局

- 桌面为**椭圆**，长宽比 2:1（横屏）/ 1.7:1（竖屏；D-029 从 1.3 改的，1.3 在手机上量出来"有点圆、不够椭圆"）
- 8 个座位沿椭圆**参数方程**分布：`x = cx + rx*cos(θ)`, `y = cy + ry*sin(θ)`
- **自己的座位永远固定在正下方中央**，其他座位按相对偏移量布置（即：座位是"相对视角"渲染的，不是绝对 seatIndex）
- 公共牌区在椭圆中心，底池显示在其上方（那一行的位子按**文字行框**留，留不出就把「底池」两字收成只显数字）
- 牌堆位置：椭圆中心偏右上；这一档太挤时**不画牌堆**（宁可少一个装饰，也不让任何两块内容交叠）

**竖屏（<768px）**：
- 椭圆纵向压缩，对面 3 个座位**至多**缩小到 70%，但不低于可读下限（`READABLE_SEAT_FLOOR`）
- 自己的底牌放大到屏幕宽度的 22%，置于底部操作面板上方
- 操作面板折叠为底部抽屉，按钮高度 ≥48px（可点击区域）

### 4.3 座位组件

```
[头像 圆形 64px/48px]
[昵称 最多 8 字，超出省略]
[筹码数 千分位，数字滚动动画]
[底牌 2 张，自己正面/他人背面]
[状态角标：D / SB / BB / ALL-IN / 弃牌变暗 / 托管中]
[行动光圈 + 倒计时环]
[表情气泡]
```

**手机上坐满 8 人时**（D-029）：那一档的座位框解出来只有 104×44，按上面这一套排必然被裁字，
所以它换一套内容而不是"同样东西缩小"——头像 22px、昵称与筹码各占一行、他人底牌缩成 9×13
的微型牌背（仍要画，"这人还在不在牌里"不能没）、角标只留**位置与人的状态**（D/SB/BB/弃/ALL-IN/旁观/断线），
「行动中」由整格金框说、「已投」由底池那一行读、「房主 / 你」在这一档不排。缩短过的角标
（`已弃牌 → 弃`）全称仍挂在 `title` 与 `aria-label` 上。

### 4.4 操作面板

```
[弃牌 红]  [过牌/跟注 N 蓝]  [加注 绿]
[加注滑杆：min ─────●───── max]  [输入框]
[快捷：1/2池  2/3池  底池  全下]
```

- 滑杆范围：`min = currentBet + lastRaiseSize`，`max = player.chips + committedThisStreet`
- 滑杆步长 = `bigBlind`
- **软提示**：若玩家输入非法值，前端标红提示，但**仍允许发送**，由服务端判定并返回 `error`（避免前后端逻辑不一致时卡死）
- `toCall === 0` 时按钮显示「过牌」；否则显示「跟注 N」
- 键盘支持（PC）：F=弃牌，C=过牌/跟注，R=加注，↑↓=调整额度，Enter=确认

### 4.5 美术资产

**所有资产的许可已于 2026-09-25 逐个核实。** 本项目会作为公开作品集，务必只用许可清晰的素材。

| 资产 | 来源 | 许可 | 备注 |
|---|---|---|---|
| 扑克牌面（首选） | GitHub `hayeah/playing-cards-assets`（357★） | **MIT** | 含 `svg-cards/` 与 `png/` 两套。转成 React 组件。**2026-09-26 实测修订**：全 52 张精雕 gzip 3.6MB，超 M2.1 预算 12 倍，故实际采用「40 张精雕 + `svg-cards/simple/` 的 12 张 J/Q/K」混合副（52KB gzip），静态内联不分包 → 见 D-023 |
| 扑克牌面（备选，最安全） | GitHub `AustinGabriel/Public-Domain-and-CC0-Playing-Cards` | **CC0-1.0** | 54 张标准牌（含大小王），明确标注可商用 |
| 牌背 | 自绘 | — | 深蓝底 + 菱形纹样 SVG，避免用来源不明的牌背 |
| 筹码 | 自绘 SVG | — | 圆形 + 8 条边缘色带 + 内圈面额数字。6 种面额配色：1白 / 5红 / 25绿 / 100黑 / 500紫 / 1000金 |
| 牌桌 | 自绘 SVG | — | 椭圆，径向渐变（中心亮、边缘暗）+ SVG `feTurbulence` 噪点滤镜模拟绒布 + 内圈描金线 + 中央 logo |
| 头像 | DiceBear，**npm 自托管**（`@dicebear/core` + 风格包） | 见下方警告 | 免费、确定性生成（同 seed 同头像）、矢量输出 |
| 背景 | CSS 渐变 + 噪点 | — | 深色调，避免抢牌桌视觉 |

**DiceBear 风格包的许可差异（已逐个查 npm license 字段核实，不要凭印象选）**

| 风格包 | license | 能否用 |
|---|---|---|
| `@dicebear/notionists` | MIT | ✅ **推荐** |
| `@dicebear/lorelei` | MIT | ✅ **推荐** |
| `@dicebear/identicon` | MIT | ✅ 可用（偏抽象） |
| `@dicebear/rings` / `shapes` | MIT | ✅ 可用（纯几何） |
| `@dicebear/personas` | MIT **AND CC-BY-4.0** | ⚠️ 可用但**必须署名** |
| `@dicebear/avataaars` | "See LICENSE file" | ❌ **不要用**，许可不明确 |
| `@dicebear/bottts` | "See LICENSE file" | ❌ **不要用**，许可不明确 |

**结论：用 `notionists` 或 `lorelei`（MIT，干净）。** 不要为了"好看"去用 `avataaars` / `bottts`——这两个是 DiceBear 里许可最模糊的，作为公开作品集不值得冒险。

**用 npm 自托管而不是 `api.dicebear.com` HTTP 接口**：① 不依赖第三方服务可用性；② 避免其 API 使用条款的不确定性；③ 生成结果可直接内联为 SVG，无额外请求。

**所有资产必须是 SVG 或 CSS，禁止使用位图**（保证手机高分屏清晰 + 体积小）。引入任何第三方素材前，把仓库名、star 数、license SPDX 标识写进 `DECISIONS.md`。

### 4.6 配色（深色主题，单一主题即可）

```
背景      #0d1117 → #161b22 渐变
桌面绒布  #1a6b4a（绿呢）或 #1f4e79（蓝呢），房主可选
桌面边框  #8b6b3d 描金
强调色    #e3b341（金，用于当前行动者/赢家）
弃牌灰    #484f58
文字      #e6edf3 / 次要 #8b949e
按钮 弃牌  #da3633   跟注 #388bfd   加注 #238636
```

### 4.7 音效（M4，可选但推荐）

Web Audio API，5 个短音效：**代码合成，产物里不放音频文件**（发牌、筹码碰撞、翻牌、轮到你的提示音、胜利）。<!-- 2026-09-27 追认：原句「各 <30KB，ogg/mp3」按 D-041 方案 A 定案——音色表 + OscillatorNode 现场合成，音频资产 0 字节、无解码延迟、跨浏览器音色一致。改走真录音的前置条件（音源许可 + 编码依赖 + 新的技术栈偏离记录）写在 D-041 -->
**必须有静音开关，默认开启，首次交互后才能播放（浏览器自动播放策略）。**

---

## 5. 部署

### 5.1 目标形态

单台 VPS（2核4G，¥50-100/月），Docker Compose 两个容器：
- `server`：Node 24 + Colyseus（ws），容器里跑 `tsx src/main.ts`（源码直跑，见 D-043）<!-- 2026-09-27 追认：原句 Node 20 —— 20 线已于 2026-04 停止维护，且仓库 engines.node 早已是 >=22 -->
- `web`：nginx 托管静态构建产物 + 反代 `/ws` 到 server

### 5.2 要求

- HTTPS（Let's Encrypt，nginx certbot）—— **Colyseus 的 wss 必须要 HTTPS 才能从 https 页面连接**
- 无数据库（v1 不做持久化）
- 环境变量：`PORT`、`NODE_ENV`、`ALLOWED_ORIGINS`（+ `LOG_LEVEL`）
  <!-- 2026-09-27 实测更正：`ALLOWED_ORIGINS` 在 express 这一层**挡不住 `/matchmake`**（Colyseus 0.18 先挂自己的 cors 与 matchmake，之后才调我们传的 express 回调）。部署形态下的同源判定落在 nginx（`deploy/nginx/*.conf` 里那三段 `if`），取证与推过程见 D-043 -->
- 健康检查 `GET /health`
- 日志：结构化 JSON 到 stdout，Docker 收走
- 房间状态只在内存中；进程重启所有房间丢失（v1 可接受，需在 UI 提示）

### 5.3 开发环境

```
pnpm dev          并行启动 server (:2567) + web (:5173)，web 直连 `ws://<当前主机名>:2567`（vite **故意不配 proxy**，理由见 D-010 与 `vite.config.ts` 注释；生产才走 `/ws` 前缀）
pnpm test         全量 vitest
pnpm build        全量构建
pnpm lint         eslint + prettier check
```

---

## 6. 测试策略

| 层 | 工具 | 覆盖要求 |
|---|---|---|
| `shared/engine` | vitest | **100% 语句覆盖**，且 `RULES-SPEC.md` §2.4 / §4.3 列出的用例一条不少 |
| `server` | vitest + colyseus.js 客户端 | §6 的 12 个集成场景全过 |
| `web` | vitest + @testing-library/react | 组件渲染、动画队列逻辑（用 GSAP 的 `gsap.ticker` mock 或直接测队列状态机，不测视觉） |
| 端到端 | **手动**，M4.6 | 真人 6 人手机局 30 分钟 |

覆盖率用 `vitest --coverage`，`shared` 包设 `thresholds: { statements: 100, branches: 95 }`。

**动画不做自动化测试**（性价比太低），改用 §3.4 的回放器 + 人工目视验收。
