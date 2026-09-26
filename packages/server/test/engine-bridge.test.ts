import { Decoder, Encoder } from '@colyseus/schema';
import { describe, expect, it } from 'vitest';
import {
  applyPlayerAction, createTable, DEFAULT_TABLE_CONFIG, getTableLegalActions, mulberry32,
  setPlayerPresence, startTable, tickTable, type TableState,
} from '@poker-room/shared';
import { syncPublicState } from '../src/engine-bridge';
import { PokerRoomState } from '../src/schema/PokerRoomState';

const profiles = ['a', 'b', 'c'].map((id, seatIndex) => ({ id, seatIndex, nickname: id, avatarSeed: id }));
function decode(state: PokerRoomState, encoder = new Encoder(state)): PokerRoomState {
  const decoded = new PokerRoomState();
  new Decoder(decoded).decode(encoder.encodeAll());
  return decoded;
}
function assertNoSecrets(input: unknown): void {
  if (typeof input !== 'object' || input === null) return;
  for (const [key, value] of Object.entries(input)) {
    expect(['holeCards', 'deck', 'burned', 'accounts', 'participants']).not.toContain(key);
    assertNoSecrets(value);
  }
}

/**
 * 把解码后的 wire 里所有「牌形状」的节点收出来。
 * 判据是**值**不是字段名：`{rank:number, suit:string}` 就是牌，装进叫 `cards`、`hand`、
 * `debug` 的字段都一样能抓到。`assertNoSecrets` 只按名字白名单拦，换个名字就漏
 * （本轮用探针实测过：底牌随公共状态广播，只靠名字检查的两条断言全绿）。
 */
function cardKeysIn(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const value of node) cardKeysIn(value, out);
    return out;
  }
  if (typeof node === 'object' && node !== null) {
    const rec = node as Record<string, unknown>;
    if (typeof rec.rank === 'number' && typeof rec.suit === 'string') out.push(`${rec.rank}:${rec.suit}`);
    else for (const value of Object.values(rec)) cardKeysIn(value, out);
  }
  return out;
}

/** 这一刻客户端**允许**看到的牌：公共牌，外加依法亮牌者的底牌（只剩一人时不亮牌）。 */
function allowedCardKeys(source: TableState): Set<string> {
  const keys = new Set(source.board.map((c) => `${c.rank}:${c.suit}`));
  const survivors = source.participants.filter((p) => !p.folded && !p.sittingOut);
  if (source.phase === 'HAND_END' && survivors.length >= 2) {
    for (const p of survivors) for (const c of p.holeCards) keys.add(`${c.rank}:${c.suit}`);
  }
  return keys;
}

describe('公共 schema 白名单及原始二进制编解码', () => {
  it('安全整数筹码、毫秒时间戳、-1 座位均不截断', () => {
    const source = createTable(DEFAULT_TABLE_CONFIG, [{ ...profiles[0]!, chips: Number.MAX_SAFE_INTEGER }]);
    const schema = new PokerRoomState();
    syncPublicState(schema, source, 1_800_000_000_123);
    const wire = decode(schema);
    expect(wire.players.get('a')?.chips).toBe(Number.MAX_SAFE_INTEGER);
    expect(wire.introducedChips).toBe(Number.MAX_SAFE_INTEGER);
    expect(wire.serverTime).toBe(1_800_000_000_123);
    expect([wire.dealerSeat, wire.sbSeat, wire.bbSeat, wire.currentTurn]).toEqual([-1, -1, -1, -1]);
    expect([wire.deadline, wire.nextHandAt]).toEqual([0, 0]);
    assertNoSecrets(wire.toJSON());
  });

  it('每街原始编码都不带任何底牌，公开金额/合法操作与真实引擎一致', () => {
    const ctx = { now: 1_800_000_000_000, rand: mulberry32(42) };
    let source = createTable(DEFAULT_TABLE_CONFIG, profiles);
    const schema = new PokerRoomState();
    // 与真实 Room 一样，每个 schema 根只拥有一个持续使用的 Encoder。
    const encoder = new Encoder(schema);
    const seen: string[] = [];
    let previous: TableState | undefined;
    for (let n = 0; n < 20; n++) {
      syncPublicState(schema, source, ctx.now, previous);
      const wire = decode(schema, encoder);
      assertNoSecrets(wire.toJSON());
      // 逐街做**值级**隐私断言：每一街的 wire 都必须自己过关，而不是只看最终的 JSON。
      // 只有最终态会被"摊牌前泄漏、摊牌时清空"这种写法蒙混过去（本轮探针就是这样全绿的）。
      const allowed = allowedCardKeys(source);
      const leaked = cardKeysIn(wire.toJSON()).filter((key) => !allowed.has(key));
      expect(leaked, `${wire.phase} 这一街的 wire 里出现了不该公开的牌`).toEqual([]);
      if (seen.at(-1) !== wire.phase) seen.push(wire.phase);
      expect(wire.board.toJSON()).toEqual(source.board);
      expect(wire.potTotal).toBe(source.participants.reduce((sum, p) => sum + p.committedTotal, 0));
      expect(wire.introducedChips).toBe(6000);
      for (const p of profiles) expect(wire.players.get(p.id)).toMatchObject(getTableLegalActions(source, p.id));
      if (source.phase === 'HAND_END') break;
      previous = source;
      if (source.phase === 'IDLE') source = startTable(source, 'a', ctx).newState;
      else {
        const p = source.participants.find((p) => p.seatIndex === source.currentTurn)!;
        const legal = getTableLegalActions(source, p.playerId);
        source = applyPlayerAction(source, p.playerId, { type: legal.canCheck ? 'check' : 'call' }, source.handId, source.turnVersion, ctx).newState;
      }
    }
    expect(seen).toEqual(['IDLE', 'PREFLOP', 'FLOP', 'TURN', 'RIVER', 'HAND_END']);
    const wire = decode(schema, encoder);
    expect(wire.pots.toJSON()).toEqual(source.pots);
    expect(wire.results.toJSON()).toEqual(source.results);
    expect([...wire.players.values()].reduce((sum, p) => sum + p.chips, 0)).toBe(6000);
  });

  it('reconnecting 仍公开，left 仅保留余额与本手身份；无变化 tick 不创建补丁', () => {
    const ctx = { now: 1_800_000_000_000, rand: mulberry32(42) };
    const initial = startTable(createTable(DEFAULT_TABLE_CONFIG, profiles), 'a', ctx).newState;
    const reconnecting = setPlayerPresence(initial, 'b', 'reconnecting', ctx).newState;
    const left = setPlayerPresence(reconnecting, 'c', 'left', ctx).newState;
    const schema = new PokerRoomState();
    syncPublicState(schema, left, ctx.now);
    const wire = decode(schema);
    expect(wire.players.get('b')?.presence).toBe('reconnecting');
    expect(wire.players.has('c')).toBe(false);
    expect(wire.handPlayers.get('c')).toMatchObject({ playerId: 'c', nickname: 'c', seatIndex: 2, folded: true });
    expect(wire.retainedChips).toBe(1980);
    expect([...wire.players.values()].reduce((sum, p) => sum + p.chips, 0) + wire.retainedChips + wire.potTotal).toBe(6000);
    const encoder = new Encoder(schema);
    encoder.encodeAll();
    encoder.discardChanges();
    const players = schema.players;
    const board = schema.board;
    syncPublicState(schema, tickTable(left, ctx).newState, ctx.now + 1, left);
    expect(encoder.hasChanges).toBe(false);
    expect(encoder.encode()).toHaveLength(0);
    expect(schema.players).toBe(players);
    expect(schema.board).toBe(board);
  });
});
