import type { PrivateMessage, S2C_Broadcast } from '../protocol';
import { ACTION_WARNING_SEC, isBettingPhase, type Phase } from '../types';
import {
  applyBettingAction,
  getLegalActions,
  getRoundStatus,
  getTimeoutAction,
  nextToAct,
  type LegalActions,
} from './betting';
import { Deck } from './deck';
import { RuleError } from './errors';
import { holeMessage, settleHand } from './table-settlement';
import {
  activeAccounts,
  fromBetting,
  getAccount,
  requireOnline,
  toBetting,
  update,
  type TableContext,
  type TableParticipant,
  type TableState,
  type TableUpdate,
} from './table-state';

function dealStreet(state: TableState): TableUpdate {
  const phase = state.phase === 'PREFLOP' ? 'FLOP' : state.phase === 'FLOP' ? 'TURN' : 'RIVER';
  const deck = new Deck(state.deck);
  deck.burn();
  const cards = deck.deal(phase === 'FLOP' ? 3 : 1);
  const next: TableState = {
    ...state,
    phase,
    deck: deck.deal(deck.remaining),
    burned: [...state.burned, ...deck.burned],
    board: [...state.board, ...cards],
    currentBet: 0,
    lastRaiseSize: state.config.bigBlind,
    participants: state.participants.map((p) => ({
      ...p,
      committedThisStreet: 0,
      hasActed: false,
    })),
  };
  return update(
    { ...next, currentTurn: nextToAct(toBetting(next), state.dealerSeat!) },
    [
      {
        t: 'board:deal',
        phase: phase === 'FLOP' ? 'flop' : phase === 'TURN' ? 'turn' : 'river',
        cards,
      },
    ],
    [],
    [phase],
  );
}

/** 普通动作与强制离座共享街推进；离座非行动者时不重置当前人的时钟。 */
export function advanceHand(state: TableState, ctx: TableContext, publishTurn = true): TableUpdate {
  const status = getRoundStatus(toBetting(state));
  let next = state;
  const events: S2C_Broadcast[] = [];
  const phases: Phase[] = [];
  if (status.roundEnded) {
    events.push({ t: 'round:end', phase: state.phase });
    if (status.winnerSeat !== null) {
      const settled = settleHand(next, ctx, status.winnerSeat);
      return { ...settled, events: [...events, ...settled.events] };
    }
    next = { ...next, runOutBoard: status.runOutBoard };
    while (next.phase !== 'RIVER') {
      const street = dealStreet(next);
      next = street.newState;
      events.push(...street.events);
      phases.push(...street.phases);
      if (!status.runOutBoard) break;
    }
    if (state.phase === 'RIVER' || status.runOutBoard) {
      const settled = settleHand(next, ctx, null);
      return {
        ...settled,
        events: [...events, ...settled.events],
        phases: [...phases, ...settled.phases],
      };
    }
    publishTurn = true;
  }
  if (publishTurn && next.currentTurn !== null) {
    const deadline = ctx.now + next.config.actionTimeoutSec * 1000;
    next = { ...next, turnVersion: next.turnVersion + 1, deadline };
    events.push({ t: 'turn:change', seatIndex: next.currentTurn!, deadline });
  }
  return update(next, events, [], phases);
}

export function startHand(state: TableState, ctx: TableContext): TableUpdate {
  if (
    state.phase !== 'IDLE' &&
    !(state.phase === 'HAND_END' && state.nextHandAt !== null && ctx.now >= state.nextHandAt)
  )
    throw new RuleError('INVALID_ACTION', '当前不能开始下一手');
  const active = activeAccounts(state);
  if (active.length < state.config.minPlayersToStart)
    throw new RuleError('INVALID_ACTION', '至少需要两名在线且有筹码的玩家');
  // active 已排序且至少两人，循环索引与非空访问由此保证。
  const dealerIndex =
    state.dealerSeat === null
      ? 0
      : Math.max(
          0,
          active.findIndex((p) => p.seatIndex! > state.dealerSeat!),
        );
  // §5.3：两人桌庄家**就是**小盲（sbIndex 与 dealerIndex 重合），三人以上才依次是小盲、大盲。
  // sbIndex 同时是 §1.3 的发牌起点：底牌从"小盲位"开始顺时针每人一张。
  const sbIndex = (dealerIndex + (active.length === 2 ? 0 : 1)) % active.length;
  const bbIndex = (dealerIndex + (active.length === 2 ? 1 : 2)) % active.length;
  const dealerSeat = active[dealerIndex]!.seatIndex!;
  const sbSeat = active[sbIndex]!.seatIndex!;
  const bbSeat = active[bbIndex]!.seatIndex!;
  const deck = Deck.fresh(ctx.rand);
  deck.burn();
  const participants: TableParticipant[] = active.map((p) => ({
    playerId: p.id,
    seatIndex: p.seatIndex!,
    holeCards: [],
    folded: false,
    allIn: false,
    sittingOut: false,
    hasActed: false,
    committedThisStreet: 0,
    committedTotal: 0,
  }));
  for (let round = 0; round < 2; round += 1) {
    for (let offset = 0; offset < active.length; offset += 1) {
      const index = (sbIndex + offset) % active.length;
      const p = participants[index]!;
      participants[index] = { ...p, holeCards: [...p.holeCards, deck.dealOne()] };
    }
  }
  const handNo = state.handNo + 1;
  let next: TableState = {
    ...state,
    handNo,
    handId: `hand-${String(handNo)}`,
    dealerSeat,
    sbSeat,
    bbSeat,
    phase: 'PREFLOP',
    participants,
    currentTurn: null,
    currentBet: 0,
    lastRaiseSize: state.config.bigBlind,
    deadline: null,
    nextHandAt: null,
    deck: deck.deal(deck.remaining),
    burned: deck.burned,
    board: [],
    pots: [],
    results: [],
    runOutBoard: false,
  };
  const betting = toBetting(next);
  const players = betting.players.map((p) => {
    const amount = Math.min(
      p.chips,
      p.seatIndex === sbSeat
        ? state.config.smallBlind
        : p.seatIndex === bbSeat
          ? state.config.bigBlind
          : 0,
    );
    return {
      ...p,
      chips: p.chips - amount,
      allIn: p.chips === amount,
      committedThisStreet: amount,
      committedTotal: amount,
    };
  });
  next = fromBetting(next, {
    ...betting,
    players,
    currentBet: players.find((p) => p.seatIndex === bbSeat)!.committedThisStreet,
  });
  // §5.3：三人以上翻牌前由 UTG（大盲下一位）先行动；两人桌大盲的下一位绕回庄家（即小盲），
  // 所以同一个 `nextToAct(bbSeat)` 对两种人数都成立——不要为 heads-up 特判，那会把顺序整个反过来。
  next = { ...next, currentTurn: nextToAct(toBetting(next), bbSeat) };
  const advanced = advanceHand(next, ctx);
  return {
    ...advanced,
    events: [
      { t: 'hand:start', handId: next.handId, dealerSeat, sbSeat, bbSeat },
      { t: 'shuffle' },
      {
        t: 'deal:start',
        count: active.length,
        startSeat: sbSeat,
      },
      ...advanced.events,
    ],
    privateMessages: [
      ...participants.map((p) => holeMessage(next, p)),
      ...advanced.privateMessages,
    ],
    phases: ['DEALING', 'PREFLOP', ...advanced.phases],
  };
}

export function applyAction(
  state: TableState,
  seat: number,
  input: unknown,
  ctx: TableContext,
): TableUpdate {
  const betting = applyBettingAction(toBetting(state), seat, input);
  const advanced = advanceHand(fromBetting(state, betting.state), ctx);
  return {
    ...advanced,
    events: [
      { t: 'action:made', seatIndex: seat, action: betting.action, chipsDelta: betting.chipsDelta },
      ...advanced.events,
    ],
  };
}
export function applyPlayerAction(
  state: TableState,
  id: string,
  input: unknown,
  handId: string,
  turnVersion: number,
  ctx: TableContext,
): TableUpdate {
  const account = getAccount(state, id);
  requireOnline(account);
  if (
    account.seatIndex === null ||
    !state.participants.some((p) => p.playerId === id && p.seatIndex === account.seatIndex)
  )
    throw new RuleError('NOT_SEATED', '未参与当前手牌');
  // 最后一次动作不会再产生下一个行动者，因此结束状态本身也使命令失效。
  if (state.currentTurn === null || state.handId !== handId || state.turnVersion !== turnVersion)
    throw new RuleError('INVALID_ACTION', '动作已过期或重复');
  return applyAction(state, account.seatIndex, input, ctx);
}
export function getTableLegalActions(state: TableState, id: string): LegalActions {
  const account = state.accounts.find((a) => a.id === id && a.presence === 'online');
  const participant = state.participants.find(
    (p) => p.playerId === id && p.seatIndex === account?.seatIndex,
  );
  return getLegalActions(toBetting(state), participant?.seatIndex ?? -1);
}
export function tickTable(state: TableState, ctx: TableContext): TableUpdate {
  // 这里的 `!` 与 getTimeoutWarning 依赖同一条不变量，改动任一分支前请先确认它仍成立：
  // 「下注阶段 + deadline 非空」必然蕴含 currentTurn 非空。理由是 advanceHand 收尾只在
  // currentTurn !== null 时才写入新的 deadline，而 currentTurn 为空只可能来自
  // getRoundStatus ⇒ roundEnded（betting.ts），其两条出口都会把 deadline 清成 null：
  // settleHand（table-settlement.ts 返回 deadline: null）或 dealStreet 之后重新取到行动者。
  // 也就是说"带着旧 deadline 的空轮次"没有合法路径，一旦构造出来就是牌桌状态已被改坏，
  // 抛出由 PokerRoom.tick 的兜底接住（停掉这张桌，不影响同进程其它桌）。
  if (isBettingPhase(state.phase) && state.deadline !== null && ctx.now >= state.deadline)
    return applyAction(state, state.currentTurn!, getTimeoutAction(toBetting(state)), ctx);
  if (state.phase === 'HAND_END' && state.nextHandAt !== null && ctx.now >= state.nextHandAt) {
    if (activeAccounts(state).length < state.config.minPlayersToStart)
      return update({ ...state, phase: 'IDLE', nextHandAt: null }, [], [], ['IDLE']);
    return startHand(state, ctx);
  }
  return update(state);
}
export function getTimeoutWarning(state: TableState, now: number): PrivateMessage | null {
  if (
    !isBettingPhase(state.phase) ||
    state.deadline === null ||
    now >= state.deadline ||
    state.deadline - now > ACTION_WARNING_SEC * 1000
  )
    return null;
  // 同 tickTable：能走到这里说明「下注阶段 + deadline 非空」，该不变量保证 currentTurn 非空，
  // 因此座位查找必然命中。断线玩家保留座位与轮次，也仍能收到重连后的定向提示。
  const p = state.participants.find((p) => p.seatIndex === state.currentTurn)!;
  return {
    playerId: p.playerId,
    message: { t: 'timeoutWarning', remainingSec: Math.ceil((state.deadline - now) / 1000) },
  };
}
