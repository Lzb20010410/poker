import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGameClient, INITIAL_STATE_TIMEOUT_MS } from '../src/net/client';
import { hand, memoryStorage, publicState, sdkRoom, slot } from './sdkFixture';

const boundary = vi.hoisted(() => ({ create: vi.fn(), joinById: vi.fn(), reconnect: vi.fn() }));
// 展开原模块只是为了留下 `Client` 之外的真实导出；被测代码仍按真类型检查 `Client`。
vi.mock('@colyseus/sdk', async (original) => {
  const actual = await original<Record<string, unknown>>();
  return { ...actual, Client: vi.fn(function () { return boundary; }) };
});
const profile = { nickname: 'Alice', avatarSeed: 'alice' };
const holes = [{ rank: 14, suit: 's' }, { rank: 13, suit: 'h' }] as const;
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
async function connect(initial = true) {
  const fixture = sdkRoom(initial ? publicState() : undefined);
  const storage = memoryStorage();
  boundary.create.mockResolvedValue(fixture.room);
  const promise = createGameClient('http://server:2591', { storage }).createRoom(profile);
  await Promise.resolve();
  // Real SDK may deliver full state before a waiter is installed.
  if (!initial) fixture.patch();
  const connection = await promise;
  return { ...fixture, storage, connection };
}
describe('真实适配器边界（不替换规则）', () => {
  it('初始状态已到达仍能就绪、复制全部公开字段并主动 ping', async () => {
    vi.useFakeTimers();
    const pending = connect();
    await Promise.resolve();
    const assertion = expect(pending).resolves.toMatchObject({ connection: { code: 'K7QM3D' } });
    await Promise.all([assertion, vi.advanceTimersByTimeAsync(INITIAL_STATE_TIMEOUT_MS)]);
    const f = await pending;
    expect(f.connection.snapshot()).toMatchObject({ phase: 'PREFLOP', potTotal: 30, turnVersion: 1 });
    expect(f.sent).toEqual([{ t: 'ping' }]);
    await f.connection.leave();
  });
  it('等待初始状态前监听私密牌和事件，状态就绪后恢复快照', async () => {
    const fixture = sdkRoom();
    boundary.create.mockResolvedValue(fixture.room);
    const pending = createGameClient('http://server:2591', { storage: null }).createRoom(profile);
    await Promise.resolve();
    fixture.message('deal', { t: 'deal:holeCards', handId: 'hand-1', cards: holes });
    fixture.patch();
    const connection = await pending;
    expect(connection.snapshot().holeCards).toEqual(holes);
    expect(fixture.sent).toEqual([{ t: 'ping' }]);
    await connection.leave();
  });
  /**
   * `deal` 比第一个 patch 早到时，客户端**无从判断**它是哪一手的牌，只能先收下、等 patch
   * 到了再对账（见 `client.ts` 的 `onDeal` 注释）。上一手的牌也可能这样抢先到达，
   * 而对账发生在 `onStateChange` 里，不在 `onDeal` 里。
   *
   * 所以 `onDeal` 的 `handId` 拒绝和 `onStateChange` 的清空是**两道独立的门**，各自挡一种时序：
   * 前者挡「状态已知时来了旧手的牌」，后者挡「状态未知时收下、事后发现是旧手的牌」。
   * 少任何一道都盖不住跨手残留，因此下面那条「新手清空私密状态」的用例（探针打掉前者时
   * 会红）与这一条（探针打掉后者时原本全绿）合起来，才算把这条铁律钉住。
   *
   * 还要留意：这一条自己**证不了**"牌真的先被收下了"——从外面看，"收下又丢掉"和"根本没收到"
   * 是同一个终态。把「早到的牌确实会进快照」钉住的是上面那条 `等待初始状态前监听私密牌和事件`。
   * 两条配对才完整，单独看这一条会因为通道名改动而静默空过。
   */
  it('状态未就绪时先收到上一手的底牌，第一个 patch 到达必须丢掉', async () => {
    const fixture = sdkRoom();
    boundary.create.mockResolvedValue(fixture.room);
    const pending = createGameClient('http://server:2591', { storage: null }).createRoom(profile);
    await Promise.resolve();
    fixture.message('deal', { t: 'deal:holeCards', handId: 'hand-0', cards: holes });
    fixture.patch();
    const connection = await pending;
    // `publicState()` 的 handId 是 hand-1：上一手的两张牌不能贴到这一手显示
    expect(connection.snapshot().holeCards).toBeNull();
    await connection.leave();
  });
  it('初始状态前关闭立即 reject 而不是成功空房，清理所有监听', async () => {
    const fixture = sdkRoom();
    boundary.create.mockResolvedValue(fixture.room);
    const pending = createGameClient('http://server:2591', { storage: null }).createRoom(profile);
    const rejected = expect(pending).rejects.toThrow();
    await Promise.resolve();
    fixture.room.onLeave.emit(1006);
    await rejected;
    expect(fixture.room.onStateChange.size()).toBe(0);
    expect(fixture.messageListeners()).toBe(0);
  });
  it('初始状态超时 reject 并关闭 socket、禁用自动重连且移除监听', async () => {
    vi.useFakeTimers();
    const fixture = sdkRoom(); boundary.create.mockResolvedValue(fixture.room);
    const pending = createGameClient('http://server:2591', { storage: null }).createRoom(profile);
    const rejected = expect(pending).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(INITIAL_STATE_TIMEOUT_MS);
    await rejected;
    expect(fixture.closes()).toBe(1);
    expect(fixture.room.reconnection.enabled).toBe(false);
    expect(fixture.room.onStateChange.size()).toBe(0);
    expect(fixture.messageListeners()).toBe(0);
  });
  it('drop 到 fresh state 之间禁止发送，更新 token 后上线，晚订阅得到当前 link', async () => {
    const f = await connect(false);
    expect(f.room.reconnection.maxEnqueuedMessages).toBe(0);
    expect(f.room.reconnection.minUptime).toBe(0);
    f.room.onDrop.emit(1006);
    const links: string[] = []; f.connection.onLinkChange((link) => links.push(link));
    expect(links).toEqual(['reconnecting']);
    expect(f.connection.send({ t: 'table:start' })).toBe(false);
    f.room.onReconnect.emit();
    expect(f.connection.send({ t: 'table:start' })).toBe(false);
    expect([...f.storage.data.values()]).toEqual(['K7QM3D:old-secret']);
    f.room.reconnectionToken = 'K7QM3D:new-secret';
    f.patch();
    expect(links).toEqual(['reconnecting', 'online']);
    expect([...f.storage.data.values()]).toEqual(['K7QM3D:new-secret']);
    expect(f.sent).toEqual([{ t: 'ping' }, { t: 'ping' }]);
    f.room.connection.isOpen = false;
    expect(f.connection.send({ t: 'table:start' })).toBe(false);
    f.room.connection.isOpen = true; f.room.reconnection.isReconnecting = true;
    expect(f.connection.send({ t: 'table:start' })).toBe(false);
    f.room.onLeave.emit(4010);
    const late: string[] = []; f.connection.onLinkChange((link) => late.push(link));
    expect(late).toEqual(['offline']);
    f.patch(); expect(f.connection.send({ t: 'ping' })).toBe(false);
    expect([...f.storage.data.values()]).toEqual(['K7QM3D:new-secret']);
    await f.connection.leave(); expect(f.storage.data.size).toBe(0);
  });
  /**
   * M4.1「连续掉线 3 次提示改用刷新」。计数的是**同一条连接上**的 `onDrop` 次数：
   * SDK 一次掉线会自己重试约 56 秒，所以「掉三次」意味着三段重试窗口全都白等，
   * 这时候玩家该做的是刷新（走 sessionStorage 凭证续座），而不是继续盯着这张不动的牌桌。
   * 中途真接回去过一次就必须归零——否则玩了两小时偶发断三次，也会被劝去刷新。
   */
  it('连续掉线第三次劝一次刷新，接回去过就重新计数，第四次不重复刷屏', async () => {
    const f = await connect(false);
    const hints: string[] = [];
    f.connection.onNotice((notice) => { if (notice.message.includes('刷新')) hints.push(notice.message); });
    f.room.onDrop.emit(1006);
    f.room.onReconnect.emit();
    f.patch();
    f.room.onDrop.emit(1006);
    f.room.onDrop.emit(1006);
    expect(hints).toEqual([]);
    f.room.onDrop.emit(1006);
    expect(hints).toHaveLength(1);
    f.room.onDrop.emit(1006);
    expect(hints).toHaveLength(1);
    await f.connection.leave();
  });
  it('仅传递显示版本的 action，pending 挡双击直到 patch/error/drop', async () => {
    const f = await connect(false);
    const action = { t: 'action', handId: 'hand-1', turnVersion: 1, action: { type: 'call' } } as const;
    expect(f.connection.send(action)).toBe(true);
    expect(f.connection.send(action)).toBe(false);
    expect(f.connection.snapshot().actionPending).toBe(true);
    f.message('error', { t: 'error', code: 'INVALID_ACTION', message: '动作已过期' });
    expect(f.connection.snapshot().actionPending).toBe(false);
    f.connection.send(action); f.patch({ ...publicState(), turnVersion: 2 });
    expect(f.connection.snapshot().actionPending).toBe(false);
    expect(f.sent.filter((x) => x.t === 'action')).toEqual([action, action]);
    await f.connection.leave();
  });
  /**
   * 全下之后服务端可能不再产生新的 `turnVersion`：它直接跑完公共牌、结算、回到等待开局。
   * 如果只按 `handId:turnVersion` 变了才解锁，那把锁会一直挂到下一手开始，
   * 玩家在「等待开局」的界面上看到的提示是「上一步已经发出去了，等服务端确认」——
   * 而他的那一步其实早就被接受了。
   */
  it('服务端不再等我这一步就解锁，哪怕 handId 和 turnVersion 都没变', async () => {
    const f = await connect(false);
    expect(f.connection.send({ t: 'action', handId: 'hand-1', turnVersion: 1, action: { type: 'allIn' } })).toBe(true);
    expect(f.connection.snapshot().actionPending).toBe(true);
    f.patch({ ...publicState(), phase: 'HAND_END', currentTurn: -1 });
    expect(f.connection.snapshot().actionPending).toBe(false);
    await f.connection.leave();
  });
  it('新手清空私密状态，showdown 只绑定冻结身份，同座替换不能继承', async () => {
    const f = await connect(false);
    f.message('deal', { t: 'deal:holeCards', handId: 'hand-1', cards: holes });
    f.message('showdown:reveal', {
      t: 'showdown:reveal',
      handId: 'hand-1',
      seatIndex: 1,
      cards: holes,
    });
    f.message('timeoutWarning', { t: 'timeoutWarning', remainingSec: 10 });
    expect(f.connection.snapshot().reveals).toEqual([{ playerId: 'other', seatIndex: 1, cards: holes }]);
    const changed = { ...publicState(), players: new Map([['self', slot()], ['new', slot('new', 1)]]) };
    f.patch(changed);
    expect(f.connection.snapshot().reveals[0]?.playerId).toBe('other');
    f.patch({ ...changed, handId: 'hand-2', turnVersion: 3,
      handPlayers: new Map([['self', hand()], ['new', hand('new', 1)]]) });
    expect(f.connection.snapshot()).toMatchObject({ holeCards: null, reveals: [], timeoutWarning: null, awards: [] });
    f.message('deal', { t: 'deal:holeCards', handId: 'hand-1', cards: holes });
    expect(f.connection.snapshot().holeCards).toBeNull();
    await f.connection.leave();
  });
  /**
   * D-014：摊牌亮牌绑定的是**这一手开局时冻结的身份**（`state.handPlayers`），不是当前坐在这个
   * 位置上的人（`state.players`）。上面那条用例把亮牌放在换座**之前**，于是它其实没有区分这两个
   * 来源——消息到达那一刻座位 1 上还是 `other`，从哪张表查都对。真正会出错的是这个顺序：
   * 换座已经广播到了，迟到的亮牌才到。
   *
   * 探针证据：把 `readReveal` 的查表从 `handPlayers` 换成 `players`，改动前全仓 169 条用例
   * **一条都不红**；这一条红。触发条件并不苛刻——亮牌是结算阶段连发的，而「弃牌后立即离座、
   * 下一个人补上」在同一时刻推 patch 是完全可能的。绑错人的后果不是显示错误而是**归因错误**：
   * 把 A 的牌型算到 B 头上。
   */
  it('同座已被替换之后才到达的亮牌，仍绑定这一手冻结的身份', async () => {
    const f = await connect(false);
    // 座位 1 从 `other` 换成 `new`；`handPlayers` 不动，它记的还是这一手的人
    f.patch({ ...publicState(), players: new Map([['self', slot()], ['new', slot('new', 1)]]) });
    /**
     * 前提断言。这条用例之所以能区分两个来源，全靠「座位 1 在两张表上指向不同的人」；
     * 一旦这个前提没了（夹具改动、座位号写错），用例会**静默空过**——从哪张表查都是同一个答案，
     * 名字写着"防继承"而实际什么都没防。独立审查指出这一点后把前提写死在这里：
     * 前提破了就红在这里，而不是红不到。
     */
    const seated = f.connection.snapshot();
    expect(seated.players.find((player) => player.seatIndex === 1)?.id).toBe('new');
    expect(seated.handPlayers.find((row) => row.seatIndex === 1)?.playerId).toBe('other');
    f.message('showdown:reveal', {
      t: 'showdown:reveal',
      handId: 'hand-1',
      seatIndex: 1,
      cards: holes,
    });
    expect(f.connection.snapshot().reveals).toEqual([{ playerId: 'other', seatIndex: 1, cards: holes }]);
    await f.connection.leave();
  });
  /**
   * `showdown:reveal` 原来只带 `seatIndex` + `cards`，没有手号，于是底牌那道
   * 「状态已知时来了旧手的牌」的门（`onDeal` 的 `handId` 比对）对它**完全不存在**。
   * 跨手残留因此从另一条路回来：换到下一手的 patch 已经把 `reveals` 清空了，
   * 但一条迟到的上一手亮牌紧接着又被收下，而它的身份是拿**新一手的 `handPlayers`** 解析的。
   * 座位没变、人变了（上一手座位 1 是 `other`，这一手座位 1 是 `self`）时，
   * 界面显示的是"我亮过一副根本没拿过的牌"——和 D-014 同源的归因错误。
   *
   * 三条腿各挡一种走法，缺一条就会静默空过：
   * ① 新一手同号的亮牌必须**收下**（证明这条通道真的活着，不是因为别的原因为空）；
   * ② 旧手号的亮牌必须丢掉；③ 缺手号的亮牌按形状不合丢掉（和 `deal` 一样严格）。
   */
  it('迟到的上一手亮牌不能贴到新一手：reveal 也要过手号这道门', async () => {
    const f = await connect(false);
    // 座位 1 在新一手属于 self；handId 同时前进到 hand-2，reveals 被清空
    f.patch({
      ...publicState(),
      handId: 'hand-2',
      turnVersion: 5,
      players: new Map([['other', slot('other', 0)], ['self', slot('self', 1)]]),
      handPlayers: new Map([['other', hand('other', 0)], ['self', hand('self', 1)]]),
    });
    f.message('showdown:reveal', { t: 'showdown:reveal', handId: 'hand-1', seatIndex: 1, cards: holes });
    expect(f.connection.snapshot().reveals).toEqual([]);
    f.message('showdown:reveal', { t: 'showdown:reveal', seatIndex: 1, cards: holes });
    expect(f.connection.snapshot().reveals).toEqual([]);
    f.message('showdown:reveal', { t: 'showdown:reveal', handId: 'hand-2', seatIndex: 1, cards: holes });
    expect(f.connection.snapshot().reveals).toEqual([{ playerId: 'self', seatIndex: 1, cards: holes }]);
    await f.connection.leave();
  });
  it('动作上锁和解锁都要推快照，界面才能立刻把按钮按下去', async () => {
    const f = await connect(false);
    const pending: boolean[] = [];
    f.connection.subscribe((snap) => pending.push(snap.actionPending));
    expect(pending).toEqual([false]);
    f.connection.send({ t: 'action', handId: 'hand-1', turnVersion: 1, action: { type: 'call' } });
    // 只改内部 pendingKey 不够：没有这次推送，ActionPanel 会一直亮着，双击照样发出去
    expect(pending).toEqual([false, true]);
    f.message('error', { t: 'error', code: 'INVALID_ACTION', message: '动作已过期' });
    expect(pending).toEqual([false, true, false]);
    await f.connection.leave();
  });
  it('pot:awarded 按池累加，摊牌时能一次看到主池和边池', async () => {
    const f = await connect(false);
    const award = (potIndex: number, amount: number, winners: number[]) => ({
      t: 'pot:awarded', potIndex, winners, amount, handName: '两对', bestFive: [],
    });
    f.message('event', award(0, 300, [0]));
    f.message('event', award(1, 120, [1, 3]));
    expect(f.connection.snapshot().awards).toEqual([
      { potIndex: 0, winners: [0], amount: 300, handName: '两对', bestFive: [] },
      { potIndex: 1, winners: [1, 3], amount: 120, handName: '两对', bestFive: [] },
    ]);
    // 同一手里的多个池要能一次看全（主池 + 边池），顺序按服务端推送顺序
    expect(f.connection.snapshot().awards).toHaveLength(2);
    await f.connection.leave();
  });
  /**
   * `onEvent` 是动画队列的入口，和上面那条 `awards` 用例共用同一次校验。
   * 这里钉的是**通道**行为而不是校验行为（校验在 `netEvents.test.ts`）：
   * 注册时不重放、多个订阅者都收到、退订后立刻止。
   * 不重放这条最容易写错：`subscribe` 和 `onLinkChange` 都刻意重放当前值，
   * 唯独事件通道不能——重放等于组件每次重挂载（换屏、竖横切换、React 严格模式）
   * 都把上一手的发牌动画重播一遍。
   */
  it('事件通道：注册不重放，多个订阅者各收一份，退订即止', async () => {
    const f = await connect(false);
    const seen: string[] = [];
    const mine = f.connection.onEvent((event) => { seen.push(event.t); });
    expect(seen).toEqual([]);
    f.message('event', { t: 'shuffle' });
    f.message('event', { t: 'deal:start', count: 8, startSeat: 0 });
    expect(seen).toEqual(['shuffle', 'deal:start']);
    const other = f.connection.onEvent((event) => { seen.push(`b:${event.t}`); });
    expect(seen).toEqual(['shuffle', 'deal:start']);
    f.message('event', { t: 'turn:change', seatIndex: 3, deadline: 1800000030000 });
    expect(seen).toEqual(['shuffle', 'deal:start', 'turn:change', 'b:turn:change']);
    mine(); other();
    f.message('event', { t: 'round:end', phase: 'TURN' });
    expect(seen).toEqual(['shuffle', 'deal:start', 'turn:change', 'b:turn:change']);
    await f.connection.leave();
  });
  /**
   * 形状不合的事件必须**两边都不落地**：不打扰订阅者，也不推快照。
   * 后半句才是代价所在——`pot:awarded` 少一个 `amount` 就是一次 `notifySnapshot`
   * 加一行「第 0 池 · 0 筹码」的假摊牌记录，玩家在结算栏里看到一笔没收的钱。
   */
  it('坏形状的事件既不通知订阅者，也不推快照', async () => {
    const f = await connect(false);
    const seen: string[] = [];
    let pushes = 0;
    f.connection.onEvent((event) => { seen.push(event.t); });
    f.connection.subscribe(() => { pushes += 1; });
    pushes = 0;
    f.message('event', { t: 'pot:awarded', potIndex: 0, winners: [0], handName: '两对', bestFive: [] });
    f.message('event', { t: 'unknown:thing' });
    f.message('event', { t: 'board:deal', phase: 'flop', cards: [{ rank: 99, suit: 'x' }] });
    expect(seen).toEqual([]);
    expect(pushes).toBe(0);
    expect(f.connection.snapshot().awards).toEqual([]);
    f.message('event', { t: 'pot:awarded', potIndex: 0, winners: [0], amount: 300, handName: '两对', bestFive: [] });
    expect(seen).toEqual(['pot:awarded']);
    expect(pushes).toBe(1);
    expect(f.connection.snapshot().awards).toHaveLength(1);
    await f.connection.leave();
  });
  it('clockOffsetMs 是服务端时间减本地时间，倒计时用它校正', async () => {
    vi.useFakeTimers({ now: 1_799_999_990_000 });
    const f = await connect();
    expect(f.connection.snapshot().clockOffsetMs).toBe(10_000);
    await f.connection.leave();
  });
  it('按座位排列，旁观者最后，null 哨兵还原且不暴露 schema 引用', async () => {
    const f = await connect(false);
    f.patch({ ...publicState(), currentTurn: -1, deadline: 0, hostId: '', players: new Map([
      ['watch', slot('watch', -1)], ['b', slot('b', 4)], ['a', slot('a', 1)],
    ]) });
    expect(f.connection.snapshot().players.map((p) => p.id)).toEqual(['a', 'b', 'watch']);
    expect(f.connection.snapshot()).toMatchObject({ currentTurn: null, deadline: null, hostId: null, nextHandAt: null });
    const old = f.connection.snapshot(); f.patch({ ...publicState(), board: holes });
    expect(old.board).toEqual([]);
    expect(f.connection.snapshot().board).toEqual(holes);
    await f.connection.leave();
  });
});
