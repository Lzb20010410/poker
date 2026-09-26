import type { PlayerProfile, S2C_Broadcast } from '../protocol';
import { isBettingPhase } from '../types';
import { nextToAct } from './betting';
import { RuleError } from './errors';
import { advanceHand, startHand } from './table-flow';
import {
  assertChips,
  assertSeat,
  chooseHost,
  getAccount,
  requireHost,
  requireOnline,
  toBetting,
  update,
  validateConfig,
  type TableContext,
  type TableState,
  type TableUpdate,
} from './table-state';

/**
 * `accounts` 是**只追加**的：`left` 的人永远留在数组里，从不删除。
 * 这不是漏写了清理。三席审查（服务端生命周期 #5）建议"剪掉 `left` 记录"治内存增长，
 * M1 判定为不改，因为四处正确性都依赖这条账本：
 * 一、`table-state.ts:153-154` 结算时按 `playerId` 回查余额（注释原话"账号永久保留，
 *   不以可复用座位查余额"），剪掉后是 `undefined.chips` 的 TypeError；
 * 二、`update()` 的守恒熔断拿 `accounts` 总额对 `introducedChips`，剪掉记录而不回收筹码
 *   会当场抛「牌桌筹码不守恒」；
 * 三、`getAccount` 靠 `presence !== 'left'` 拒掉已离开的人，这条拒绝之所以是"拒"而不是"查不到"，
 *   正因为记录还留着；一旦剪掉，同一个 id 再进来就能绕过下面那条「玩家 id 不能复用」的检查，
 *   而 `handPlayers`（按 `playerId` 索引，D-014）可能还认得这个 id 的旧身份，亮牌与结算张冠李戴；
 * 四、`introducedChips` 记的是"这张桌子总共造出过多少筹码"，删记录不减它=谎报，减它=偷偷造筹码。
 *
 * **代价**（M2 需要你点头才动）：容量 2 人的房间里，一个连接稳定的玩家陪着一个反复
 * "加入—离开"的人，`accounts` 会一直变长、`introducedChips` 会一直涨；而且
 * `PokerRoom.trackEmpty()` 的 `clients.length === 0` 永不成立，30 分钟空闲销毁那条路也就永不武装。
 * 正确性没坏（容量看 `present`，守恒看总额），坏的是内存和"空房回收"。
 * 能红的断言：`table-lifecycle.test.ts`「账号账本只追加：墓碑留在账本上，id 不能被人顶用」。
 * 详见 PROGRESS.md 的建议条目。
 */
export function addTablePlayer(
  state: TableState,
  profile: PlayerProfile,
  _ctx: TableContext,
): TableUpdate {
  if (state.accounts.some((a) => a.id === profile.id))
    throw new RuleError('INVALID_ACTION', '玩家 id 不能复用');
  const present = state.accounts.filter((a) => a.presence !== 'left');
  if (present.length >= state.config.maxPlayers) throw new RuleError('ROOM_FULL', '房间已满');
  const introducedChips = state.introducedChips + state.config.startingChips;
  assertChips(introducedChips);
  // 房间人数小于容量，至少有一个空座。
  const seatIndex = Array.from({ length: state.config.maxPlayers }, (_, i) => i).find(
    (seat) => !present.some((a) => a.seatIndex === seat),
  )!;
  const safeProfile = {
    id: profile.id,
    nickname: profile.nickname,
    avatarSeed: profile.avatarSeed,
  };
  return update(
    chooseHost({
      ...state,
      introducedChips,
      accounts: [
        ...state.accounts,
        { ...safeProfile, seatIndex, chips: state.config.startingChips, presence: 'online' },
      ],
    }),
    [{ t: 'player:joined', seatIndex, profile: safeProfile }],
  );
}

export function sitPlayer(
  state: TableState,
  id: string,
  seat: number,
  _ctx: TableContext,
): TableUpdate {
  const account = getAccount(state, id);
  requireOnline(account);
  assertSeat(seat, state.config);
  if (account.seatIndex === seat) return update(state);
  if (state.accounts.some((a) => a.seatIndex === seat))
    throw new RuleError('INVALID_ACTION', '座位已被占用');
  if (
    isBettingPhase(state.phase) &&
    state.participants.some((p) => p.playerId === id && !p.folded && !p.sittingOut)
  )
    throw new RuleError('INVALID_ACTION', '请先离座再换座位');
  const events: S2C_Broadcast[] =
    account.seatIndex === null ? [] : [{ t: 'player:left', seatIndex: account.seatIndex }];
  events.push({
    t: 'player:joined',
    seatIndex: seat,
    profile: { id, nickname: account.nickname, avatarSeed: account.avatarSeed },
  });
  return update(
    chooseHost({
      ...state,
      accounts: state.accounts.map((a) => (a.id === id ? { ...a, seatIndex: seat } : a)),
    }),
    events,
  );
}

export function standPlayer(state: TableState, id: string, ctx: TableContext): TableUpdate {
  const account = getAccount(state, id);
  if (account.seatIndex === null) return update(state);
  let next = chooseHost({
    ...state,
    accounts: state.accounts.map((a) => (a.id === id ? { ...a, seatIndex: null } : a)),
  });
  const events: S2C_Broadcast[] = [{ t: 'player:left', seatIndex: account.seatIndex }];
  const participant = state.participants.find((p) => p.playerId === id);
  if (!isBettingPhase(state.phase) || !participant) return update(next, events);
  next = {
    ...next,
    participants: next.participants.map((p) =>
      p.playerId === id
        ? {
            ...p,
            sittingOut: true,
            folded: p.folded || !p.allIn,
            hasActed: true,
          }
        : p,
    ),
  };
  if (participant.folded || participant.allIn) return update(next, events);
  // 这是强制退出，不伪造 currentTurn 去调用其他玩家的下注入口。
  events.unshift({
    t: 'action:made',
    seatIndex: participant.seatIndex,
    action: { type: 'fold' },
    chipsDelta: 0,
  });
  const wasTurn = state.currentTurn === participant.seatIndex;
  if (wasTurn) next = { ...next, currentTurn: nextToAct(toBetting(next), participant.seatIndex) };
  const advanced = advanceHand(next, ctx, wasTurn);
  return { ...advanced, events: [...events, ...advanced.events] };
}

export function setPlayerPresence(
  state: TableState,
  id: string,
  presence: 'online' | 'reconnecting' | 'left',
  ctx: TableContext,
): TableUpdate {
  getAccount(state, id);
  const changed = presence === 'left' ? standPlayer(state, id, ctx) : update(state);
  // 本函数是全引擎唯一一个"别的函数已经产出了状态，我再自己拼一个新状态"的入口，
  // 所以拼完必须重新过一遍 `update()`：它是筹码守恒的唯一绊线。
  // 少了这一脚，任何在 presence/hostId 交接时顺手改动筹码的 bug 都能安静穿过去。
  return update(
    chooseHost({
      ...changed.newState,
      accounts: changed.newState.accounts.map((a) => (a.id === id ? { ...a, presence } : a)),
    }),
    changed.events,
    // 离桌者已经不在房间里，他自己那条私密消息（本手亮牌等）不必再发
    changed.privateMessages.filter((m) => presence !== 'left' || m.playerId !== id),
    changed.phases,
  );
}

export function rebuyPlayer(state: TableState, id: string, _ctx: TableContext): TableUpdate {
  const account = getAccount(state, id);
  requireOnline(account);
  if (state.phase !== 'IDLE' && state.phase !== 'HAND_END')
    throw new RuleError('INVALID_ACTION', '本手结束后才可重买');
  if (account.seatIndex === null) throw new RuleError('NOT_SEATED', '请先入座');
  if (account.chips !== 0) throw new RuleError('INVALID_ACTION', '只有零筹码可以重买');
  const introducedChips = state.introducedChips + state.config.startingChips;
  assertChips(introducedChips);
  return update(
    {
      ...state,
      introducedChips,
      accounts: state.accounts.map((a) =>
        a.id === id ? { ...a, chips: state.config.startingChips } : a,
      ),
    },
    [{ t: 'chips:rebuy', seatIndex: account.seatIndex }],
  );
}

export function setTableConfig(state: TableState, id: string, patch: unknown): TableUpdate {
  requireHost(state, id);
  if (state.phase !== 'IDLE') throw new RuleError('CONFIG_LOCKED', '仅等待阶段允许更改配置');
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch))
    throw new RuleError('INVALID_ACTION', '配置补丁必须是对象');
  const config = validateConfig({ ...state.config, ...patch });
  const present = state.accounts.filter((a) => a.presence !== 'left');
  if (
    present.length > config.maxPlayers ||
    present.some((a) => a.seatIndex !== null && a.seatIndex >= config.maxPlayers)
  )
    throw new RuleError('ROOM_FULL', '当前玩家或座位与容量冲突');
  return update({ ...state, config });
}

export function startTable(state: TableState, id: string, ctx: TableContext): TableUpdate {
  requireHost(state, id);
  return startHand(state, ctx);
}
