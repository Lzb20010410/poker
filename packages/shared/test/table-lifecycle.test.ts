import { describe, expect, it } from 'vitest';
import {
  addTablePlayer,
  applyAction,
  applyPlayerAction,
  getPrivateMessages,
  getTableLegalActions,
  rebuyPlayer,
  setPlayerPresence,
  setTableConfig,
  sitPlayer,
  standPlayer,
  startHand,
  startTable,
  tickTable,
} from '../src/engine/table';
import { act, checkDown, conserved, context, freeze, table } from './table-fixtures';

describe('table lifecycle', () => {
  it('stands out of turn by folding only that player, retaining the real turn/deadline', () => {
    const state = startHand(table([200, 200, 200]), context()).newState;
    const update = standPlayer(freeze(state), 'p1', context(100));
    expect(update.newState).toMatchObject({
      currentTurn: 0,
      deadline: 30000,
      turnVersion: state.turnVersion,
    });
    expect(update.newState.participants[1]).toMatchObject({
      folded: true,
      sittingOut: true,
      committedTotal: 10,
    });
    expect(update.events).toContainEqual({
      t: 'action:made',
      seatIndex: 1,
      action: { type: 'fold' },
      chipsDelta: 0,
    });
    expect(update.events.filter((e) => e.t === 'turn:change')).toEqual([]);
    checkDown(update.newState);
  });
  it('standing on turn advances; already folded or already standing does not act again', () => {
    const state = startHand(table([200, 200, 200]), context()).newState;
    const update = standPlayer(state, 'p0', context(70));
    expect(update.newState).toMatchObject({ currentTurn: 1, deadline: 30070 });
    expect(standPlayer(update.newState, 'p0', context()).events).toEqual([]);
    let next = sitPlayer(update.newState, 'p0', 4, context()).newState;
    next = standPlayer(next, 'p0', context()).newState;
    expect(next.participants[0]?.seatIndex).toBe(0);
    checkDown(next);
  });
  it('all-in leaver keeps eligibility and receives own payout, never the new occupant', () => {
    let state = startHand(table([30, 80, 200]), context(0, 1)).newState;
    state = act(state, 0, { type: 'allIn' });
    state = setPlayerPresence(freeze(state), 'p0', 'left', context()).newState;
    expect(state.participants[0]).toMatchObject({
      folded: false,
      allIn: true,
      sittingOut: true,
      seatIndex: 0,
    });
    expect(state.accounts[0]).toMatchObject({ seatIndex: null, presence: 'left', chips: 0 });
    state = addTablePlayer(
      state,
      { id: 'new', nickname: 'New', avatarSeed: 'New' },
      context(),
    ).newState;
    expect(state.accounts.at(-1)?.seatIndex).toBe(0);
    expect(getPrivateMessages(state, 'new')).toEqual([]);
    expect(getPrivateMessages(state, 'p0')).toEqual([]);
    expect(getTableLegalActions(state, 'new').canFold).toBe(false);
    expect(() =>
      applyPlayerAction(state, 'new', { type: 'call' }, state.handId, state.turnVersion, context()),
    ).toThrow(expect.objectContaining({ code: 'NOT_SEATED' }));
    state = act(state, 1, { type: 'allIn' });
    state = act(state, 2, { type: 'allIn' });
    expect(state.results.map((p) => p.playerId)).toEqual(['p0', 'p1', 'p2']);
    expect(state.accounts.map((p) => p.chips)).toEqual([90, 0, 220, 2000]);
    expect(state.results[0]).toMatchObject({ playerId: 'p0', seatIndex: 0, chips: 90, delta: 60 });
    // 顶下 p0 座位的新玩家**没参加过这一手**：铁律 #1 下他一条私密消息都不该收到。
    // 原来这里写的是 `.every((m) => m.t === 'showdown:reveal')).toBe(true)` —— 空数组上
    // `.every` 恒真，所以那条断言即使实现改成"什么都不发"也照样绿，等于没断言（见 D-022）。
    expect(getPrivateMessages(state, 'new')).toEqual([]);
    expect(getPrivateMessages(state, 'p0')).toEqual([]);
    conserved(state);
  });
  /**
   * `accounts` 只追加：离开者留下的记录是一张**墓碑**，既不删，也不能被人顶用。
   * 三席审查（服务端生命周期 #5）提出"剪掉 `left` 账号"能治内存与 `introducedChips` 增长。
   * M1 的判定是不改，理由写在这里而不是只写在账本里：
   * 一、`handPlayers` 按 `playerId` 索引并冻住身份（D-014），剪掉记录等于把这个 id 变成可重号，
   *   结算/亮牌就可能把新人当成上一手的那个人；
   * 二、`introducedChips` 是守恒熔断的分母，删记录不减它=谎报，减它=偷偷造筹码；
   * 三、真正的修法（"id 永不复用"的分配规则 + 参与者的 `left` 芯片回收口径）是 M2 的一次决策，
   *   不是 M1 的一行删除。所以这里留一条**故意会挡住那次改动**的用例：谁要做剪枝，必须先让这条变红并说清理由。
   *
   * 探针证据（两次都跑过，逐行还原）：
   * - 删掉 `addTablePlayer` 开头的 id 复用检查 → 本条红在 `expected [Function] to throw an error`，
   *   `table-validation.test.ts`「rejects full room, reused id…」同时红。
   *   说明这条门**原本就有网**（那条用例连离开者的 id 也试过，只是写成裸 `.toThrow()`），
   *   本条新增的是账本长度与筹码回收那一维。
   * - 前向探针：把 `accounts` 改成 `.filter((a) => a.presence !== 'left')`（即审查建议的剪枝）→
   *   shared 3 条红：本条红在 `Error: 牌桌筹码不守恒`（`update()` 的熔断，发生在加第三人时），
   *   「all-in leaver keeps eligibility…」红在 `TypeError: Cannot read properties of undefined
   *   (reading 'chips')`（`table-state.ts:154`），「join ignores extra untrusted chip properties…」
   *   同样红在守恒。也就是**剪枝不是一行删除**：它要求同时定义筹码回收口径。
   */
  it('账号账本只追加：墓碑留在账本上，id 不能被人顶用', () => {
    let state = table([200, 200]);
    for (const id of ['ghost1', 'ghost2', 'ghost3']) {
      state = addTablePlayer(state, { id, nickname: id, avatarSeed: id }, context()).newState;
      state = setPlayerPresence(state, id, 'left', context()).newState;
    }
    expect(state.accounts.map((a) => [a.id, a.presence])).toEqual([
      ['p0', 'online'],
      ['p1', 'online'],
      ['ghost1', 'left'],
      ['ghost2', 'left'],
      ['ghost3', 'left'],
    ]);
    // 容量看的是在场人数，不是账本长度：三个幽灵占过的座位已被复用。
    expect(state.accounts.filter((a) => a.presence !== 'left').map((a) => a.seatIndex)).toEqual([
      0, 1,
    ]);
    expect(() =>
      addTablePlayer(state, { id: 'p0', nickname: 'Ghost', avatarSeed: 'ghost' }, context()),
    ).toThrow(expect.objectContaining({ code: 'INVALID_ACTION' }));
    // 墓碑 id 也不能被"重新激活"成可操作的人。
    expect(() =>
      applyPlayerAction(state, 'ghost1', { type: 'fold' }, state.handId, state.turnVersion, context()),
    ).toThrow(expect.objectContaining({ code: 'NOT_SEATED' }));
    // 代价（审查 #5 说的就是这两行数字）：造出来的筹码永不回收。
    // 2 位真玩家 ×200 + 3 个幽灵 ×2000（DEFAULT startingChips）= 6400。
    expect(state.introducedChips).toBe(6400);
    expect(state.accounts.reduce((sum, a) => sum + a.chips, 0)).toBe(6400);
    conserved(state);
  });
  /**
   * 摊牌亮牌只回放给参加过这一手的人。
   * 亮牌在规则上"已公开"，但公开范围是**这一手的牌桌**：`PokerRoom` 在 onJoin / onReconnect
   * 和每一次 `ping` 上都调 `privateSnapshot` 重放 `getPrivateMessages`（`PokerRoom.ts:160-162,183`），
   * 而原来的判定只看"桌上有没有已结算的多人摊牌"（`table-settlement.ts:36`），不看收的人参没参加。
   * 加上 IDLE 回退不清 `results` 也不清 `participants[].holeCards`（`table-flow.ts:252`），
   * 后果是：拿着配对码后进房的人，会在整个房间生命周期里反复收到上一手所有人的底牌。
   * 这条用例把判定钉回"收信人必须是这一手的参与者"，同时保留参与者重连恢复（那正是 IDLE 重放的本意）。
   */
  it('摊牌亮牌不回放给没参加过这一手的人', () => {
    const played = checkDown(startHand(table([200, 200, 200]), context()).newState);
    expect(played.phase).toBe('HAND_END');
    // 前提：这一手确实是多人摊牌（否则"该发亮牌"的那半个人为没造出来，用例会同形空过）
    expect(played.results.length).toBeGreaterThan(0);
    expect(played.participants.filter((p) => !p.folded).length).toBeGreaterThan(1);
    // 参加过的人重连时仍然拿得到已公开的亮牌
    expect(
      getPrivateMessages(played, 'p1').some((m) => m.message.t === 'showdown:reveal'),
    ).toBe(true);
    const joined = addTablePlayer(
      played,
      { id: 'late', nickname: 'Late', avatarSeed: 'late' },
      context(),
    ).newState;
    expect(getPrivateMessages(joined, 'late')).toEqual([]);
    conserved(joined);
  });
  /**
   * 同一判定要同时管两条路：除了上面那条"重放"路径，摊牌那一刻还有一条**在线推送**路径
   * （`table-settlement.ts:79-80` 原本对所有未离桌账号推 `showdown:reveal`）。两条路必须用同一个
   * 收信人条件，否则"什么时候进房"会变成能不能看到别人底牌的运气。
   */
  it('摊牌时不向没参加这一手的人推送亮牌', () => {
    const started = startHand(table([200, 200, 200]), context()).newState;
    const withLate = addTablePlayer(
      started,
      { id: 'late', nickname: 'Late', avatarSeed: 'late' },
      context(),
    ).newState;
    let state = withLate;
    let pushed: readonly { playerId: string; message: { t: string } }[] = [];
    for (let i = 0; i < 40 && state.currentTurn !== null; i += 1) {
      const actor = state.participants.find((row) => row.seatIndex === state.currentTurn)!;
      const step = applyAction(
        freeze(state),
        actor.seatIndex,
        freeze({
          type: actor.committedThisStreet < state.currentBet ? 'call' : 'check',
        }),
        context(),
      );
      state = step.newState;
      if (state.phase === 'HAND_END') {
        pushed = step.privateMessages;
        break;
      }
    }
    expect(state.phase).toBe('HAND_END');
    // 前提：多人摊牌成立，且 late 已在桌上但不是这一手的人
    expect(state.participants.filter((p) => !p.folded).length).toBeGreaterThan(1);
    expect(state.participants.some((p) => p.playerId === 'late')).toBe(false);
    expect(pushed.some((m) => m.playerId === 'late')).toBe(false);
    // 参加过的人确实收到了亮牌，否则"没推给 late"可能只是因为整条推送都没跑
    expect(
      pushed.filter((m) => m.playerId === 'p1' && m.message.t === 'showdown:reveal').length,
    ).toBeGreaterThan(0);
    conserved(state);
  });
  /**
   * 亮牌与"它是谁的"必须绑在一起验。此前全仓没有任何用例断言过 `showdown:reveal` 里的**牌面**
   * 属于它声称的那个座位，也没有用例断言 `deal:holeCards` 里的牌就是收信人自己的两张（D-022：
   * 只按类型/条数/座位号断言，等于把牌发给错人也全绿）。把 `reveals` 的取牌来源轮错一位，
   * 这条会红；旧的断言不会 —— 探针证据见 PROGRESS【第六轮续 · 独立审查】。
   */
  it('私密消息里的牌面与收信人/座位一一对应', () => {
    const state = checkDown(startHand(table([200, 200, 200]), context()).newState);
    const cardsBySeat = new Map(state.participants.map((p) => [p.seatIndex, p.holeCards]));
    const selfSeat = state.participants.find((p) => p.playerId === 'p1')!.seatIndex;
    const received = getPrivateMessages(state, 'p1');
    const reveals = received.filter((m) => m.message.t === 'showdown:reveal');
    expect(reveals.length).toBeGreaterThan(0);
    for (const item of reveals) {
      if (item.message.t !== 'showdown:reveal') throw new Error('上面的过滤与这里的窄化必须一致');
      expect(item.message.cards).toEqual(cardsBySeat.get(item.message.seatIndex));
      // 手号也得带上：客户端要靠它挡掉"迟到的上一手亮牌贴到新一手"（见 web/test/adapter.test.ts）。
      expect(item.message.handId).toBe(state.handId);
    }
    const deal = received.find((m) => m.message.t === 'deal:holeCards');
    if (deal === undefined || deal.message.t !== 'deal:holeCards')
      throw new Error('参加过这一手的人应收到自己的底牌');
    expect(deal.message.handId).toBe(state.handId);
    expect(deal.message.cards).toEqual(cardsBySeat.get(selfSeat));
  });
  it('reconnecting retains seat, cards and the crown; offline commands stay refused', () => {
    const start = startHand(table([200, 200, 200], [4, 1, 6]), context()).newState;
    const next = setPlayerPresence(freeze(start), 'p1', 'reconnecting', context()).newState;
    // SPEC §2.5：房主**离开**才转移。掉线重连的 120 秒窗口里人还在座位上，
    // 王冠不能先交给别人（否则刷新一次页面就等于让权）。
    expect(next.hostId).toBe('p1');
    expect(next.accounts[1]?.seatIndex).toBe(1);
    expect(next.participants).toEqual(start.participants);
    expect(getPrivateMessages(next, 'p1')[0]?.message.t).toBe('deal:holeCards');
    expect(getTableLegalActions(next, 'p1').canFold).toBe(false);
    expect(() =>
      applyPlayerAction(next, 'p1', { type: 'call' }, next.handId, next.turnVersion, context()),
    ).toThrow(expect.objectContaining({ code: 'INVALID_ACTION' }));
    const back = setPlayerPresence(next, 'p1', 'online', context()).newState;
    expect(back.hostId).toBe('p1');
    conserved(tickTable(back, context(30000)).newState);
  });
  it('stand/sit does not mint chips, host can be null then recovered', () => {
    let state = table();
    state = standPlayer(state, 'p0', context()).newState;
    expect(state.hostId).toBe('p1');
    state = standPlayer(state, 'p1', context()).newState;
    expect(state.hostId).toBeNull();
    state = sitPlayer(state, 'p0', 5, context()).newState;
    expect(state.hostId).toBe('p0');
    expect(state.accounts.map((p) => p.chips)).toEqual([200, 200]);
    expect(sitPlayer(state, 'p0', 5, context()).events).toEqual([]);
    conserved(state);
  });
  it('insufficient next-hand players returns IDLE retaining results; rebuy is explicit', () => {
    let state = startHand(table([10, 10]), context()).newState;
    expect(state.phase).toBe('HAND_END');
    const loser = state.accounts.find((p) => p.chips === 0)!;
    state = tickTable(state, context(5000)).newState;
    expect(state.phase).toBe('IDLE');
    expect(state.nextHandAt).toBeNull();
    expect(state.results).toHaveLength(2);
    expect(state.accounts.reduce((n, p) => n + p.chips, 0)).toBe(20);
    const bought = rebuyPlayer(freeze(state), loser.id, context());
    expect(bought.newState.introducedChips).toBe(2020);
    expect(bought.events).toContainEqual({ t: 'chips:rebuy', seatIndex: loser.seatIndex });
    conserved(bought.newState);
    expect(startTable(bought.newState, bought.newState.hostId!, context()).newState.phase).toBe(
      'PREFLOP',
    );
  });
  it('config changes are host-only in IDLE and never reset balances', () => {
    const state = table();
    const update = setTableConfig(freeze(state), 'p0', {
      startingChips: 500,
      maxPlayers: 2,
      actionTimeoutSec: 1,
    });
    expect(update.newState.accounts).toEqual(state.accounts);
    expect(update.newState.config.startingChips).toBe(500);
    expect(startTable(update.newState, 'p0', context()).newState.deadline).toBe(1000);
  });
});
