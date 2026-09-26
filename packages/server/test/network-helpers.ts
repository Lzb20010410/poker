import { expect } from 'vitest';
import type { Room } from '@colyseus/sdk';
import type { ColyseusTestServer } from '@colyseus/testing';
import type { Action, S2C_Broadcast, S2C_Private } from '@poker-room/shared';
import type { PokerRoom } from '../src/rooms/PokerRoom';

export interface Peer {
  room: Room<PokerRoom>;
  messages: Array<{ type: string | number; payload: unknown }>;
  eventVersions: Array<{ event: S2C_Broadcast; version: number; phase: string }>;
}
export async function wait(check: () => boolean, timeout = 3000): Promise<void> {
  await expect.poll(check, { timeout, interval: 10 }).toBe(true);
}
export async function observe(room: Room<PokerRoom>, resync = true): Promise<Peer> {
  const peer: Peer = { room, messages: [], eventVersions: [] };
  room.onMessage('*', (type, payload: unknown) => {
    peer.messages.push({ type, payload });
    if (type === 'event') peer.eventVersions.push({
      event: payload as S2C_Broadcast, version: room.state.turnVersion, phase: room.state.phase,
    });
  });
  // 不依赖 testing 的 waitForInitialState 补丁；生产 SDK 的 resolve 早于全量状态。
  await wait(() => !!room.state?.joinCode);
  if (resync) await command(peer, { t: 'ping' });
  return peer;
}
export async function command(peer: Peer, input: unknown): Promise<void> {
  const count = peer.messages.filter((m) => m.type === 'pong').length;
  peer.room.send('command', input);
  const isPing = typeof input === 'object' && input !== null && 't' in input && input.t === 'ping';
  if (!isPing) peer.room.send('command', { t: 'ping' });
  await wait(() => peer.messages.filter((m) => m.type === 'pong').length > count);
}
export async function table(server: ColyseusTestServer, count = 2, name = 'seeded'): Promise<Peer[]> {
  const first = await observe(await server.sdk.create<PokerRoom>(name, { nickname: 'P0' }));
  const peers = [first];
  for (let i = 1; i < count; i++) {
    peers.push(await observe(await server.sdk.joinById<PokerRoom>(first.room.roomId, { nickname: `P${i}` })));
  }
  await wait(() => peers.every((p) => p.room.state.players.size === count));
  return peers;
}
export async function start(peers: Peer[]): Promise<void> {
  await command(peers[0]!, { t: 'table:start' });
  await wait(() => peers.every((p) => p.room.state.phase === 'PREFLOP'));
}
export function events(peer: Peer): S2C_Broadcast[] {
  return peer.messages.filter((m) => m.type === 'event').map((m) => m.payload as S2C_Broadcast);
}
export function privateMessages(peer: Peer, type: string): S2C_Private[] {
  return peer.messages.filter((m) => m.type === type).map((m) => m.payload as S2C_Private);
}
export function transmittedCards(input: unknown): string[] {
  if (typeof input !== 'object' || input === null) return [];
  if ('rank' in input && 'suit' in input && typeof input.rank === 'number' && typeof input.suit === 'string') {
    return [`${input.rank}:${input.suit}`];
  }
  return Object.values(input).flatMap((value: unknown) => transmittedCards(value));
}
/**
 * 某个客户端「看得到的一切牌」：全量状态 + 它收到的每一条下行消息，只排除发给它自己的那条底牌。
 *
 * 之所以按内容抽牌而不是 `JSON.stringify(...).not.toMatch(/holeCards|deck/)`：后者只认字段名，
 * 服务器把底牌换个键名（`hc`、`cards`、塞进 `bestFive`）就查不出来了，而那正是本项目唯一
 * 不可妥协的隐私故障。这里数的是牌本身，跟键名无关。
 */
export function visibleCards(peer: Peer): string[] {
  return transmittedCards([
    peer.room.state.toJSON(),
    peer.messages.filter((m) => m.type !== 'deal'),
  ]);
}
export function actor(peers: Peer[]): Peer {
  const state = peers[0]!.room.state;
  const hand = [...state.handPlayers.values()].find((p) => p.seatIndex === state.currentTurn);
  const peer = peers.find((p) => p.room.sessionId === hand?.playerId);
  if (!peer) throw new Error('当前行动者没有连接');
  return peer;
}
export async function act(peers: Peer[], action: Action): Promise<void> {
  const p = actor(peers);
  const { handId, turnVersion } = p.room.state;
  await command(p, { t: 'action', handId, turnVersion, action });
  await wait(() => peers.every((p) => p.room.state.turnVersion > turnVersion || p.room.state.phase === 'HAND_END'));
}
export async function finish(peers: Peer[]): Promise<void> {
  for (let i = 0; i < 100 && peers[0]!.room.state.phase !== 'HAND_END'; i++) {
    const p = actor(peers);
    const legal = p.room.state.players.get(p.room.sessionId)!;
    await act(peers, { type: legal.canCheck ? 'check' : 'call' });
  }
  expect(peers[0]!.room.state.phase).toBe('HAND_END');
  conserved(peers);
}
export function conserved(peers: Peer[]): void {
  for (const p of peers) {
    const s = p.room.state;
    const chips = [...s.players.values()].reduce((sum, a) => sum + a.chips, 0);
    expect(chips + s.retainedChips + s.potTotal).toBe(s.introducedChips);
    if (s.phase === 'HAND_END') expect(s.potTotal).toBe(0);
  }
}
export async function rejected(peer: Peer, input: unknown, code: string): Promise<void> {
  const before = JSON.stringify(peer.room.state);
  const count = privateMessages(peer, 'error').length;
  await command(peer, input);
  const errors = privateMessages(peer, 'error');
  expect(errors).toHaveLength(count + 1);
  expect(errors.at(-1)).toMatchObject({ t: 'error', code });
  expect(errors.at(-1)).not.toHaveProperty('ref');
  expect(JSON.stringify(peer.room.state)).toBe(before);
}
