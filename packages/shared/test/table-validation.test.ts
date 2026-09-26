import { describe, expect, it } from 'vitest';
import { DEFAULT_TABLE_CONFIG, type TableConfig } from '../src/types';
import {
  addTablePlayer,
  applyAction,
  applyPlayerAction,
  createTable,
  getPrivateMessages,
  getTableLegalActions,
  rebuyPlayer,
  setPlayerPresence,
  setTableConfig,
  sitPlayer,
  standPlayer,
  startHand,
  startTable,
} from '../src/engine/table';
import { act, context, freeze, table } from './table-fixtures';

const profile = { id: 'new', nickname: 'New', avatarSeed: 'N' };
describe('table validation', () => {
  it.each(
    [
      null,
      [],
      1,
      'x',
      { extra: 1 },
      { bigBlind: '20' },
      { actionTimeoutSec: 0 },
      { actionTimeoutSec: 301 },
      { maxPlayers: 1 },
      { maxPlayers: 9 },
      { minPlayersToStart: 3 },
      { smallBlind: 0 },
      { bigBlind: 21 },
      { startingChips: 0 },
      { startingChips: 1.1 },
      { startingChips: Infinity },
      { startingChips: Number.MAX_SAFE_INTEGER + 1 },
    ].map((patch) => [patch]),
  )('rejects malformed config patch %j', (patch) => {
    expect(() => setTableConfig(freeze(table()), 'p0', patch)).toThrow();
  });
  it('validates initial config rather than trusting static types', () => {
    expect(() =>
      createTable({ ...DEFAULT_TABLE_CONFIG, minPlayersToStart: 3 } as unknown as TableConfig, []),
    ).toThrow();
  });
  it.each([-1, 8, 0.5, NaN])('rejects invalid bootstrap or sit seat %s', (seat) => {
    expect(() => createTable(DEFAULT_TABLE_CONFIG, [{ ...profile, seatIndex: seat }])).toThrow();
    expect(() => sitPlayer(table(), 'p0', seat, context())).toThrow();
  });
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid bootstrap chips %s',
    (chips) => {
      expect(() =>
        createTable(DEFAULT_TABLE_CONFIG, [{ ...profile, seatIndex: 0, chips }]),
      ).toThrow();
    },
  );
  it('rejects duplicate ids, duplicate seats, too many accounts and unsafe chip totals', () => {
    expect(() =>
      createTable(DEFAULT_TABLE_CONFIG, [
        { ...profile, seatIndex: 0 },
        { ...profile, seatIndex: 1 },
      ]),
    ).toThrow();
    expect(() =>
      createTable(DEFAULT_TABLE_CONFIG, [
        { ...profile, seatIndex: 0 },
        { ...profile, id: 'x', seatIndex: 0 },
      ]),
    ).toThrow();
    expect(() =>
      createTable(
        { ...DEFAULT_TABLE_CONFIG, maxPlayers: 2 },
        [0, 1, 2].map((n) => ({ ...profile, id: String(n), seatIndex: null })),
      ),
    ).toThrow();
    expect(() => table([Number.MAX_SAFE_INTEGER, 1])).toThrow();
    expect(() => addTablePlayer(table([Number.MAX_SAFE_INTEGER, 0]), profile, context())).toThrow();
  });
  it('guards start by phase, time, online funded player count and host', () => {
    expect(() => startHand(table([200, 0]), context())).toThrow();
    const started = startHand(table(), context()).newState;
    expect(() => startHand(started, context())).toThrow();
    expect(() => startHand(act(started, 0, { type: 'fold' }), context(4999))).toThrow();
    expect(() => startTable(table(), 'p1', context())).toThrow(
      expect.objectContaining({ code: 'NOT_HOST' }),
    );
    expect(() => startTable(table(), 'missing', context())).toThrow();
  });
  it('all public identity operations reject unknown or permanently left accounts', () => {
    const state = table();
    for (const id of ['missing', 'p0']) {
      const next = id === 'p0' ? setPlayerPresence(state, id, 'left', context()).newState : state;
      expect(() => standPlayer(next, id, context())).toThrow();
      expect(() => sitPlayer(next, id, 4, context())).toThrow();
      expect(() => rebuyPlayer(next, id, context())).toThrow();
      expect(() => setPlayerPresence(next, id, 'online', context())).toThrow();
      expect(() =>
        applyPlayerAction(next, id, { type: 'fold' }, next.handId, next.turnVersion, context()),
      ).toThrow();
      expect(getPrivateMessages(next, id)).toEqual([]);
      expect(getTableLegalActions(next, id).canFold).toBe(false);
    }
  });
  it('rejects full room, reused id, occupied seat and reseating a live participant', () => {
    const state = createTable(
      { ...DEFAULT_TABLE_CONFIG, maxPlayers: 2 },
      [0, 1].map((n) => ({ ...profile, id: `p${String(n)}`, seatIndex: n })),
    );
    expect(() => addTablePlayer(state, profile, context())).toThrow(
      expect.objectContaining({ code: 'ROOM_FULL' }),
    );
    // 裸 `.toThrow()` 分不清"因为重号被拒"和"因为别的原因炸"，补上码。
    // 离开者那条尤其要紧：剪掉 `left` 记录正是靠绕过这里来"治内存"的（见 table-lifecycle 的墓碑用例）。
    expect(() => addTablePlayer(table(), { ...profile, id: 'p0' }, context())).toThrow(
      expect.objectContaining({ code: 'INVALID_ACTION' }),
    );
    const left = setPlayerPresence(table(), 'p0', 'left', context()).newState;
    expect(() => addTablePlayer(left, { ...profile, id: 'p0' }, context())).toThrow(
      expect.objectContaining({ code: 'INVALID_ACTION' }),
    );
    expect(() => sitPlayer(table(), 'p0', 1, context())).toThrow();
    expect(() => sitPlayer(startHand(table(), context()).newState, 'p0', 4, context())).toThrow();
  });
  it('rebuy only accepts seated online zero balances between hands', () => {
    expect(() => rebuyPlayer(table(), 'p0', context())).toThrow();
    expect(() => rebuyPlayer(startHand(table(), context()).newState, 'p0', context())).toThrow();
    const zero = table([0, 200]);
    expect(() =>
      rebuyPlayer(standPlayer(zero, 'p0', context()).newState, 'p0', context()),
    ).toThrow();
    expect(() =>
      rebuyPlayer(
        setPlayerPresence(zero, 'p0', 'reconnecting', context()).newState,
        'p0',
        context(),
      ),
    ).toThrow();
    expect(() => rebuyPlayer(table([0, Number.MAX_SAFE_INTEGER]), 'p0', context())).toThrow();
  });
  it('config refuses nonhost, active phase, capacity and seat shrink conflicts', () => {
    expect(() => setTableConfig(table(), 'p1', {})).toThrow(
      expect.objectContaining({ code: 'NOT_HOST' }),
    );
    expect(() => setTableConfig(startHand(table(), context()).newState, 'p0', {})).toThrow(
      expect.objectContaining({ code: 'CONFIG_LOCKED' }),
    );
    expect(() => setTableConfig(table([200, 200, 200]), 'p0', { maxPlayers: 2 })).toThrow();
    expect(() => setTableConfig(table([200, 200], [0, 6]), 'p0', { maxPlayers: 2 })).toThrow();
  });
  it('桌布只认 SPEC §4.6 那两档，别的一律拒（包括数字）', () => {
    expect(setTableConfig(table(), 'p0', { felt: 'blue' }).newState.config.felt).toBe('blue');
    expect(setTableConfig(table(), 'p0', { felt: 'green' }).newState.config.felt).toBe('green');
    expect(() => setTableConfig(table(), 'p0', { felt: 'purple' })).toThrow(
      expect.objectContaining({ code: 'INVALID_ACTION' }),
    );
    // `'1'` 与 `1` 都得拒：字符串数字会一路混到 schema 里变成第三种「桌布」
    expect(() => setTableConfig(table(), 'p0', { felt: 1 })).toThrow();
    expect(() => setTableConfig(table(), 'p0', { felt: '1' })).toThrow();
  });
  it('betting errors propagate with input and balances unchanged', () => {
    const state = freeze(startHand(table(), context()).newState);
    expect(() => applyAction(state, 1, { type: 'call' }, context())).toThrow(
      expect.objectContaining({ code: 'NOT_YOUR_TURN' }),
    );
    expect(() => applyAction(state, 0, { type: 'check' }, context())).toThrow(
      expect.objectContaining({ code: 'INVALID_ACTION' }),
    );
    expect(() => applyAction(state, 0, { type: 'raise', totalBet: 25 }, context())).toThrow(
      expect.objectContaining({ code: 'RAISE_TOO_SMALL' }),
    );
    expect(() => applyAction(state, 0, null, context())).toThrow();
    expect(state.accounts.map((p) => p.chips)).toEqual([190, 180]);
  });
});
