import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { boot, type ColyseusTestServer } from '@colyseus/testing';
import { defineRoom, matchMaker, type Client, type ConfigOptions } from 'colyseus';
import { isValidPairingCode, mulberry32 } from '@poker-room/shared';
import { isPairingCodeTaken, PokerRoom } from '../src/rooms/PokerRoom';
import { isPairingCodeReserved, releasePairingCode, reservePairingCode } from '../src/rooms/pairingReservation';
import { act, command, conserved, events, finish, observe, privateMessages, rejected, start, table, wait } from './network-helpers';

let server: ColyseusTestServer;
let now = 1_800_000_000_000;
let random = mulberry32(42);
class ClockRoom extends PokerRoom {
  readonly dropErrors: unknown[] = [];
  clockReads = 0;
  protected override runtime = { now: () => { this.clockReads++; return now; }, rand: () => random() };
  override async onDrop(client: Client): Promise<void> {
    try { await super.onDrop(client); }
    catch (error) { this.dropErrors.push(error); throw error; }
  }
}

/**
 * 分配完配对码**之后**才失败的房间：`onCreate` 里 try 块的第一次 `runtime.now()`
 * 就抛，此时 `reservedCode` 已经占住、`state.joinCode` 已经写好。
 * 把它当探针用 —— 抛之前把码记下来，测试据此检查预留有没有被归还。
 */
const createFailures: string[] = [];
class BrokenCreateRoom extends PokerRoom {
  protected override runtime = {
    now: (): number => {
      createFailures.push(this.state.joinCode);
      throw new Error('模拟 onCreate 在分配配对码之后失败');
    },
    rand: () => 0,
  };
}

/**
 * 时钟路径上的引擎抛出。注入点是房间本来就支持的 `runtime.rand`（时间/随机源），
 * **不是**替换规则引擎：`tick()` → `tickTable()` → 开下一手 → 洗牌，抛出的位置和
 * 筹码守恒熔断（`table-state.ts` 的 `update()`）完全同一条路径。
 * `shuffleFaults` 每次抛出累加一条，用来区分"兜住并停下"和"兜住但继续跑"。
 */
let faultNextShuffle = false;
const shuffleFaults: number[] = [];
class FaultedRoom extends PokerRoom {
  protected override runtime = {
    now: () => now,
    rand: () => {
      if (faultNextShuffle) {
        shuffleFaults.push(now);
        throw new Error('模拟洗牌时引擎抛出');
      }
      return random();
    },
  };
}
beforeAll(async () => {
  // tools 的 ConfigOptions 强制两个仅类型用的 ~ 字段；运行时接受这个普通对象。
  const config = {
    rooms: {
      poker: defineRoom(PokerRoom), seeded: defineRoom(ClockRoom),
      broken: defineRoom(BrokenCreateRoom), faulted: defineRoom(FaultedRoom),
    },
  } as ConfigOptions;
  server = await boot(config, 2570);
});
beforeEach(() => { now = 1_800_000_000_000; random = mulberry32(42); faultNextShuffle = false; shuffleFaults.length = 0; });
afterEach(async () => { vi.useRealTimers(); await server.cleanup(); });
afterAll(async () => { await server.shutdown(); });

/** 推动真实 socket IO，但不推进 Colyseus 重连用的 setTimeout。 */
async function socketIO(check: () => boolean): Promise<void> {
  const end = performance.now() + 3000;
  while (!check()) {
    if (performance.now() > end) throw new Error('等待 socket IO 超时');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

it('10 默认真实 30 秒超时 fold，仅当前行动者收到 10 秒预警', async () => {
  const peers = await table(server, 2, 'poker');
  await start(peers);
  const deadline = peers[0]!.room.state.deadline;
  const begun = Date.now();
  expect(deadline - begun).toBeGreaterThan(29000);
  await wait(() => privateMessages(peers[0]!, 'timeoutWarning').length === 1, 23000);
  expect(privateMessages(peers[1]!, 'timeoutWarning')).toEqual([]);
  await wait(() => peers.every((p) => p.room.state.phase === 'HAND_END'), 13000);
  expect(Date.now() - begun).toBeGreaterThanOrEqual(29000);
  expect(events(peers[0]!).filter((e) => e.t === 'action:made')).toEqual([
    { t: 'action:made', seatIndex: 0, action: { type: 'fold' }, chipsDelta: 0 },
  ]);
  expect(privateMessages(peers[0]!, 'timeoutWarning')).toHaveLength(1);
  conserved(peers);
}, 60000);

it('10 时钟驱动 check 托管，预警每个 hand/version 仅给行动者一次', async () => {
  const peers = await table(server);
  await start(peers);
  await act(peers, { type: 'call' });
  const s = peers[0]!.room.state;
  now = s.deadline - 10000;
  await wait(() => privateMessages(peers[1]!, 'timeoutWarning').length === 1);
  now += 1000;
  await command(peers[1]!, { t: 'ping' });
  expect(privateMessages(peers[1]!, 'timeoutWarning')).toHaveLength(1);
  expect(privateMessages(peers[0]!, 'timeoutWarning')).toEqual([]);
  now = s.deadline;
  await wait(() => peers.every((p) => p.room.state.phase === 'FLOP'));
  expect(events(peers[0]!).filter((e) => e.t === 'action:made').at(-1)).toMatchObject({ seatIndex: 1, action: { type: 'check' } });
  now = s.deadline - 10000;
  await wait(() => privateMessages(peers[1]!, 'timeoutWarning').length === 2);
  await finish(peers);
});

it('11 真实断开再 SDK reconnect 保留 session/座位，只恢复自己的牌', async () => {
  const peers = await table(server, 3);
  await start(peers);
  const dropped = peers[0]!;
  const watcher = peers[1]!;
  const token = dropped.room.reconnectionToken;
  const own = privateMessages(dropped, 'deal').at(-1);
  const seat = dropped.room.state.players.get(dropped.room.sessionId)!.seatIndex;
  dropped.room.reconnection.enabled = false;
  server.getRoomById<PokerRoom>(dropped.room.roomId).clients.find((c) => c.sessionId === dropped.room.sessionId)!.leave(1001);
  await wait(() => watcher.room.state.players.get(dropped.room.sessionId)?.presence === 'reconnecting');
  expect(watcher.room.state.players.get(dropped.room.sessionId)?.seatIndex).toBe(seat);
  const recovered = await observe(await server.sdk.reconnect<PokerRoom>(token), false);
  await wait(() => watcher.room.state.players.get(dropped.room.sessionId)?.presence === 'online');
  await wait(() => privateMessages(recovered, 'deal').length > 0);
  expect(recovered.messages.some((m) => m.type === 'pong')).toBe(false);
  expect(recovered.room.sessionId).toBe(dropped.room.sessionId);
  expect(privateMessages(recovered, 'deal').at(-1)).toEqual(own);
  expect(new Set(privateMessages(recovered, 'deal').map((m) => JSON.stringify(m))).size).toBe(1);
  expect(recovered.room.state.handId).toBe(watcher.room.state.handId);
  expect(recovered.room.state.players.get(recovered.room.sessionId)?.seatIndex).toBe(seat);
  // SPEC §2.5：只有房主**离开**才转移房主。真实断线 + SDK 重连不算离开，
  // 王冠必须还挂在原来那个人头上（浏览器实测过：刷一次页面就夺权是错的）。
  expect(watcher.room.state.hostId).toBe(dropped.room.sessionId);
  expect(recovered.room.state.hostId).toBe(recovered.room.sessionId);
  await finish([recovered, ...peers.slice(1)]);
});

it('120 秒边界由受信任服务器时钟驱动，过期只终离一次并保留余额', async () => {
  const peers = await table(server);
  const a = peers[0]!;
  const b = peers[1]!;
  const token = a.room.reconnectionToken;
  a.room.reconnection.enabled = false;
  // 仅虚拟化框架的 timeout，网络、引擎及 room tick 均为真实实现。
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  server.getRoomById<PokerRoom>(a.room.roomId).clients.find((c) => c.sessionId === a.room.sessionId)!.leave(1001);
  await socketIO(() => b.room.state.players.get(a.room.sessionId)?.presence === 'reconnecting');
  now += 119999;
  await vi.advanceTimersByTimeAsync(119999);
  expect(b.room.state.players.get(a.room.sessionId)?.presence).toBe('reconnecting');
  now += 1;
  await vi.advanceTimersByTimeAsync(1);
  vi.useRealTimers();
  await wait(() => !b.room.state.players.has(a.room.sessionId));
  expect(b.room.state.retainedChips).toBe(2000);
  expect(events(b).filter((e) => e.t === 'player:left' && e.seatIndex === 0)).toHaveLength(1);
  await expect(server.sdk.reconnect(token)).rejects.toThrow();
  conserved([b]);
});

it('consented leave 不保座，房主转移最小在场 seat，非当前离座不延长 deadline', async () => {
  const peers = await table(server, 4);
  await start(peers);
  const s = peers[1]!.room.state;
  const deadline = s.deadline;
  now += 5000;
  await peers[0]!.room.leave();
  await wait(() => !s.players.has(peers[0]!.room.sessionId));
  expect(s.hostId).toBe(peers[1]!.room.sessionId);
  expect(s.deadline).toBe(deadline);
  expect(s.handPlayers.get(peers[0]!.room.sessionId)).toMatchObject({ nickname: 'P0', seatIndex: 0, folded: true });
  await finish(peers.slice(1));
});

it('旧手全下者离开，新 id 同座不能获得旧牌或派彩；left 余额保留', async () => {
  const peers = await table(server, 3);
  await start(peers);
  const old = peers[0]!;
  await act(peers, { type: 'allIn' });
  await old.room.leave();
  await wait(() => !peers[1]!.room.state.players.has(old.room.sessionId));
  const options = { nickname: 'Attacker', id: old.room.sessionId, sessionId: old.room.sessionId, seatIndex: 0 };
  const newcomer = await observe(await server.sdk.joinById<PokerRoom['state']>(old.room.roomId, options));
  expect(newcomer.room.sessionId).not.toBe(old.room.sessionId);
  expect(newcomer.room.state.players.get(newcomer.room.sessionId)?.seatIndex).toBe(0);
  expect(newcomer.room.state.handPlayers.get(old.room.sessionId)).toMatchObject({ playerId: old.room.sessionId, seatIndex: 0, nickname: 'P0', allIn: true });
  expect(privateMessages(newcomer, 'deal')).toEqual([]);
  const s = newcomer.room.state;
  await rejected(newcomer, { t: 'action', handId: s.handId, turnVersion: s.turnVersion, action: { type: 'call' } }, 'NOT_SEATED');
  const active = [...peers.slice(1), newcomer];
  await finish(active);
  expect(newcomer.room.state.players.get(newcomer.room.sessionId)?.chips).toBe(2000);
  expect(s.results.find((r) => r.playerId === old.room.sessionId)?.chips).toBe(s.retainedChips);
  expect(s.results.some((r) => r.playerId === newcomer.room.sessionId)).toBe(false);
  expect(privateMessages(newcomer, 'deal')).toEqual([]);
});

it('零筹码仅结算后可重买，增加 introduced；再次重买拒绝', async () => {
  const peers = await table(server);
  await start(peers);
  await act(peers, { type: 'allIn' });
  await rejected(peers[0]!, { t: 'rebuy' }, 'INVALID_ACTION');
  await act(peers, { type: 'call' });
  const loser = peers.find((p) => p.room.state.players.get(p.room.sessionId)?.chips === 0)!;
  await command(loser, { t: 'rebuy', chips: 999999 });
  await wait(() => peers.every((p) => p.room.state.introducedChips === 6000));
  expect(loser.room.state.players.get(loser.room.sessionId)?.chips).toBe(2000);
  await rejected(loser, { t: 'rebuy' }, 'INVALID_ACTION');
  conserved(peers);
});

it('未曾 join 的房间在 30 分钟边界清理（时钟驱动，不实际等待半小时）', async () => {
  const room = await server.createRoom<PokerRoom>('seeded');
  // 本进程预留表也必须跟着房间走：房间活着时码是占住的，销毁后必须归还，
  // 否则预留表只增不减，被销毁房间的码也永远回收不回来。
  expect(isPairingCodeReserved(room.roomId)).toBe(true);
  now += 1_799_999;
  expect(await isPairingCodeTaken(room.roomId)).toBe(true);
  now += 1;
  await wait(() => !server.getRoomById(room.roomId));
  expect(await isPairingCodeTaken(room.roomId)).toBe(false);
  expect(isPairingCodeReserved(room.roomId)).toBe(false);
  await expect(server.sdk.joinById(room.roomId)).rejects.toThrow(/not found/i);
});

it('真实在线连接决定闲置时刻，join/reconnect 取消旧期限，全掉线仍会清理', async () => {
  const room = await server.createRoom<PokerRoom>('seeded');
  now += 1_700_000;
  const a = await observe(await server.sdk.joinById<PokerRoom>(room.roomId));
  now += 200_000;
  await command(a, { t: 'ping' });
  expect(await isPairingCodeTaken(room.roomId)).toBe(true);
  a.room.reconnection.enabled = false;
  const token = a.room.reconnectionToken;
  server.getRoomById<PokerRoom>(a.room.roomId).clients.find((c) => c.sessionId === a.room.sessionId)!.leave(1001);
  await wait(() => room.state.players.get(a.room.sessionId)?.presence === 'reconnecting');
  now += 100000;
  const recovered = await observe(await server.sdk.reconnect<PokerRoom>(token));
  now += 1_800_000;
  await command(recovered, { t: 'ping' });
  expect(await isPairingCodeTaken(room.roomId)).toBe(true);
  recovered.room.reconnection.enabled = false;
  room.clients.find((c) => c.sessionId === recovered.room.sessionId)!.leave(1001);
  await wait(() => room.state.players.get(a.room.sessionId)?.presence === 'reconnecting');
  now += 1_800_000;
  await wait(() => !server.getRoomById(room.roomId));
  expect(await isPairingCodeTaken(room.roomId)).toBe(false);
  expect(room.state.retainedChips).toBe(room.state.introducedChips);
  expect(room.state.players.size).toBe(0);
});

it('无变化 tick 不写匹配驱动，容量变更仍持久化', async () => {
  const peers = await table(server, 1);
  const peer = peers[0]!;
  const room = server.getRoomById<ClockRoom>(peer.room.roomId);
  // 只观察实际驱动写入，不替换行为，更不替换规则引擎。
  const writes = vi.spyOn(matchMaker.driver, 'update');
  try {
    const before = room.clockReads;
    await wait(() => room.clockReads >= before + 6);
    expect(writes).not.toHaveBeenCalled();
    await command(peer, { t: 'table:setConfig', config: { maxPlayers: 6 } });
    expect(room.maxClients).toBe(6);
    expect(writes).toHaveBeenCalled();
    const listing = await matchMaker.findRoomsByIds([room.roomId]);
    expect(listing.get(room.roomId)?.maxClients).toBe(6);
    conserved(peers);
  } finally {
    writes.mockRestore();
  }
});

it('dispose 正常取消 pending reconnection，不当作 hook 错误，之后停止时钟回调', async () => {
  const peers = await table(server, 1);
  const peer = peers[0]!;
  const room = server.getRoomById<ClockRoom>(peer.room.roomId);
  peer.room.reconnection.enabled = false;
  room.clients[0]!.leave(1001);
  await wait(() => room.state.players.get(peer.room.sessionId)?.presence === 'reconnecting');
  await room.disconnect();
  await socketIO(() => room.state.players.size === 0);
  expect(room.dropErrors).toEqual([]);
  const calls = room.clockReads;
  // 等待两次原定的 100ms 调度机会，确保销毁不是仅移除配对码。
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(room.clockReads).toBe(calls);
});

/**
 * 时钟回调里的抛出等于整台服务器：`setSimulationInterval` 抛出去没人接，Node 按未捕获异常处理，
 * 进程退出，一起跑的其他房间全部陪葬（D-000 是单进程部署）。
 * 所以"兜住"只完成一半：牌桌状态已经不可信，继续 tick 可能把算错的筹码派出去，
 * 必须**同时停下这张坏桌**。两者分别由 `escaped` 与 `shuffleFaults` 长度盯住。
 *
 * `process.on('uncaughtException')` 是探针，不是被测行为：修复前它会记到一次抛出（这条因此红），
 * 修复后必须永远为空。注册监听本身还保证"红"是可读的断言而不是把 worker 打死。
 */
it('tick 里引擎抛出不得带走进程：坏桌停下，别的房间照常开局', async () => {
  const escaped: unknown[] = [];
  const onUncaught = (error: unknown): void => { escaped.push(error); };
  process.on('uncaughtException', onUncaught);
  try {
    const peers = await table(server, 2, 'faulted');
    const roomId = peers[0]!.room.roomId;
    await start(peers);
    await finish(peers);
    expect(peers[0]!.room.state.handNo).toBe(1);
    faultNextShuffle = true;
    now = peers[0]!.room.state.nextHandAt; // 到点：下一次 tick 该开第二手，于是会洗牌
    await wait(() => shuffleFaults.length > 0);
    expect(escaped).toEqual([]);
    // 停下：这张桌不再驱动引擎（只抛一次，不是每 100ms 一次），并且连同房间一起收尾
    await wait(() => !server.getRoomById(roomId));
    expect(shuffleFaults).toHaveLength(1);
    expect(peers[0]!.room.state.handNo).toBe(1);
    expect(await isPairingCodeTaken(roomId)).toBe(false);
    // 同一进程里的另一张桌照常开局 —— 坏桌没有把邻居拖下去
    const others = await table(server, 2, 'seeded');
    await start(others);
    expect(others[0]!.room.state.phase).toBe('PREFLOP');
    conserved(others);
  } finally {
    faultNextShuffle = false;
    process.off('uncaughtException', onUncaught);
  }
});

it('配对码分配之后 onCreate 才失败，预留也要当场归还，不留谁也进不来的死码', async () => {
  // onDispose 靠不到它（房间从没登记进匹配表），所以归还得在 onCreate 的 catch 里完成。
  await expect(server.createRoom('broken')).rejects.toThrow(/onCreate 在分配配对码之后失败/);
  expect(createFailures).toHaveLength(1);
  const code = createFailures[0]!;
  expect(isValidPairingCode(code)).toBe(true);
  expect(isPairingCodeReserved(code)).toBe(false);
  // 只断言"不在表里"还不够：能重新占住才算真归还，占完立刻还给表以保持干净。
  expect(reservePairingCode(code)).toBe(true);
  releasePairingCode(code);
});
