import { describe, expect, it } from 'vitest';
import { cardId, DEFAULT_TABLE_CONFIG } from '../src/types';
import { createTable, startHand, tickTable, addTablePlayer } from '../src/engine/table';
import { act, checkDown, conserved, context, freeze, table } from './table-fixtures';

describe('table dealing', () => {
  it('starts with accounts as the only chip balances and records instantaneous phases', () => {
    const initial = freeze(table());
    const update = startHand(initial, context());
    expect(initial.phase).toBe('IDLE');
    expect(update.phases).toEqual(['DEALING', 'PREFLOP']);
    expect(update.newState).toMatchObject({
      dealerSeat: 0,
      sbSeat: 0,
      bbSeat: 1,
      currentTurn: 0,
      phase: 'PREFLOP',
      currentBet: 20,
      lastRaiseSize: 20,
      deadline: 30000,
      handNo: 1,
    });
    expect(update.newState.accounts.map((p) => p.chips)).toEqual([190, 180]);
    expect(update.newState.participants.every((p) => !('chips' in p))).toBe(true);
    // §1.3 发底牌从庄家按钮的下一位开始；两人桌按钮**就是**小盲位，所以起点是座位 0 而不是大盲。
    expect(update.events.slice(0, 3)).toEqual([
      { t: 'hand:start', handId: update.newState.handId, dealerSeat: 0, sbSeat: 0, bbSeat: 1 },
      { t: 'shuffle' },
      { t: 'deal:start', count: 2, startSeat: 0 },
    ]);
    expect(update.privateMessages.map((m) => m.playerId)).toEqual(['p0', 'p1']);
    conserved(update.newState);
  });
  it.each([2, 3, 8])(
    '%i players: deterministic two-pass deal, unique cards and correct order',
    (count) => {
      const initial = table(Array.from({ length: count }, () => 200));
      const first = startHand(initial, context());
      expect(startHand(initial, context())).toEqual(first);
      const state = first.newState;
      const holes =
        count === 2
          ? [
              // 两人桌：第一张和第三张归庄家（=小盲），第二、第四张归大盲。
              ['10c', 'Ah'],
              ['3h', 'Ac'],
            ]
          : count === 3
            ? [
                ['Ah', '8s'],
                ['10c', 'Ac'],
                ['3h', '10d'],
              ]
            : [
                ['Jd', '3d'],
                ['10c', '6c'],
                ['3h', 'Qh'],
                ['Ah', '4s'],
                ['Ac', '2h'],
                ['10d', '5h'],
                ['8s', '3c'],
                ['Qc', 'Kc'],
              ];
      expect(state.participants.map((p) => p.holeCards.map(cardId))).toEqual(holes);
      expect(state.currentTurn).toBe(count === 2 ? 0 : 3 % count);
      expect(state.sbSeat).toBe(count === 2 ? 0 : 1);
      expect(state.bbSeat).toBe(count === 2 ? 1 : 2);
      expect(state.burned).toHaveLength(1);
      expect(state.deck).toHaveLength(51 - count * 2);
      expect(
        new Set(
          [...state.deck, ...state.burned, ...state.participants.flatMap((p) => p.holeCards)].map(
            cardId,
          ),
        ).size,
      ).toBe(52);
      let next = state;
      const order: number[] = [];
      while (next.phase === 'PREFLOP') {
        const seat = next.currentTurn!;
        order.push(seat);
        next = act(next, seat, { type: seat === state.bbSeat ? 'check' : 'call' });
      }
      expect(order).toEqual(
        count === 2 ? [0, 1] : Array.from({ length: count }, (_, i) => (3 + i) % count),
      );
      expect(next.currentTurn).toBe(1);
      checkDown(next);
    },
  );
  it('rotates past empty and zero-chip seats and resets the deck without resetting balances', () => {
    const initial = table([200, 0, 200], [1, 3, 6]);
    const ended = act(startHand(initial, context()).newState, 1, { type: 'fold' });
    expect(ended.accounts.map((p) => p.chips)).toEqual([190, 0, 210]);
    const next = tickTable(ended, context(5000)).newState;
    expect(next).toMatchObject({ dealerSeat: 6, sbSeat: 6, bbSeat: 1, handNo: 2 });
    expect(next.accounts.map((p) => p.chips)).toEqual([170, 0, 200]);
    expect(next.results).toEqual([]);
    expect(next.burned).toHaveLength(1);
    conserved(next);
  });
  /**
   * 两人桌（heads-up）的行动顺序，两条街各一次。真实规则：**庄家＝小盲**，
   * 翻牌前**最先**行动（大盲拿着 option，最后行动），翻牌后**最后**行动（先轮到小盲下一位＝大盲）。
   * `RULES-SPEC.md` §5.3 一直是这么写的，方向没错；本轮账本一度把它读反、并据此"修"过引擎，
   * 结果 18 条测试同时变红 —— 那批红测试才是证据：代码原本对，改动错，已全部回退。
   * 现在两条街的起点都写成**唯一一条规则**：翻牌前"严格在大盲之后"、每条下注街"严格在庄家之后"
   * （§5.2 原文）。不要按 `sbSeat` 取起点：多人桌那样会跳过小盲，两人桌那样只是
   * 恰好因为 `sbSeat === dealerSeat` 才碰对，两种人数都靠巧合而不是靠规则。
   */
  it('heads-up 翻牌前由庄家（小盲）先行动，翻牌后由大盲先行动', () => {
    const state = startHand(table([200, 200]), context()).newState;
    expect(state).toMatchObject({ dealerSeat: 0, sbSeat: 0, bbSeat: 1 });
    expect(state.currentTurn).toBe(0);
    const sbIn = act(state, 0, { type: 'call' });
    expect(sbIn.currentTurn).toBe(1);
    const flop = act(sbIn, 1, { type: 'check' });
    expect(flop.phase).toBe('FLOP');
    expect(flop.currentTurn).toBe(1);
    const turn = act(act(flop, 1, { type: 'check' }), 0, { type: 'check' });
    expect(turn.phase).toBe('TURN');
    expect(turn.currentTurn).toBe(1);
    conserved(turn);
  });
  it('heads-up 大盲不足额全下时立即关门跑完，未跟到的部分回到小盲', () => {
    const state = startHand(table([200, 6]), context()).newState;
    expect(state).toMatchObject({ dealerSeat: 0, sbSeat: 0, bbSeat: 1 });
    // 唯一还能行动的人已经和最低注额持平，另一人 all-in 且够不到 → 下注关闭，公共牌直接跑完
    expect(state.phase).toBe('HAND_END');
    expect(state.currentTurn).toBeNull();
    expect(state.board).toHaveLength(5);
    // 结算后 participants.committedTotal 一律清零（钱已回到 accounts，见 table-settlement.ts:126-130），
    // 所以"这一手谁投了多少"只能从 results[].delta 读：delta = 本手赢到的 - 本手投入。
    // 这一手是小盲（庄家）赢：池 10 + 6 = 16，小盲 200 - 10 + 16 = 206，大盲 delta 恰为 -6。
    // 同一件事的另一种写法（一个**已弃牌**的人拿回自己未跟到的部分，池 12 而不是 19），
    // 见 table-flow.test.ts 的「未跟到的部分退回原主：弃牌者多出来的钱不会被摊牌赢家顺走」。
    expect(state.results.map((r) => [r.playerId, r.chips, r.delta])).toEqual([
      ['p0', 206, 6],
      ['p1', 0, -6],
    ]);
    expect(state.accounts.map((a) => a.chips)).toEqual([206, 0]);
    conserved(state);
  });
  it('三人以上翻牌后由小盲先行动（§5.2 庄家下一位），不是大盲', () => {
    const state = startHand(table([200, 200, 200]), context()).newState;
    expect(state).toMatchObject({ dealerSeat: 0, sbSeat: 1, bbSeat: 2 });
    expect(state.currentTurn).toBe(0);
    const called = act(act(state, 0, { type: 'call' }), 1, { type: 'call' });
    expect(called.currentTurn).toBe(2);
    const flop = act(called, 2, { type: 'check' });
    expect(flop.phase).toBe('FLOP');
    expect(flop.currentTurn).toBe(1);
    conserved(flop);
  });
  it('short BB uses actual chips even below SB; configured BB is still the raise size', () => {
    const state = startHand(table([200, 200, 3]), context()).newState;
    expect(state).toMatchObject({ currentBet: 3, lastRaiseSize: 20, currentTurn: 0 });
    expect(state.participants[2]).toMatchObject({
      allIn: true,
      hasActed: false,
      committedTotal: 3,
    });
    const next = act(state, 0, { type: 'call' });
    expect(next.currentTurn).toBe(1);
    checkDown(act(next, 1, { type: 'check' }));
  });
  it('short blinds can run out immediately and allow nonstandard starting stacks', () => {
    const initial = createTable({ ...DEFAULT_TABLE_CONFIG, startingChips: 3 }, [
      { id: 'a', nickname: 'A', avatarSeed: 'A', seatIndex: 0 },
      { id: 'b', nickname: 'B', avatarSeed: 'B', seatIndex: 1 },
    ]);
    const update = startHand(initial, context());
    expect(update.newState).toMatchObject({ phase: 'HAND_END', runOutBoard: true });
    expect(update.newState.board).toHaveLength(5);
    conserved(update.newState);
  });
  it('mid-hand newcomer receives no cards until the very next hand', () => {
    const state = startHand(table(), context()).newState;
    const joined = addTablePlayer(
      freeze(state),
      { id: 'new', nickname: 'New', avatarSeed: 'N' },
      context(),
    );
    expect(joined.newState.participants).toEqual(state.participants);
    expect(joined.privateMessages).toEqual([]);
    const end = act(joined.newState, 0, { type: 'fold' });
    const next = startHand(end, context(5000));
    expect(next.newState.participants.map((p) => p.playerId)).toContain('new');
    expect(next.privateMessages.find((m) => m.playerId === 'new')?.message.t).toBe(
      'deal:holeCards',
    );
    conserved(next.newState);
  });
});
