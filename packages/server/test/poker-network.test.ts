import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { boot, type ColyseusTestServer } from '@colyseus/testing';
import { defineRoom, type ConfigOptions } from 'colyseus';
import { mulberry32 } from '@poker-room/shared';
import { PokerRoom } from '../src/rooms/PokerRoom';
import { act, actor, command, conserved, events, finish, observe, privateMessages, rejected, start, table, transmittedCards, visibleCards, wait } from './network-helpers';

let server: ColyseusTestServer;
let now = 1_800_000_000_000;
let random = mulberry32(42);
class SeededRoom extends PokerRoom {
  protected override runtime = { now: () => now, rand: () => random() };
}
beforeAll(async () => {
  server = await boot({ rooms: { poker: defineRoom(PokerRoom), seeded: defineRoom(SeededRoom) } } as ConfigOptions, 2569);
});
beforeEach(() => { now = 1_800_000_000_000; random = mulberry32(42); });
afterEach(async () => { await server.cleanup(); });
afterAll(async () => { await server.shutdown(); });

it('M1.5 网络公开账户并由认证房主开始，忽略 join 的筹码/host/runtime', async () => {
  const options = { nickname: 'Alice', chips: 999999, hostId: 'evil', runtime: { now: 1 }, actionTimeoutSec: 1 };
  const a = await observe(await server.sdk.create<PokerRoom['state']>('poker', options));
  const b = await observe(await server.sdk.joinById<PokerRoom>(a.room.roomId, { nickname: 'Bob' }));
  await wait(() => a.room.state.players.size === 2);
  expect(a.room.state.hostId).toBe(a.room.sessionId);
  expect(a.room.state.introducedChips).toBe(4000);
  expect(a.room.state.config.actionTimeoutSec).toBe(30);
  await start([a, b]);
  expect(privateMessages(a, 'deal').at(-1)).toMatchObject({ t: 'deal:holeCards', handId: 'hand-1' });
  expect(JSON.stringify(a.room.state)).not.toMatch(/holeCards|deck|burned/);
  await finish([a, b]);
});

describe('RULES §6 真实网络场景（每场景核对守恒）', () => {
  it('1 两人逐街整手，TURN bet-call，派彩后 5 秒自动轮转', async () => {
    const peers = await table(server);
    await start(peers);
    await act(peers, { type: 'call' });
    await act(peers, { type: 'check' });
    expect(peers[0]!.room.state.phase).toBe('FLOP');
    await act(peers, { type: 'check' });
    await act(peers, { type: 'check' });
    expect(peers[0]!.room.state.phase).toBe('TURN');
    await act(peers, { type: 'raise', totalBet: 60 });
    await act(peers, { type: 'call' });
    expect(peers[0]!.room.state.phase).toBe('RIVER');
    await finish(peers);
    // 事件不只"发过三次"：每次携带的牌必须正好是最终牌面里对应那几张，
    // 否则客户端动画演的是另一副牌（只看 phase 的话，内容错了也能过）。
    const deals = events(peers[0]!).filter((e) => e.t === 'board:deal');
    expect(deals.map((e) => e.phase)).toEqual(['flop', 'turn', 'river']);
    const finalBoard = transmittedCards(peers[0]!.room.state.board);
    expect(deals.map((e) => transmittedCards(e.cards))).toEqual([
      finalBoard.slice(0, 3), finalBoard.slice(3, 4), finalBoard.slice(4, 5),
    ]);
    const s = peers[0]!.room.state;
    expect(s.pots.map((p) => p.amount)).toEqual([160]);
    expect(s.results.map((r) => r.delta).sort((a, b) => a - b)).toEqual([-80, 80]);
    now = s.nextHandAt - 1;
    await command(peers[0]!, { t: 'ping' });
    expect(s.handNo).toBe(1);
    now += 1;
    await wait(() => peers.every((p) => p.room.state.handNo === 2));
    expect(s.dealerSeat).toBe(1);
    await finish(peers);
  });
  it('2 HU 按钮即 SB，翻前按钮先行、翻后 BB 先行', async () => {
    const peers = await table(server);
    await start(peers);
    const s = peers[0]!.room.state;
    expect([s.dealerSeat, s.sbSeat, s.bbSeat, s.currentTurn]).toEqual([0, 0, 1, 0]);
    await act(peers, { type: 'call' });
    await act(peers, { type: 'check' });
    expect(s.currentTurn).toBe(1);
    await finish(peers);
  });
  it('3 六人不等额 all-in 产生六层池并精确派彩', async () => {
    const peers = await table(server, 1);
    const first = peers[0]!;
    for (const chips of [100, 200, 300, 400, 500]) {
      await command(first, { t: 'table:setConfig', config: { startingChips: chips } });
      peers.push(await observe(await server.sdk.joinById<PokerRoom>(first.room.roomId, { nickname: `P${peers.length}` })));
    }
    await wait(() => peers.every((p) => p.room.state.players.size === 6));
    await start(peers);
    while (first.room.state.phase !== 'HAND_END') await act(peers, { type: 'allIn' });
    expect(first.room.state.pots.map((p) => ({ amount: p.amount, eligible: [...p.eligible] }))).toEqual([
      { amount: 600, eligible: [0, 1, 2, 3, 4, 5] },
      { amount: 500, eligible: [0, 2, 3, 4, 5] },
      { amount: 400, eligible: [0, 3, 4, 5] },
      { amount: 300, eligible: [0, 4, 5] },
      { amount: 200, eligible: [0, 5] },
      { amount: 1500, eligible: [0] },
    ]);
    // seed 42 的 board=3c Kc 3d Jc 2c；seat2=3h Jd（葫芦）赢前两池，
    // seat4=Ac Qh（A高同花）赢中两池，seat0 两对胜 seat5 的一对，另收回独占池。
    expect(first.room.state.results.map((r) => r.chips)).toEqual([1700, 0, 1100, 0, 700, 0]);
    expect(events(first).filter((e) => e.t === 'pot:awarded').map((e) => e.winners)).toEqual([[2], [2], [4], [4], [0], [0]]);
    conserved(peers);
  });
  it('4 八人三人 fold，其余逐街到底且顺序跳过弃牌者', async () => {
    const peers = await table(server, 8);
    await start(peers);
    const ownCards = peers.map((p) => privateMessages(p, 'deal').at(-1));
    const foldedCards = ownCards.slice(3, 6).flatMap(transmittedCards);
    for (let i = 0; i < 3; i++) await act(peers, { type: 'fold' });
    await finish(peers);
    const made = events(peers[0]!).filter((e) => e.t === 'action:made');
    expect(made.slice(0, 8).map((e) => e.seatIndex)).toEqual([3, 4, 5, 6, 7, 0, 1, 2]);
    expect(made.slice(8).map((e) => e.seatIndex)).toEqual([1, 2, 6, 7, 0, 1, 2, 6, 7, 0, 1, 2, 6, 7, 0]);
    const reveals = privateMessages(peers[0]!, 'showdown:reveal');
    expect(new Set(reveals.filter((m) => m.t === 'showdown:reveal').map((m) => m.seatIndex))).toEqual(new Set([0, 1, 2, 6, 7]));
    // 一个诚实的客户端在这手牌里**应该看得见**的牌的完整清单：公共牌 + 进过摊牌者的底牌。
    // 用它做精确集合比对，而不是只查"有没有弃牌者的牌"：漏发公共牌、漏发亮牌同样是故障，
    // 只断言"不含不该出现的"会让一半故障静悄悄通过。
    const shouldBeVisible = new Set([
      ...transmittedCards(peers[0]!.room.state.board),
      ...[0, 1, 2, 6, 7].flatMap((seat) => transmittedCards(ownCards[seat])),
    ]);
    for (const [index, peer] of peers.entries()) {
      for (const message of privateMessages(peer, 'deal')) expect(message).toEqual(ownCards[index]);
      const seen = visibleCards(peer);
      expect([...new Set(seen)].sort()).toEqual([...shouldBeVisible].sort());
      // 集合相等已经蕴含这条，单独留着是为了失败时一眼看出漏的是谁。
      expect(seen.filter((c) => foldedCards.includes(c)), `弃牌者的底牌漏给了 P${index}`).toEqual([]);
      // 这条只认字段名，换个键名就查不出来；留着当便宜的绊线，
      // 真正的隐私判定是上面两条按牌的内容比集合。
      expect(JSON.stringify(events(peer))).not.toMatch(/holeCards|deck|burned/);
    }
  });
  it('5 翻前全下直接跑完公共牌，无中间街行动', async () => {
    const peers = await table(server, 3);
    await start(peers);
    while (peers[0]!.room.state.phase !== 'HAND_END') await act(peers, { type: 'allIn' });
    const s = peers[0]!.room.state;
    expect(s.runOutBoard).toBe(true);
    expect(s.board).toHaveLength(5);
    expect(s.currentTurn).toBe(-1);
    expect(events(peers[0]!).filter((e) => e.t === 'turn:change')).toHaveLength(3);
    conserved(peers);
  });
  it('6 BB option 保留且可以 raise', async () => {
    const peers = await table(server, 3);
    await start(peers);
    await act(peers, { type: 'call' });
    await act(peers, { type: 'call' });
    expect(peers[0]!.room.state.currentTurn).toBe(2);
    expect(actor(peers).room.state.players.get(actor(peers).room.sessionId)?.canRaise).toBe(true);
    await act(peers, { type: 'raise', totalBet: 60 });
    expect(peers[0]!.room.state.currentBet).toBe(60);
    await finish(peers);
  });
  it('7 非当前玩家伪造 id/seat 不能行动，NOT_YOUR_TURN 且不改状态', async () => {
    const peers = await table(server);
    await start(peers);
    const s = peers[0]!.room.state;
    await rejected(peers[1]!, { t: 'action', id: peers[0]!.room.sessionId, seatIndex: 0,
      handId: s.handId, turnVersion: s.turnVersion, action: { type: 'raise', totalBet: 100 } }, 'NOT_YOUR_TURN');
    await finish(peers);
  });
  it('8 超额 raise 归一 all-in 而非拒绝', async () => {
    const peers = await table(server);
    await start(peers);
    await act(peers, { type: 'raise', totalBet: 999999 });
    expect(events(peers[0]!).find((e) => e.t === 'action:made')).toMatchObject({ action: { type: 'allIn' } });
    await finish(peers);
  });
  it('9 最小加注不足 RAISE_TOO_SMALL 不改状态', async () => {
    const peers = await table(server);
    await start(peers);
    const s = peers[0]!.room.state;
    await rejected(peers[0]!, { t: 'action', handId: s.handId, turnVersion: s.turnVersion,
      action: { type: 'raise', totalBet: 21 } }, 'RAISE_TOO_SMALL');
    await finish(peers);
  });
});

it('旧 handId 与 duplicate version 均拒绝，即便跨街仍轮到同一人', async () => {
  const peers = await table(server);
  await start(peers);
  const s = peers[0]!.room.state;
  const old = { t: 'action', handId: s.handId, turnVersion: s.turnVersion, action: { type: 'call' } };
  await act(peers, { type: 'call' });
  await rejected(peers[0]!, old, 'INVALID_ACTION');
  await rejected(peers[1]!, { ...old, handId: 'hand-0', turnVersion: s.turnVersion }, 'INVALID_ACTION');
  const bbCheck = { t: 'action', handId: s.handId, turnVersion: s.turnVersion, action: { type: 'check' } };
  await act(peers, { type: 'check' });
  expect(s.currentTurn).toBe(1);
  await rejected(peers[1]!, bbCheck, 'INVALID_ACTION');
  await finish(peers);
  await rejected(peers[1]!, bbCheck, 'INVALID_ACTION');
});

it('畸形/未知命令、抢 host、重买/配置保护，不回显秘密输入', async () => {
  const peers = await table(server);
  for (const input of [null, [], 2, 'secret', {}, { t: 'evil', secret: 'hidden' }, { t: 'sit' },
    { t: 'action', handId: 1 }, { t: 'table:setConfig', config: [] }, { t: 'emoji', emoji: 'free chat' }]) {
    await rejected(peers[0]!, input, 'INVALID_ACTION');
  }
  await rejected(peers[1]!, { t: 'table:start' }, 'NOT_HOST');
  await rejected(peers[1]!, { t: 'table:setConfig', config: { startingChips: 9999 } }, 'NOT_HOST');
  await rejected(peers[0]!, { t: 'rebuy', chips: 999999 }, 'INVALID_ACTION');
  await start(peers);
  await rejected(peers[0]!, { t: 'table:setConfig', config: { bigBlind: 40 } }, 'CONFIG_LOCKED');
  const s = peers[0]!.room.state;
  for (const totalBet of [-1, 2.5, Number.MAX_SAFE_INTEGER + 1]) {
    await rejected(peers[0]!, { t: 'action', handId: s.handId, turnVersion: s.turnVersion,
      action: { type: 'raise', totalBet } }, 'INVALID_ACTION');
  }
  await finish(peers);
});

it('桌布由房主在等待阶段改，两个客户端的 schema 都跟着变', async () => {
  const peers = await table(server);
  expect(peers[0]!.room.state.config.felt).toBe('green');
  await rejected(peers[0]!, { t: 'table:setConfig', config: { felt: 'purple' } }, 'INVALID_ACTION');
  expect(peers[0]!.room.state.config.felt).toBe('green');
  await command(peers[0]!, { t: 'table:setConfig', config: { felt: 'blue' } });
  await wait(() => peers[1]!.room.state.config.felt === 'blue');
  expect(peers[1]!.room.state.config.felt).toBe('blue');
});

it('仅四种预定义 emoji；stand 后禁止发送，sit 通过引擎恢复', async () => {
  const peers = await table(server);
  for (const emoji of ['fold-face', 'laugh', 'angry', 'wave']) await command(peers[0]!, { t: 'emoji', emoji });
  expect(events(peers[0]!).filter((e) => e.t === 'player:emoji')).toHaveLength(4);
  await command(peers[0]!, { t: 'stand' });
  expect(peers[0]!.room.state.players.get(peers[0]!.room.sessionId)?.seatIndex).toBe(-1);
  await rejected(peers[0]!, { t: 'emoji', emoji: 'wave' }, 'NOT_SEATED');
  await command(peers[0]!, { t: 'sit', seatIndex: 3 });
  expect(peers[0]!.room.state.players.get(peers[0]!.room.sessionId)?.seatIndex).toBe(3);
  conserved(peers);
});

it('房间满拒绝第九人，不引入额外筹码', async () => {
  const peers = await table(server, 8);
  await expect(server.sdk.joinById(peers[0]!.room.roomId)).rejects.toThrow(/full|locked/i);
  expect(peers[0]!.room.state.introducedChips).toBe(16000);
  conserved(peers);
});

it('先 schema 再 event，ping 主动恢复自己的牌及时间，公共编码没有秘密', async () => {
  const peers = await table(server);
  await start(peers);
  const [a, b] = peers;
  expect(a!.eventVersions.filter((x) => x.event.t === 'hand:start')).toEqual([
    expect.objectContaining({ version: 1, phase: 'PREFLOP' }),
  ]);
  const own = privateMessages(a!, 'deal').at(-1);
  expect(own).not.toEqual(privateMessages(b!, 'deal').at(-1));
  a!.messages.length = 0;
  await command(a!, { t: 'ping' });
  expect(privateMessages(a!, 'deal')).toEqual([own]);
  expect(a!.messages.find((m) => m.type === 'pong')?.payload).toEqual({
    serverTime: now, handId: 'hand-1', turnVersion: 1,
  });
  for (const p of peers) {
    expect(JSON.stringify(p.room.state)).not.toMatch(/holeCards|deck|burned/);
    expect(JSON.stringify(events(p))).not.toMatch(/holeCards|deck|burned/);
  }
  await act(peers, { type: 'fold' });
  expect(privateMessages(b!, 'showdown:reveal')).toEqual([]);
  expect(events(b!).find((e) => e.t === 'pot:awarded')).toMatchObject({ bestFive: [] });
  conserved(peers);
});

it('没人摊牌的牌局：每个客户端看得见的牌恰好就是公共牌，一张底牌都不多', async () => {
  const peers = await table(server, 4);
  await start(peers);
  const holes = peers.map((p) => transmittedCards(privateMessages(p, 'deal').at(-1)));
  const allHoles = holes.flat();
  // 这 8 张互不相同，是后面"别人的牌有没有出现在我这儿"这类包含判断有分辨力的前提。
  expect(new Set(allHoles).size).toBe(8);
  // 翻前最后行动的是大盲，他已经跟平了只能过牌，所以按当前行动者的合法动作选。
  // 相位经函数取：上一轮 `while` 的条件会把 `phase` 的静态类型收窄成 `'FLOP'`，
  // 紧接着再和 `'HAND_END'` 比会被 typecheck 判成"两个类型没有交集"（TS2367）。
  const phaseOf = (): string => peers[0]!.room.state.phase;
  while (phaseOf() !== 'FLOP') {
    const p = actor(peers);
    const legal = p.room.state.players.get(p.room.sessionId)!;
    await act(peers, { type: legal.canCheck ? 'check' : 'call' });
  }
  // 排序比较：两边的牌来自不同通道（state 与 event），只关心集合而不关心顺序（顺序由场景 1 负责）。
  const board = [...transmittedCards(peers[0]!.room.state.board)].sort();
  expect(board).toHaveLength(3);
  // 翻牌后一路弃牌到只剩一人：不进摊牌，因此除了公共牌以外不该有任何牌有身份可见。
  while (phaseOf() !== 'HAND_END') await act(peers, { type: 'fold' });
  expect(privateMessages(peers[0]!, 'showdown:reveal')).toEqual([]);
  for (const [index, peer] of peers.entries()) {
    const seen = [...new Set(visibleCards(peer))].sort();
    // 集合相等而不是"不含某几张"：这既证明提取器真的认得这些牌（非空、可红），
    // 也证明可见范围没有超出公共牌 —— 自己的底牌同样只能走定向频道。
    expect(seen, `P${index} 看见了公共牌以外的牌`).toEqual(board);
    for (const [owner, cards] of holes.entries()) {
      expect(seen.filter((c) => cards.includes(c)), `P${owner} 的底牌漏给了 P${index}`).toEqual([]);
    }
  }
  conserved(peers);
});
