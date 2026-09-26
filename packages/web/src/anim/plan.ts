/**
 * 服务端广播事件 → 动画任务的映射层（SPEC §3.1「服务端事件 → 动画事件的映射层」）。
 *
 * 这一层只做三个判断，且**完全不碰 DOM**：
 * 1. 这个事件要不要占动画队列（`planEvent` 返回 `null` 就是不要）；
 * 2. 它归哪一类（`kind`，M3.3~M3.5 的渲染层按这个 key 找播法）；
 * 3. 它名义上播多久（`durationMs`，已含窄屏系数，倍速由队列再乘）。
 *
 * ## 为什么时长表单独放一个文件
 *
 * SPEC §3.2 把每张表的时长写死成毫秒数，而 M3.3 的验收线是「8 人发牌 ≈3.2s」这种
 * 肉眼判断。一旦时长只存在于 GSAP 代码里，它就再也无法被机器验证——改错一个数字
 * 没人知道，直到某个人手动 replay 时觉得「今天有点慢」。所以数字留在这里，
 * 由 `animPlan.test.ts` 逐条钉住；GSAP 那边只负责「怎么播」。
 *
 * ## 「预留时长」必须等于「实际播放时长」
 *
 * 队列按 `durationMs` 决定何时放行下一段，操作按钮按队列是否非空决定灰不灰。
 * 于是这个数一旦和动画真的播完的时间漂移，就会出两种玩家都能感觉到的错：
 * 牌还在飞按钮就亮（这一步打在画面上还没到的回合），或者牌早停了按钮还灰着（像是卡住）。
 * `dealTimeline` 把「总时长」和「单张飞行 + 逐张间隔」绑成同一个来源，就是为了这条。
 */

import type { S2C_Broadcast } from '@poker-room/shared/view';

import type { RevealView } from '../net/types';

/** 渲染层注册表（M3.3~M3.5）的键。新增一类动画就是在这里加一个键 */
export type AnimKind = 'shuffle' | 'deal' | 'board' | 'action' | 'award' | 'handEnd' | 'reveal';

/**
 * 一段动画要演的**内容**。
 *
 * 绝大多数来自服务端广播流；只有 `reveal` 一支不是：亮牌按 D-002 / D-013 走定向消息，
 * 攒在快照的 `reveals` 里，所以它带的是那一批行，而不是一条 `S2C_Broadcast`。
 * 用带 `t` 的判别联合而不是 `event: unknown`，是为了让渲染层每个分支都能自己收窄，
 * 不必再对着一坨可选字段做防御性判断。
 */
export type AnimSubject = S2C_Broadcast | { readonly t: 'reveal'; readonly rows: readonly RevealView[] };

/** 一条排进队列的动画。`event` 原样带着，渲染层按 `kind` 再自己收窄 */
export interface AnimPlan {
  readonly kind: AnimKind;
  /** 名义时长（整数毫秒），已含窄屏系数，**不含**倍速 */
  readonly durationMs: number;
  readonly event: AnimSubject;
}

export interface AnimEnv {
  /** 窄屏（<640px）整表 ×0.8（SPEC §3.3「手机」） */
  readonly narrow: boolean;
}

/** 牌桌上限。`deal:start` 的人数锚点按它收敛，越界不炸也不播出一条负时长任务 */
const TABLE_MAX_PLAYERS = 8;

// SPEC §3.2 的静态行，一行一个常量。发牌那一行不在这里，它随人数走 `dealTimeline`。
const SHUFFLE_MS = 900;
/** `board:deal` 只有 flop 是三张，turn / river 各一张，时长自然不同 */
const BOARD_FLOP_MS = 1400;
const BOARD_SINGLE_MS = 700;
/** `action:made` 三种动作三种时长：筹码飞、牌飞回牌堆、座位轻敲 */
const ACTION_BET_MS = 420;
const ACTION_FOLD_MS = 380;
const ACTION_CHECK_MS = 300;
const AWARD_MS = 1200;
const HAND_END_MS = 2000;
/**
 * 摊牌亮牌（SPEC §3.2 的 500ms）。它**不在广播流里**：按 D-002 / D-013 亮牌是定向消息，
 * 所以它不从 `planEvent` 走，由 `revealPlan` 在快照的 `reveals` 长出新的那一行时入队。
 */
const REVEAL_MS = 500;

/** 窄屏系数（SPEC §3.3「手机」：动画时长在 <640px 统一 ×0.8） */
const NARROW_FACTOR = 0.8;

/** 发牌锚点：2 人 1.1s、8 人 3.2s（M3.3 验收线），中间线性插 */
const DEAL_TWO_PLAYER_MS = 1_100;
const DEAL_PER_PLAYER_MS = 350;
/** SPEC §3.2「单张 260ms」。间隔由总时长反推，见 `dealTimeline` */
export const DEAL_FLIGHT_MS = 260;

export interface DealTimeline {
  readonly flightMs: number;
  readonly intervalMs: number;
  readonly totalMs: number;
}

/**
 * 发牌的时间轴参数：每人一张、轮两次，所以一共 `2 * count` 张。
 *
 * SPEC §3.2 同时给了「单张 260ms、间隔 120ms」和「8 人 ≈3.2s」，这两条对不上：
 * 16 张牌按 120ms 间隔串起来只有 2060ms。取哪一个？**取验收能看见的那个**——
 * 3.2s 是 M3.3 的验收线，也是回放器里肉眼能判断的量；120ms 是推导过程的中间量。
 * 所以间隔由总时长反推并取整，260ms 保持不变。差额（8 人档实际间隔 196ms）
 * 记进 `DECISIONS.md`。
 */
export function dealTimeline(count: number): DealTimeline {
  const players = Math.min(TABLE_MAX_PLAYERS, Math.max(2, Math.round(count)));
  const nominalMs = DEAL_TWO_PLAYER_MS + DEAL_PER_PLAYER_MS * (players - 2);
  const intervalMs = Math.round((nominalMs - DEAL_FLIGHT_MS) / (2 * players - 1));
  return {
    flightMs: DEAL_FLIGHT_MS,
    intervalMs,
    totalMs: DEAL_FLIGHT_MS + intervalMs * (2 * players - 1),
  };
}

/** 队列要整数毫秒：`.5` 落到 GSAP 里是半帧抖动，落到 `setTimeout` 里是取整后再取整 */
function scale(baseMs: number, env: AnimEnv): number {
  return Math.round(env.narrow ? baseMs * NARROW_FACTOR : baseMs);
}

function plan(kind: AnimKind, baseMs: number, event: AnimSubject, env: AnimEnv): AnimPlan {
  return { kind, durationMs: scale(baseMs, env), event };
}

/**
 * 刚到达的亮牌 → 一段翻牌动画。
 *
 * 一次 patch 里可能同时到好几张（好几个人同时亮），它们仍是**一段**：500ms 一起翻，
 * 而不是 N 段各 500ms。按人排队会让摊牌变成一段漫长的等待，而这段时间按钮是灰的，
 * 玩家却什么也做不了（下一手的倒计时正在走）。
 *
 * `rows` 为空不许入队：空队列会让按钮灰 500ms，那是纯粹的代价、零收益。
 */
export function revealPlan(rows: readonly RevealView[], env: AnimEnv): AnimPlan | null {
  if (rows.length === 0) return null;
  return plan('reveal', REVEAL_MS, { t: 'reveal', rows }, env);
}

/**
 * 这条事件要不要排进动画队列。
 *
 * `null` = 不排。被排除的都是**状态类**事件：`turn:change`（呼吸光圈 + 倒计时环是 CSS
 * 循环，由快照的 `currentTurn` / `deadline` 直接驱动）、`hand:start` / `round:end` /
 * `showdown:start`（只是阶段推进的标记，画面跟着 patch 走）、`player:*` 与 `chips:rebuy`
 *（座位增减与补筹码）。让 `turn:change` 入队是最贵的一次误判：一手牌里它要出现十几次，
 * 每次几秒，界面就会长时间灰着按钮，而这段时间玩家什么也做不了。
 *
 * 摊牌亮牌（SPEC §3.2 的 500ms）**不从这里走**：它按 D-002 / D-013 是定向消息，
 * 不在广播流里，由 `revealPlan` 从快照 `reveals` 的新行长出来。
 */
export function planEvent(event: S2C_Broadcast, env: AnimEnv): AnimPlan | null {
  switch (event.t) {
    case 'shuffle':
      return plan('shuffle', SHUFFLE_MS, event, env);
    case 'deal:start':
      return plan('deal', dealTimeline(event.count).totalMs, event, env);
    case 'board:deal':
      return plan(
        'board',
        event.phase === 'flop' ? BOARD_FLOP_MS : BOARD_SINGLE_MS,
        event,
        env,
      );
    case 'action:made':
      return plan(
        'action',
        event.action.type === 'fold'
          ? ACTION_FOLD_MS
          : event.action.type === 'check'
            ? ACTION_CHECK_MS
            : ACTION_BET_MS,
        event,
        env,
      );
    case 'pot:awarded':
      return plan('award', AWARD_MS, event, env);
    case 'hand:end':
      return plan('handEnd', HAND_END_MS, event, env);
    case 'hand:start':
    case 'turn:change':
    case 'round:end':
    case 'showdown:start':
    case 'player:joined':
    case 'player:left':
    case 'player:emoji':
    case 'chips:rebuy':
      return null;
  }
}
