import { ArraySchema } from '@colyseus/schema';
import { getTableLegalActions, type TableState } from '@poker-room/shared';
import {
  HandPlayer, PlayerSlot, type PokerRoomState, PublicCard, PublicPot, PublicResult,
} from './schema/PokerRoomState';

/** 只映射声明的公开字段；绝不序列化整个引擎状态。相同 tick 不产生集合抖动。 */
export function syncPublicState(
  target: PokerRoomState, source: TableState, now: number, previous?: TableState,
): void {
  if (source === previous) return;
  target.hostId = source.hostId ?? '';
  target.phase = source.phase;
  target.handId = source.handId;
  target.handNo = source.handNo;
  target.turnVersion = source.turnVersion;
  target.serverTime = now;
  target.dealerSeat = source.dealerSeat ?? -1;
  target.sbSeat = source.sbSeat ?? -1;
  target.bbSeat = source.bbSeat ?? -1;
  target.currentTurn = source.currentTurn ?? -1;
  target.deadline = source.deadline ?? 0;
  target.nextHandAt = source.nextHandAt ?? 0;
  target.currentBet = source.currentBet;
  target.lastRaiseSize = source.lastRaiseSize;
  target.runOutBoard = source.runOutBoard;
  target.potTotal = source.participants.reduce((sum, p) => sum + p.committedTotal, 0);
  target.introducedChips = source.introducedChips;
  target.retainedChips = source.accounts.reduce((sum, p) => sum + (p.presence === 'left' ? p.chips : 0), 0);
  target.config.smallBlind = source.config.smallBlind;
  target.config.bigBlind = source.config.bigBlind;
  target.config.startingChips = source.config.startingChips;
  target.config.maxPlayers = source.config.maxPlayers;
  target.config.actionTimeoutSec = source.config.actionTimeoutSec;
  target.config.minPlayersToStart = source.config.minPlayersToStart;
  target.config.felt = source.config.felt;

  const present = new Set<string>();
  for (const account of source.accounts) {
    if (account.presence === 'left') continue;
    present.add(account.id);
    const slot = target.players.get(account.id) ?? new PlayerSlot();
    slot.id = account.id;
    slot.nickname = account.nickname;
    slot.avatarSeed = account.avatarSeed;
    slot.seatIndex = account.seatIndex ?? -1;
    slot.chips = account.chips;
    slot.presence = account.presence;
    const legal = getTableLegalActions(source, account.id);
    slot.canFold = legal.canFold;
    slot.canCheck = legal.canCheck;
    slot.callAmount = legal.callAmount;
    slot.canRaise = legal.canRaise;
    slot.minRaiseTotal = legal.minRaiseTotal;
    slot.maxRaiseTotal = legal.maxRaiseTotal;
    slot.canAllIn = legal.canAllIn;
    target.players.set(account.id, slot);
  }
  for (const id of target.players.keys()) if (!present.has(id)) target.players.delete(id);

  const participants = new Set<string>();
  for (const p of source.participants) {
    participants.add(p.playerId);
    // 引擎永久保留账户，因此离开者的昵称与本手冻结身份仍可显示。
    const account = source.accounts.find((a) => a.id === p.playerId)!;
    const hand = target.handPlayers.get(p.playerId) ?? new HandPlayer();
    hand.playerId = p.playerId;
    hand.seatIndex = p.seatIndex;
    hand.nickname = account.nickname;
    hand.avatarSeed = account.avatarSeed;
    hand.folded = p.folded;
    hand.allIn = p.allIn;
    hand.sittingOut = p.sittingOut;
    hand.hasActed = p.hasActed;
    hand.committedThisStreet = p.committedThisStreet;
    hand.committedTotal = p.committedTotal;
    target.handPlayers.set(p.playerId, hand);
  }
  for (const id of target.handPlayers.keys()) if (!participants.has(id)) target.handPlayers.delete(id);
  if (source.board !== previous?.board) {
    target.board = new ArraySchema(...source.board.map((c) => new PublicCard({ rank: c.rank, suit: c.suit })));
  }
  if (source.pots !== previous?.pots) {
    target.pots = new ArraySchema(...source.pots.map((p) => new PublicPot({
      amount: p.amount, eligible: new ArraySchema(...p.eligible),
    })));
  }
  if (source.results !== previous?.results) {
    target.results = new ArraySchema(...source.results.map((r) => new PublicResult({
      playerId: r.playerId, seatIndex: r.seatIndex, chips: r.chips, delta: r.delta, handName: r.handName ?? '',
    })));
  }
}
