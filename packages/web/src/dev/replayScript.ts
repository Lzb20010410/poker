/**
 * 回放器的**脚本格式**与编译层（M3.2）。
 *
 * ## 一帧 = 服务端的一次 patch
 *
 * 这一条是整个文件最要紧的约定。真实的 `PokerRoom` 不是一条一条地发消息：
 * `applyAction()` 一次返回一批事件（`action:made` 后面可能跟着 `round:end`、三张 `board:deal`、
 * `showdown:start`、几个 `pot:awarded`、`hand:end`），服务端把这一批**逐个 broadcast 出去**，
 * 而 schema 只落地**一次**（`PokerRoom.ts`：`broadcastPatch()` 之后 `for (const event of update.events)`）。
 * 所以牌桌看到的永远是「画面终态一次到位 + 一串排着队的事件」。
 *
 * 如果脚本按「一个事件一帧」写，回放出来的就成了「一段动画 + 一次终态」交替出现，
 * 而线上是「一次终态 + 一串动画」。队列在两种节奏下的积压深度完全不同，
 * 在这里调顺的时长到线上就不是同一个东西。所以 `ops` 的语义是**同一份 patch 里同时发生**的几件事。
 *
 * ## 这里没有任何规则判定
 *
 * AGENTS.md 的铁律：谁能行动、下注是否合法、边池怎么算、谁赢——只住在 `shared/engine`。
 * 本文件只做一件事：把**已经决定好的**一手牌誊写成客户端会收到的那种字节。
 * `act` 里的金额是作者填的（不是这里判断能不能下）；`award` 里谁赢、赢多少也是作者填的
 *（不是这里算的）；`walk` 那条连 `bestFive` 都是空数组——因为它抄的是
 * `table-settlement.ts` 单人路径的产物（那条路径刻意不调评估器）。
 * 唯一在这里做的算术是「他掏出 N 枚，口袋里少 N 枚、池子里多 N 枚」这一条记账恒等式，
 * 它不是规则；写错了会被 `test/devReplay.test.ts` 的筹码守恒断言抓住。
 *
 * ## 时钟为什么不在这里落地
 *
 * `deadline` / `nextHandAt` 是**绝对时刻**。脚本在编译时算好绝对值的话，页面开十分钟之后再播
 * 这一帧，倒计时环一上来就是 0、呼吸光圈也不在——那正是回放器最该给人看的两样东西。
 * 所以帧里存的是「还剩多少毫秒」，由 `stampClock` 在**应用这一帧的那一刻**换算成绝对时刻。
 * 广播事件里那个 `turn:change.deadline` 不做二次换算：没有任何消费者读它
 *（`planEvent` 对 `turn:change` 返回 `null`，画面上的钟走的是快照），所以它按编译时刻给一个名义值。
 */

import type { Action, Card, Phase, PlayerResult, S2C_Broadcast } from '@poker-room/shared/view';

import type {
  AwardView,
  ConnectedPlayer,
  HandPlayerView,
  LegalActionsView,
  PotView,
  RevealView,
  ResultView,
  RoomSnapshot,
  TableViewConfig,
} from '../net/types';

/** 脚本里的一位玩家。`chips` 是脚本开始时他口袋里的筹码 */
export interface ScriptSeat {
  readonly nickname: string;
  readonly chips: number;
  /** 头像 seed。省略时按「场景 id + 座位号」给一个稳定的 seed */
  readonly seed?: string;
  /** `true` = 整场旁观：占着座位但不参与任何一手 */
  readonly sittingOut?: boolean;
}

/** 服务端算好的可执行动作提示。回放器里只有「轮到我」那一帧需要它，用来目视验收按钮灰不灰 */
export type ScriptLegal = LegalActionsView;

/**
 * 一帧里发生的一件事。每个变体对应服务端会说的话，注释里标出它产出的广播事件。
 *
 * `start` / `shuffle` / `deal` / `turn` 的先后照 `startHand()` 的实际产出来：
 * `hand:start` → `shuffle` → `deal:start` → `turn:change`，四件在**同一份 patch** 里。
 */
export type ScriptOp =
  | { readonly t: 'start'; readonly dealer: number; readonly sb: number; readonly bb: number }
  | { readonly t: 'shuffle' }
  /** `holes[i]` = 第 i 号的底牌；`null` = 这一手没他的份（旁观、或这桌空位） */
  | { readonly t: 'deal'; readonly holes: readonly (readonly [Card, Card] | null)[] }
  /** 轮到谁。`seat: null` = 此刻没人该行动。`legal` 只给「我」那一格有意义 */
  | {
      readonly t: 'turn';
      readonly seat: number | null;
      readonly seconds?: number;
      /** 服务端在截止前 10 秒定向发的预警剩余秒数 → 快照的 `timeoutWarning` */
      readonly warn?: number;
      readonly legal?: ScriptLegal;
    }
  | { readonly t: 'act'; readonly seat: number; readonly action: Action }
  | { readonly t: 'street'; readonly phase: 'FLOP' | 'TURN' | 'RIVER'; readonly cards: readonly Card[] }
  /**
   * 一街结束、但牌面还没发到下一街（后面紧跟 `show`）。
   *
   * 需要它是因为真实节奏：`advanceHand()` 在河牌圈结束时只发一个 `round:end` 就直接进结算，
   * 中间没有 `board:deal`。少了这一帧，摊牌前的 `round:end` 就永远不会出现在回放里。
   */
  | { readonly t: 'roundEnd' }
  /**
   * 全员 all-in 后一次发完剩下的街（`advanceHand()` 的 run-out 循环）。
   *
   * 一份 `round:end` + 每街一张 `board:deal`，并且**只在这一次 patch 里**——
   * 这就是线上「三条牌连着飞进来」而界面无所谓的原因。`streets` 从当前牌面往后接，
   * 每段的张数决定落在哪一街（累计 3/4/5 张 = 翻牌/转牌/河牌）。
   */
  | { readonly t: 'runout'; readonly streets: readonly (readonly Card[])[] }
  /** 摊牌：`pots` 就是 `showdown:start` 带的那一份，同时写进快照 */
  | { readonly t: 'show'; readonly pots: readonly PotView[] }
  /** 亮牌。定向消息，**不产事件**，只长快照的 `reveals` */
  | { readonly t: 'reveal'; readonly seats: readonly number[] }
  | {
      readonly t: 'award';
      readonly potIndex: number;
      readonly winners: readonly number[];
      /** `[座位, 金额]`。平分一个池就列多项 */
      readonly payouts: readonly (readonly [number, number])[];
      readonly handName: string;
      readonly bestFive: readonly Card[];
    }
  /** 只剩一人未弃牌：单人路径，不调评估器，所以 `bestFive` 是空的、也没有 `showdown:start` */
  | { readonly t: 'walk'; readonly winner: number }
  /** 未被跟到的下注：派彩那一刻退回原主，从未进池（`table-settlement.ts` 的 `potContributions`） */
  | { readonly t: 'refund'; readonly seat: number; readonly amount: number }
  /** 本手结束：产出 `hand:end`，并把 `committed*` 清零、把 `results` 写进快照 */
  | { readonly t: 'end'; readonly handNames?: readonly (readonly [number, string])[] }
  | { readonly t: 'emoji'; readonly seat: number; readonly emoji: string }
  /** 「N 秒后开下一手」→ 快照的 `nextHandAt`。省略时 `end` 会按服务端的 5 秒默认给 */
  | { readonly t: 'wait'; readonly seconds: number };

/** 一帧：一个标签 + 同一份 patch 里发生的所有事 */
export interface ScriptFrame {
  readonly label: string;
  /** 给人看的「这一帧该盯什么」，显示在进度条下面 */
  readonly note?: string;
  readonly ops: readonly ScriptOp[];
}

export interface ScriptScenario {
  readonly id: string;
  readonly title: string;
  /** 这一桌在验什么，显示在场景按钮下面 */
  readonly summary: string;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly seats: readonly ScriptSeat[];
  readonly frames: readonly ScriptFrame[];
}

/** 编译后的一帧：终态快照 + 同一批到达的事件 + 还没落地的时钟余量 */
export interface ReplayFrame {
  readonly label: string;
  readonly note: string;
  readonly snapshot: RoomSnapshot;
  /**
   * 这一批同时到达的广播。页面按顺序把它们喂给导演，`player:emoji` 喂给气泡槽——
   * 和线上同一条路（`connection.onEvent`），所以「事件层把某类事件漏给了谁」这种错
   * 在回放器里一样看得见。编译层不替页面预分组：那样就等于绕开了这条总线。
   */
  readonly events: readonly S2C_Broadcast[];
  readonly deadlineMs: number | null;
  readonly nextHandMs: number | null;
}

/** 编译后的场景：`frames` 换成了带终态快照与事件的那一份，其余字段原样留着给页面显示 */
export interface ReplayScenario extends Omit<ScriptScenario, 'frames'> {
  readonly frames: readonly ReplayFrame[];
}

/** `settleHand()` 里 `nextHandAt = ctx.now + 5000`，回放器照抄这个默认 */
const DEFAULT_NEXT_HAND_MS = 5_000;
/** 脚本没写 `seconds` 时的行动时限。只影响呼吸环的初始刻度 */
const DEFAULT_TURN_SECONDS = 30;
/** 旁观者那一格上的按钮全灰：`legal` 的默认值 */
const NO_LEGAL: LegalActionsView = {
  canFold: false,
  canCheck: false,
  callAmount: 0,
  canRaise: false,
  minRaiseTotal: 0,
  maxRaiseTotal: 0,
  canAllIn: false,
};

interface Row {
  readonly id: string;
  readonly nickname: string;
  readonly avatarSeed: string;
  chips: number;
  committedThisStreet: number;
  committedTotal: number;
  folded: boolean;
  allIn: boolean;
  readonly sittingOut: boolean;
  hasActed: boolean;
  hole: readonly [Card, Card] | null;
  legal: LegalActionsView;
  /** 这一手有没有他的份。`start` 清、`deal`/盲注置位，用来决定 `handPlayers` 里有没有他 */
  inHand: boolean;
}

interface Run {
  phase: Phase;
  handId: string;
  handNo: number;
  turnVersion: number;
  board: Card[];
  pots: PotView[];
  awards: AwardView[];
  results: ResultView[];
  reveals: RevealView[];
  currentBet: number;
  lastRaiseSize: number;
  potTotal: number;
  dealer: number | null;
  sb: number | null;
  bb: number | null;
  currentTurn: number | null;
  deadlineMs: number | null;
  nextHandMs: number | null;
  timeoutWarning: number | null;
  runOutBoard: boolean;
  rows: Row[];
  /** 这一手开始时各人的口袋筹码，用来算 `hand:end` 里的 delta */
  startChips: number[];
  readonly config: TableViewConfig;
  /** 整场买入总额。筹码守恒断言的右端 */
  readonly introducedChips: number;
}

function at(rows: readonly Row[], seat: number, what: string): Row {
  const row = rows[seat];
  if (row === undefined) throw new Error(`回放脚本引用了不存在的座位 ${String(seat)}（${what}）`);
  return row;
}

/** 掏 N 枚筹码：口袋里少 N、池子里多 N。这一条恒等式是本文件唯一的算术 */
function spend(run: Run, seat: number, amount: number): void {
  if (amount < 0) throw new Error(`座位 ${String(seat)} 要掏负数 ${String(amount)} 枚`);
  const row = at(run.rows, seat, '下注');
  if (amount > row.chips) {
    throw new Error(`座位 ${String(seat)} 掏不出 ${String(amount)} 枚，口袋里只有 ${String(row.chips)} 枚`);
  }
  row.chips -= amount;
  row.committedThisStreet += amount;
  row.committedTotal += amount;
  run.potTotal += amount;
  row.inHand = true;
}

function streetKey(phase: 'FLOP' | 'TURN' | 'RIVER'): 'flop' | 'turn' | 'river' {
  return phase === 'FLOP' ? 'flop' : phase === 'TURN' ? 'turn' : 'river';
}

/** 公共牌张数 → 所在街。`null` = 不是合法的街（2 张、6 张这类手误） */
function phaseForBoard(length: number): 'FLOP' | 'TURN' | 'RIVER' | null {
  return length === 3 ? 'FLOP' : length === 4 ? 'TURN' : length === 5 ? 'RIVER' : null;
}

/**
 * 一街收尾：街内下注清零、`currentBet` 归零、`lastRaiseSize` 回到一个大盲。
 *
 * 抄的是 `dealStreet()` 开头那段复位。谁该行动不在这里定：真实的下一手行动人是引擎按
 * 位置算出来的，脚本用一帧明确的 `turn` 说给他。
 */
function closeStreet(run: Run): void {
  run.currentBet = 0;
  run.lastRaiseSize = run.config.bigBlind;
  run.currentTurn = null;
  run.deadlineMs = null;
  run.timeoutWarning = null;
  for (const row of run.rows) {
    row.committedThisStreet = 0;
    row.hasActed = false;
    row.legal = NO_LEGAL;
  }
}

/** 一个 emit 用的累加器：`base` 只用来给 `turn:change.deadline` 凑一个名义绝对时刻 */
interface Sink {
  readonly events: S2C_Broadcast[];
  readonly base: number;
}

function applyOp(run: Run, op: ScriptOp, sink: Sink): void {
  switch (op.t) {
    case 'start': {
      run.handNo += 1;
      run.handId = `replay-${String(run.handNo)}`;
      /*
        直接落 `PREFLOP`，不落 `DEALING`。`startHand()` 确实把 `'DEALING'` 记进了 `phases`，
        但那只是变更记录（服务端没人读），**一次 patch 落地时 `state.phase` 已经是 `PREFLOP`**
        （`table-flow.ts` 构造 `next` 时就这么写的）。发牌是动画，不是状态。
        回放器写一个线上永远不会出现的终态，就是在给动画造一个假观众。
      */
      run.phase = 'PREFLOP';
      run.board = [];
      run.pots = [];
      run.awards = [];
      run.results = [];
      run.reveals = [];
      run.potTotal = 0;
      run.lastRaiseSize = run.config.bigBlind;
      run.dealer = op.dealer;
      run.sb = op.sb;
      run.bb = op.bb;
      run.currentTurn = null;
      run.deadlineMs = null;
      run.nextHandMs = null;
      run.timeoutWarning = null;
      run.runOutBoard = false;
      run.turnVersion += 1;
      for (const row of run.rows) {
        row.committedThisStreet = 0;
        row.committedTotal = 0;
        row.folded = false;
        row.allIn = false;
        row.hasActed = false;
        row.hole = null;
        row.legal = NO_LEGAL;
        row.inHand = false;
      }
      run.startChips = run.rows.map((row) => row.chips);
      spend(run, op.sb, run.config.smallBlind);
      spend(run, op.bb, run.config.bigBlind);
      // `currentBet` = 大盲那一格的实际投入（`Math.min(chips, blind)`），所以短筹码大盲不会把线抬高。
      run.currentBet = at(run.rows, op.bb, '盲注').committedThisStreet;
      sink.events.push({
        t: 'hand:start',
        handId: run.handId,
        dealerSeat: op.dealer,
        sbSeat: op.sb,
        bbSeat: op.bb,
      });
      return;
    }
    case 'shuffle': {
      sink.events.push({ t: 'shuffle' });
      return;
    }
    case 'deal': {
      let count = 0;
      op.holes.forEach((hole, seat) => {
        if (hole === null) return;
        const row = at(run.rows, seat, '发底牌');
        row.hole = hole;
        row.inHand = true;
        count += 1;
      });
      sink.events.push({ t: 'deal:start', count, startSeat: run.sb ?? 0 });
      return;
    }
    case 'turn': {
      run.currentTurn = op.seat;
      run.timeoutWarning = op.warn ?? null;
      run.deadlineMs = op.seat === null ? null : (op.seconds ?? DEFAULT_TURN_SECONDS) * 1_000;
      for (const row of run.rows) row.legal = NO_LEGAL;
      if (op.legal !== undefined && op.seat !== null) at(run.rows, op.seat, '行动提示').legal = op.legal;
      if (op.seat !== null) {
        run.turnVersion += 1;
        sink.events.push({
          t: 'turn:change',
          seatIndex: op.seat,
          deadline: sink.base + (run.deadlineMs ?? 0),
        });
      }
      return;
    }
    case 'act': {
      const row = at(run.rows, op.seat, '行动');
      const before = row.chips;
      row.hasActed = true;
      row.legal = NO_LEGAL;
      switch (op.action.type) {
        case 'raise': {
          const amount = op.action.totalBet - row.committedThisStreet;
          run.lastRaiseSize = op.action.totalBet - run.currentBet;
          run.currentBet = op.action.totalBet;
          spend(run, op.seat, amount);
          break;
        }
        case 'call': {
          spend(run, op.seat, run.currentBet - row.committedThisStreet);
          break;
        }
        case 'allIn': {
          const total = row.committedThisStreet + row.chips;
          if (total > run.currentBet) {
            run.lastRaiseSize = total - run.currentBet;
            run.currentBet = total;
          }
          row.allIn = true;
          spend(run, op.seat, row.chips);
          break;
        }
        case 'fold': {
          row.folded = true;
          break;
        }
        case 'check': {
          break;
        }
      }
      sink.events.push({
        t: 'action:made',
        seatIndex: op.seat,
        action: op.action,
        chipsDelta: row.chips - before,
      });
      return;
    }
    case 'street': {
      sink.events.push({ t: 'round:end', phase: run.phase });
      closeStreet(run);
      run.board = [...run.board, ...op.cards];
      run.phase = op.phase;
      sink.events.push({ t: 'board:deal', phase: streetKey(op.phase), cards: op.cards });
      return;
    }
    case 'roundEnd': {
      sink.events.push({ t: 'round:end', phase: run.phase });
      closeStreet(run);
      return;
    }
    case 'runout': {
      sink.events.push({ t: 'round:end', phase: run.phase });
      closeStreet(run);
      run.runOutBoard = true;
      for (const cards of op.streets) {
        if (cards.length === 0) throw new Error('回放脚本的 run-out 里有一街是空的');
        run.board = [...run.board, ...cards];
        const phase = phaseForBoard(run.board.length);
        if (phase === null) {
          throw new Error(`run-out 之后公共牌累计 ${String(run.board.length)} 张，落不到合法的一街`);
        }
        run.phase = phase;
        sink.events.push({ t: 'board:deal', phase: streetKey(phase), cards });
      }
      return;
    }
    case 'show': {
      run.phase = 'SHOWDOWN';
      run.pots = op.pots.map((pot) => ({ amount: pot.amount, eligible: [...pot.eligible] }));
      run.currentTurn = null;
      run.deadlineMs = null;
      run.timeoutWarning = null;
      sink.events.push({ t: 'showdown:start', pots: run.pots });
      return;
    }
    case 'reveal': {
      for (const seat of op.seats) {
        const row = at(run.rows, seat, '亮牌');
        if (row.hole === null) throw new Error(`回放脚本让 ${seat + 1} 号位亮了没发过的手牌`);
        run.reveals = [...run.reveals, { playerId: row.id, seatIndex: seat, cards: row.hole }];
      }
      return;
    }
    case 'award': {
      const amount = op.payouts.reduce((sum, [, value]) => sum + value, 0);
      if (amount > run.potTotal) {
        throw new Error(`派彩 ${String(amount)} 超过池里的 ${String(run.potTotal)}`);
      }
      run.potTotal -= amount;
      for (const [seat, value] of op.payouts) at(run.rows, seat, '派彩').chips += value;
      const bestFive = [...op.bestFive];
      run.awards = [
        ...run.awards,
        { potIndex: op.potIndex, winners: [...op.winners], amount, handName: op.handName, bestFive },
      ];
      sink.events.push({
        t: 'pot:awarded',
        potIndex: op.potIndex,
        winners: [...op.winners],
        amount,
        handName: op.handName,
        bestFive,
      });
      return;
    }
    case 'walk': {
      const winner = at(run.rows, op.winner, '无人跟注的派彩');
      const amount = run.potTotal;
      run.pots = [{ amount, eligible: [op.winner] }];
      run.potTotal = 0;
      winner.chips += amount;
      run.currentTurn = null;
      run.deadlineMs = null;
      run.timeoutWarning = null;
      const handName = '其他玩家弃牌';
      run.awards = [...run.awards, { potIndex: 0, winners: [op.winner], amount, handName, bestFive: [] }];
      sink.events.push({
        t: 'pot:awarded',
        potIndex: 0,
        winners: [op.winner],
        amount,
        handName,
        bestFive: [],
      });
      return;
    }
    case 'refund': {
      const row = at(run.rows, op.seat, '退还未跟到的下注');
      if (op.amount > run.potTotal) {
        throw new Error(`退回 ${String(op.amount)} 超过池里的 ${String(run.potTotal)}`);
      }
      run.potTotal -= op.amount;
      row.chips += op.amount;
      row.committedTotal -= op.amount;
      row.committedThisStreet = Math.max(0, row.committedThisStreet - op.amount);
      return;
    }
    case 'end': {
      run.phase = 'HAND_END';
      run.currentTurn = null;
      run.deadlineMs = null;
      run.timeoutWarning = null;
      const named = new Map(op.handNames ?? []);
      run.results = run.rows.map((row, seat) => ({
        playerId: row.id,
        seatIndex: seat,
        chips: row.chips,
        delta: row.chips - (run.startChips[seat] ?? row.chips),
        handName: named.get(seat) ?? '',
      }));
      for (const row of run.rows) {
        row.committedThisStreet = 0;
        row.committedTotal = 0;
        row.legal = NO_LEGAL;
      }
      sink.events.push({ t: 'hand:end', results: playerResults(run) });
      if (run.nextHandMs === null) run.nextHandMs = DEFAULT_NEXT_HAND_MS;
      return;
    }
    case 'emoji': {
      sink.events.push({ t: 'player:emoji', seatIndex: op.seat, emoji: op.emoji });
      return;
    }
    case 'wait': {
      run.nextHandMs = op.seconds * 1_000;
      return;
    }
  }
}

/** `hand:end` 事件带的那一份。与快照里的 `results` 同源，只是不含展示用的 `handName` */
function playerResults(run: Run): readonly PlayerResult[] {
  return run.rows.map((row, seat) => ({
    playerId: row.id,
    seatIndex: seat,
    chips: row.chips,
    delta: row.chips - (run.startChips[seat] ?? row.chips),
  }));
}

function handPlayersOf(run: Run): readonly HandPlayerView[] {
  return run.rows.flatMap((row, seat) =>
    row.inHand
      ? [
          {
            playerId: row.id,
            seatIndex: seat,
            nickname: row.nickname,
            avatarSeed: row.avatarSeed,
            folded: row.folded,
            allIn: row.allIn,
            sittingOut: row.sittingOut,
            hasActed: row.hasActed,
            committedThisStreet: row.committedThisStreet,
            committedTotal: row.committedTotal,
          },
        ]
      : [],
  );
}

function playersOf(run: Run, mySeat: number): readonly ConnectedPlayer[] {
  return run.rows.map((row, seat) => ({
    id: row.id,
    nickname: row.nickname,
    avatarSeed: row.avatarSeed,
    isSelf: seat === mySeat,
    seatIndex: seat,
    chips: row.chips,
    presence: 'online',
    isHost: seat === 0,
    legal: row.legal,
  }));
}

function snapshotOf(run: Run, mySeat: number): RoomSnapshot {
  const mine = at(run.rows, mySeat, '视角');
  return {
    code: 'REPLAY',
    players: playersOf(run, mySeat),
    handPlayers: handPlayersOf(run),
    pots: run.pots,
    results: run.results,
    board: run.board,
    awards: run.awards,
    reveals: run.reveals,
    holeCards: mine.hole,
    timeoutWarning: run.timeoutWarning,
    actionPending: false,
    phase: run.phase,
    handId: run.handId,
    handNo: run.handNo,
    turnVersion: run.turnVersion,
    hostId: 'p-0',
    myId: mine.id,
    mySeat,
    isHost: mySeat === 0,
    isMyTurn: run.currentTurn === mySeat,
    dealerSeat: run.dealer,
    sbSeat: run.sb,
    bbSeat: run.bb,
    currentTurn: run.currentTurn,
    deadline: null,
    nextHandAt: null,
    currentBet: run.currentBet,
    lastRaiseSize: run.lastRaiseSize,
    runOutBoard: run.runOutBoard,
    potTotal: run.potTotal,
    introducedChips: run.introducedChips,
    retainedChips: run.rows.reduce((sum, row) => sum + row.chips, 0),
    config: run.config,
    clockOffsetMs: 0,
  };
}

/**
 * 把一帧的「还剩多少毫秒」换算成**这一刻**的绝对时刻。
 *
 * 回放器每推进一帧都调它，所以呼吸环和倒计时永远从脚本写的那一秒开始走，
 * 不会因为页面开了十分钟而一上来就是 0。
 */
export function stampClock(frame: ReplayFrame, now: number): RoomSnapshot {
  const { snapshot, deadlineMs, nextHandMs } = frame;
  if (deadlineMs === null && nextHandMs === null) return snapshot;
  return {
    ...snapshot,
    deadline: deadlineMs === null ? null : now + deadlineMs,
    nextHandAt: nextHandMs === null ? null : now + nextHandMs,
  };
}

/**
 * 脚本 → 帧序列。编译器一路走下来，每一帧产出的都是「那一刻的完整终态」。
 *
 * `mySeat` 决定「我是谁」：只有他那两份底牌进 `holeCards`，别人的正面在这一手结束之前
 * 只会以牌背的形式出现在画面上。所以「底牌有没有偷跑」在回放器里是能直接看见的——
 * 而 `RoomSnapshot` 类型里根本没有存别人底牌的字段，想漏也漏不进去。
 *
 * `base` 只影响 `turn:change` 事件里那个没人消费的名义时刻，默认取当前时间。
 */
export function compileScenario(scenario: ScriptScenario, mySeat = 0, base = Date.now()): ReplayScenario {
  const config: TableViewConfig = {
    smallBlind: scenario.smallBlind,
    bigBlind: scenario.bigBlind,
    startingChips: scenario.seats[0]?.chips ?? 1_000,
    maxPlayers: scenario.seats.length,
    actionTimeoutSec: 30,
    minPlayersToStart: 2,
    felt: 'green',
  };
  const run: Run = {
    phase: 'IDLE',
    handId: 'idle',
    handNo: 0,
    turnVersion: 0,
    board: [],
    pots: [],
    awards: [],
    results: [],
    reveals: [],
    currentBet: 0,
    lastRaiseSize: scenario.bigBlind,
    potTotal: 0,
    dealer: null,
    sb: null,
    bb: null,
    currentTurn: null,
    deadlineMs: null,
    nextHandMs: null,
    timeoutWarning: null,
    runOutBoard: false,
    rows: scenario.seats.map((seat, index) => ({
      id: `p-${String(index)}`,
      nickname: seat.nickname,
      avatarSeed: seat.seed ?? `replay-${scenario.id}-${String(index)}`,
      chips: seat.chips,
      committedThisStreet: 0,
      committedTotal: 0,
      folded: false,
      allIn: false,
      sittingOut: seat.sittingOut === true,
      hasActed: false,
      hole: null,
      legal: NO_LEGAL,
      inHand: false,
    })),
    startChips: scenario.seats.map((seat) => seat.chips),
    config,
    introducedChips: scenario.seats.reduce((sum, seat) => sum + seat.chips, 0),
  };
  at(run.rows, mySeat, '视角');

  const frames: ReplayFrame[] = scenario.frames.map((frame) => {
    const sink: Sink = { events: [], base };
    for (const op of frame.ops) applyOp(run, op, sink);
    return {
      label: frame.label,
      note: frame.note ?? '',
      snapshot: snapshotOf(run, mySeat),
      events: sink.events,
      deadlineMs: run.deadlineMs,
      nextHandMs: run.nextHandMs,
    };
  });

  return { ...scenario, frames };
}
