import { isBettingPhase, type Action, type Phase, type PlayerHandState } from '../types';
import { RuleError } from './errors';

export interface BettingState {
  readonly players: readonly PlayerHandState[];
  readonly phase: Phase;
  readonly currentBet: number;
  readonly lastRaiseSize: number;
  readonly currentTurn: number | null;
}

export interface RoundStatus {
  readonly roundEnded: boolean;
  readonly runOutBoard: boolean;
  readonly winnerSeat: number | null;
}

export interface BettingUpdate extends RoundStatus {
  readonly state: BettingState;
  readonly action: Action;
  readonly chipsDelta: number;
}

export interface LegalActions {
  readonly canFold: boolean;
  readonly canCheck: boolean;
  readonly callAmount: number;
  readonly canRaise: boolean;
  readonly minRaiseTotal: number;
  readonly maxRaiseTotal: number;
  readonly canAllIn: boolean;
}

function canAct(player: PlayerHandState): boolean {
  return !player.folded && !player.allIn && !player.sittingOut;
}

export function getRoundStatus(state: BettingState): RoundStatus {
  const survivors = state.players.filter((player) => !player.folded);
  if (survivors.length === 1) {
    return { roundEnded: true, runOutBoard: false, winnerSeat: survivors[0]!.seatIndex };
  }
  const active = survivors.filter(canAct);
  // "只剩一个还能行动的人、而且他已经跟平" ⇒ 这一街到此为止，直接跑完公共牌。
  // 这里刻意**不看** `hasActed`：翻牌前的大盲 option 只在"还有人能跟他的加注"时才有意义，
  // 其余人都已全下时无人可跟，下注权是关闭的（此时他唯一能做的"过牌"不改变任何事）。
  // 大盲真正的 option 走下面那条通用判定：只要还有第二个能行动的人没跟平，回合就不结束。
  if (
    survivors.length > 1 &&
    (active.length === 0 ||
      (active.length === 1 && active[0]!.committedThisStreet >= state.currentBet))
  ) {
    return { roundEnded: true, runOutBoard: true, winnerSeat: null };
  }
  return {
    roundEnded:
      survivors.length > 0 &&
      active.every((player) => player.hasActed && player.committedThisStreet >= state.currentBet),
    runOutBoard: false,
    winnerSeat: null,
  };
}

/** 本街"还需要/还可以行动"的候选人，按座位升序。`nextToAct` 的唯一取材来源。 */
function actingCandidates(state: BettingState): PlayerHandState[] {
  return state.players
    .filter((player) => canAct(player) && (!player.hasActed || toCall(state, player) > 0))
    .sort((a, b) => a.seatIndex - b.seatIndex);
}

/**
 * 从 `afterSeat` **之后**（不含）顺时针找第一个可行动的人，绕回座位表起点。
 * 街首与"上一位行动者"共用这一个语义：翻牌前传 `bbSeat`（于是三人以上是 UTG、两人桌绕回庄家/小盲），
 * 每条下注街起点传 `dealerSeat`（见 §5.2「庄家按钮的下一位」与 §5.3：两人桌按钮**不是**行动起点）。
 */
export function nextToAct(state: BettingState, afterSeat: number): number | null {
  const candidates = actingCandidates(state);
  return (
    (candidates.find((player) => player.seatIndex > afterSeat) ?? candidates[0])?.seatIndex ?? null
  );
}

function toCall(state: BettingState, player: PlayerHandState): number {
  // 短 BB 的实际投入可能小于 SB，不能产生负数跟注。
  return Math.max(0, state.currentBet - player.committedThisStreet);
}

function getActor(state: BettingState, seatIndex: number): PlayerHandState | RuleError {
  const player = state.players.find((entry) => entry.seatIndex === seatIndex);
  if (!player) return new RuleError('NOT_SEATED', '玩家未入座');
  if (!isBettingPhase(state.phase) || state.currentTurn === null) {
    return new RuleError('HAND_NOT_STARTED', '当前没有进行中的下注轮');
  }
  if (state.currentTurn !== seatIndex) return new RuleError('NOT_YOUR_TURN', '尚未轮到你行动');
  if (player.folded) return new RuleError('ALREADY_FOLDED', '玩家已经弃牌');
  if (player.allIn) return new RuleError('ALREADY_ALLIN', '玩家已经全下');
  if (player.sittingOut) return new RuleError('INVALID_ACTION', '离座玩家不能行动');
  return player;
}

function parseAction(input: unknown): Action | RuleError {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || !('type' in input)) {
    return new RuleError('INVALID_ACTION', '动作必须是包含 type 的对象');
  }
  switch (input.type) {
    case 'fold':
    case 'check':
    case 'call':
    case 'allIn':
      return { type: input.type };
    case 'raise':
      if (
        !('totalBet' in input) ||
        typeof input.totalBet !== 'number' ||
        !Number.isSafeInteger(input.totalBet) ||
        input.totalBet <= 0
      ) {
        return new RuleError('INVALID_ACTION', '加注总额必须是安全正整数');
      }
      return { type: 'raise', totalBet: input.totalBet };
    default:
      return new RuleError('INVALID_ACTION', '未知动作类型');
  }
}

interface ActionPlan {
  readonly action: Action;
  readonly chipsDelta: number;
  readonly raiseSize: number;
}

function planRaise(
  state: BettingState,
  player: PlayerHandState,
  action: Extract<Action, { type: 'raise' | 'allIn' }>,
): ActionPlan | RuleError {
  if (player.chips <= 0) return new RuleError('INSUFFICIENT_CHIPS', '没有可投入的筹码');
  const maxTotal = player.committedThisStreet + player.chips;
  // §3.5 / 集成场景 8：超额 raise 自动转全下，而不是拒绝。
  const totalBet = action.type === 'allIn' ? maxTotal : Math.min(action.totalBet, maxTotal);
  const allIn = totalBet === maxTotal;
  if (totalBet <= player.committedThisStreet || (totalBet <= state.currentBet && !allIn)) {
    return new RuleError('INVALID_ACTION', '加注必须提高本轮下注总额');
  }
  const raiseSize = Math.max(0, totalBet - state.currentBet);
  if (raiseSize > 0) {
    // 已行动者可全下跟注，但不能借 allIn 绕过短全下后的加注权限制。
    if (player.hasActed) return new RuleError('INVALID_ACTION', '加注权尚未重新开启');
    if (raiseSize < state.lastRaiseSize && !allIn)
      return new RuleError('RAISE_TOO_SMALL', '加注未达到最小增量');
  }
  return {
    action: allIn ? { type: 'allIn' } : action,
    chipsDelta: totalBet - player.committedThisStreet,
    raiseSize,
  };
}

/** 实际动作和合法提示共用判定数据，校验期间不改状态。 */
function planAction(
  state: BettingState,
  player: PlayerHandState,
  action: Action,
): ActionPlan | RuleError {
  const owed = toCall(state, player);
  if (action.type === 'fold' || action.type === 'check') {
    if (action.type === 'check' && owed > 0)
      return new RuleError('INVALID_ACTION', '需要跟注时不能过牌');
    return { action, chipsDelta: 0, raiseSize: 0 };
  }
  if (action.type === 'call') {
    if (owed === 0) return new RuleError('INVALID_ACTION', '无需跟注，请过牌');
    const chipsDelta = Math.min(owed, player.chips);
    return {
      action: chipsDelta === player.chips ? { type: 'allIn' } : action,
      chipsDelta,
      raiseSize: 0,
    };
  }
  return planRaise(state, player, action);
}

export function applyBettingAction(
  state: BettingState,
  seatIndex: number,
  input: unknown,
): BettingUpdate {
  const player = getActor(state, seatIndex);
  if (player instanceof RuleError) throw player;
  const action = parseAction(input);
  if (action instanceof RuleError) throw action;
  const plan = planAction(state, player, action);
  if (plan instanceof RuleError) throw plan;
  const fullRaise = plan.raiseSize > 0 && plan.raiseSize >= state.lastRaiseSize;
  const players = state.players.map((entry): PlayerHandState => {
    if (entry.seatIndex === seatIndex) {
      return {
        ...entry,
        chips: entry.chips - plan.chipsDelta,
        committedThisStreet: entry.committedThisStreet + plan.chipsDelta,
        committedTotal: entry.committedTotal + plan.chipsDelta,
        folded: plan.action.type === 'fold',
        allIn: plan.action.type === 'allIn',
        hasActed: true,
      };
    }
    return fullRaise && canAct(entry) ? { ...entry, hasActed: false } : entry;
  });
  const nextState: BettingState = {
    ...state,
    players,
    currentBet: state.currentBet + plan.raiseSize,
    lastRaiseSize: fullRaise ? plan.raiseSize : state.lastRaiseSize,
  };
  const status = getRoundStatus(nextState);
  return {
    ...status,
    state: {
      ...nextState,
      currentTurn: status.roundEnded ? null : nextToAct(nextState, seatIndex),
    },
    action: plan.action,
    chipsDelta: plan.chipsDelta,
  };
}

export function getLegalActions(state: BettingState, seatIndex: number): LegalActions {
  const player = getActor(state, seatIndex);
  if (player instanceof RuleError) {
    return {
      canFold: false,
      canCheck: false,
      callAmount: 0,
      canRaise: false,
      minRaiseTotal: 0,
      maxRaiseTotal: 0,
      canAllIn: false,
    };
  }
  const allowed = (action: Action): boolean =>
    !(planAction(state, player, action) instanceof RuleError);
  const call = planAction(state, player, { type: 'call' });
  const minRaiseTotal = state.currentBet + state.lastRaiseSize;
  const maxRaiseTotal = player.committedThisStreet + player.chips;
  return {
    canFold: allowed({ type: 'fold' }),
    canCheck: allowed({ type: 'check' }),
    callAmount: call instanceof RuleError ? 0 : call.chipsDelta,
    // 滑杆仅暴露可支付的完整加注，短全下由独立按钮提供。
    canRaise: maxRaiseTotal >= minRaiseTotal && allowed({ type: 'raise', totalBet: minRaiseTotal }),
    minRaiseTotal,
    maxRaiseTotal,
    canAllIn: allowed({ type: 'allIn' }),
  };
}

export function getTimeoutAction(state: BettingState): Action {
  if (state.currentTurn === null) throw new RuleError('HAND_NOT_STARTED', '当前没有行动者');
  const player = getActor(state, state.currentTurn);
  if (player instanceof RuleError) throw player;
  return { type: toCall(state, player) > 0 ? 'fold' : 'check' };
}
