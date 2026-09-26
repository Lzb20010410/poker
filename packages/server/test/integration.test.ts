/**
 * M0.3 集成测试：起一个真实的 Colyseus 服务端，用真实的 SDK 客户端连进去。
 *
 * 这一层的价值在于验证「跨进程/跨网络的同步」，纯单测覆盖不到的部分：
 * - schema 增量同步是否真的把昵称广播给了房间里所有人
 * - 配对码 == roomId 这个设计（DECISIONS.md D-009）是否真的能用 joinById 进房
 * - /health 是否真的挂在同一个 HTTP 端口上
 *
 * 端口说明（踩过坑，别再踩）：`boot()` 的 `Server` 重载**忽略**第二个 port 参数，
 * 内部写死 `DEFAULT_TEST_PORT = 2568`。本文件要的正是"连 /health 一起验"，只有这个重载
 * 能传现成的 Server，所以我们就吃 2568 —— 但必须把 `TEST_PORT = 2568` 显式写出来。
 * `poker-network`（2569）与 `poker-lifecycle`（2570）改用 `boot({ rooms, initializeExpress }, port)`
 * 那个重载自己挑端口。这条不再靠人记：`scripts/check-arch.mjs` 规则 8 会扫所有 server 测试
 * 文件的 `boot()` 调用，端口撞车、占用 2567/5173、或吃了隐含 2568 却没写出 2568 都会让 lint 失败。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { boot, type ColyseusTestServer } from '@colyseus/testing';
import { isValidPairingCode, PAIRING_CODE_LENGTH, sanitizeAvatarSeed } from '@poker-room/shared';

import { createGameServer } from '../src/index';
import type { HealthResponse } from '../src/routes';

const TEST_PORT = 2568;
const HTTP_BASE = `http://127.0.0.1:${TEST_PORT}`;

/**
 * 客户端解码出来的 state 不是服务端 `PokerRoomState` 的实例，只是结构相同
 * （客户端用反射现场造类）。这里按结构声明，避免把服务端的类硬 `as` 过去。
 */
interface ClientPokerState {
  joinCode: string;
  players: { values(): Iterable<{ nickname: string; avatarSeed: string }> };
}

/** SDK Room 里我们用到的那一小截。写死结构比去追 SDK 的深层泛型划算 */
interface ClientRoom {
  roomId: string;
  sessionId: string;
  state: ClientPokerState;
  onMessage(type: '*', callback: (type: string | number, payload: unknown) => void): unknown;
  waitForInitialState(): Promise<void>;
  leave(consented?: boolean): Promise<void>;
}

const messages: Array<{ type: string | number; payload: unknown }> = [];
function collectMessages(room: ClientRoom): void {
  room.onMessage('*', (type, payload) => messages.push({ type, payload }));
}
let ts: ColyseusTestServer;

/** 轮询等待条件成立。比 waitForNextPatch 稳：patch 可能不含我们关心的字段 */
async function waitFor(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs}ms）：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function nicknames(room: ClientRoom): string[] {
  return [...room.state.players.values()].map((p) => p.nickname).sort();
}

function slots(room: ClientRoom): Array<{ nickname: string; avatarSeed: string }> {
  return [...room.state.players.values()];
}

/** 创建一个房间并连上第一个客户端 */
async function createRoom(nickname: string, avatarSeed?: string): Promise<ClientRoom> {
  const room = (await ts.sdk.create('poker', { nickname, avatarSeed })) as unknown as ClientRoom;
  collectMessages(room);
  await room.waitForInitialState();
  return room;
}

beforeAll(async () => {
  ts = await boot(createGameServer());
}, 60_000);

afterAll(async () => {
  await ts.cleanup();
  await ts.shutdown();
}, 60_000);

describe('HTTP 路由', () => {
  it('GET /health 返回 200 与约定的 JSON 体', async () => {
    const res = await fetch(`${HTTP_BASE}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthResponse;
    expect(body.ok).toBe(true);
    expect(body.service).toBe('poker-room-server');
    expect(typeof body.uptimeSec).toBe('number');
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0);
  });

  it('未知路径返回 404（确认路由没有兜底吞掉一切）', async () => {
    const res = await fetch(`${HTTP_BASE}/definitely-not-a-route`);
    expect(res.status).toBe(404);
  });
});

describe('配对码即 roomId（D-009）', () => {
  it('创建房间后 roomId 就是合法配对码，且和 state.joinCode 一致', async () => {
    const alice = await createRoom('Alice');
    expect(alice.roomId).toHaveLength(PAIRING_CODE_LENGTH);
    expect(isValidPairingCode(alice.roomId)).toBe(true);
    expect(alice.state.joinCode).toBe(alice.roomId);
    await alice.leave();
  });

  it('不同房间的配对码互不相同', async () => {
    const a = await createRoom('A');
    const b = await createRoom('B');
    expect(a.roomId).not.toBe(b.roomId);
    await Promise.all([a.leave(), b.leave()]);
  });

  it('不存在的配对码 joinById 会被拒（玩家打错码的情形）', async () => {
    await expect(ts.sdk.joinById('ZZZZZZ', { nickname: 'Ghost' })).rejects.toThrow(/not found|matched|join/i);
  });
});

describe('两个客户端用同一配对码进入同一房间', () => {
  it('双方都能在 schema 里看到对方的昵称', async () => {
    const alice = await createRoom('Alice');
    const code = alice.roomId;

    // 关键路径：第二个玩家只拿配对码进房，不需要任何 HTTP 解析端点
    const bob = (await ts.sdk.joinById(code, { nickname: 'Bob' })) as unknown as ClientRoom;
    collectMessages(bob);
    await bob.waitForInitialState();

    expect(bob.roomId).toBe(code);
    expect(nicknames(bob)).toEqual(['Alice', 'Bob']);

    // Alice 那边是异步收到的，等一下
    await waitFor(() => nicknames(alice).includes('Bob'), 'Alice 收到 Bob 的昵称');
    expect(nicknames(alice)).toEqual(['Alice', 'Bob']);

    await Promise.all([alice.leave(), bob.leave()]);
  });

  it('第三个人也能进来，三个人互相可见', async () => {
    const alice = await createRoom('Alice');
    const code = alice.roomId;
    const bob = (await ts.sdk.joinById(code, { nickname: 'Bob' })) as unknown as ClientRoom;
    collectMessages(bob);
    await bob.waitForInitialState();
    const carol = (await ts.sdk.joinById(code, { nickname: 'Carol' })) as unknown as ClientRoom;
    collectMessages(carol);
    await carol.waitForInitialState();

    expect(nicknames(carol)).toEqual(['Alice', 'Bob', 'Carol']);
    await waitFor(() => nicknames(alice).length === 3, 'Alice 看到 3 个人');
    expect(nicknames(alice)).toEqual(['Alice', 'Bob', 'Carol']);

    await Promise.all([alice.leave(), bob.leave(), carol.leave()]);
  });

  it('玩家离开后从其他人的 players 里消失', async () => {
    const alice = await createRoom('Alice');
    const code = alice.roomId;
    const bob = (await ts.sdk.joinById(code, { nickname: 'Bob' })) as unknown as ClientRoom;
    collectMessages(bob);
    await bob.waitForInitialState();
    await waitFor(() => nicknames(alice).includes('Bob'), 'Alice 收到 Bob');

    await bob.leave();
    await waitFor(() => !nicknames(alice).includes('Bob'), 'Alice 看到 Bob 离开');
    expect(nicknames(alice)).toEqual(['Alice']);

    await alice.leave();
  });
});

describe('服务端权威：昵称由服务端裁剪', () => {
  it('客户端传来的脏昵称被清洗后才进 schema', async () => {
    // 首尾空白 + RTL override + 零宽空格，都是能用来伪装身份的字符
    const room = await createRoom('  \u202EAdmin\u200B  ');
    expect(nicknames(room)).toEqual(['Admin']);
    await room.leave();
  });

  it('超长昵称被按码点截断到 16', async () => {
    const room = await createRoom('A'.repeat(40));
    expect(nicknames(room)).toEqual(['A'.repeat(16)]);
    await room.leave();
  });

  it('空昵称回落到「玩家 + sessionId 后 4 位」，同房间不重名', async () => {
    const room = await createRoom('');
    const names = nicknames(room);
    expect(names).toHaveLength(1);
    // 非空断言安全：上一行刚断言过 names 长度为 1
    const name = names[0]!;
    expect(name).toMatch(/^玩家.{4}$/);
    expect(room.sessionId.endsWith(name.slice(-4))).toBe(true);
    await room.leave();
  });
});

describe('头像 seed 同步（M0.4 大厅要显示头像）', () => {
  it('同步的是 seed 而不是图片，双方看到的 seed 一致', async () => {
    const alice = await createRoom('Alice', 'aliceSeed1');
    const bob = (await ts.sdk.joinById(alice.roomId, {
      nickname: 'Bob',
      avatarSeed: 'bobSeed2',
    })) as unknown as ClientRoom;
    collectMessages(bob);
    await bob.waitForInitialState();
    await waitFor(() => slots(alice).length === 2, 'Alice 看到 Bob');

    for (const view of [alice, bob]) {
      const byName = new Map(slots(view).map((s) => [s.nickname, s.avatarSeed]));
      expect(byName.get('Alice')).toBe('aliceSeed1');
      expect(byName.get('Bob')).toBe('bobSeed2');
    }

    await Promise.all([alice.leave(), bob.leave()]);
  });

  it('客户端传来的脏 seed 被服务端裁剪', async () => {
    const room = await createRoom('Alice', '  a"b<c>  ');
    expect(slots(room)[0]!.avatarSeed).toBe('abc');
    await room.leave();
  });

  it('没传 seed 时回落到 sessionId，保证同房间不撞头像', async () => {
    const room = await createRoom('Alice');
    const slot = slots(room)[0]!;
    expect(slot.avatarSeed).toMatch(/^[A-Za-z0-9]+$/);
    // 回落值也要过一遍清洗，而 Colyseus 的 sessionId 形如 `2Jzi8NG-n`（带连字符），
    // 所以这里不能断言「sessionId 包含 seed」，只能断言「seed 等于清洗后的 sessionId」。
    expect(slot.avatarSeed).toBe(sanitizeAvatarSeed(room.sessionId, 'unused'));
    await room.leave();
  });
});
