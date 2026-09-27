/**
 * 「什么时候响一声」这张表（M4.2）。
 *
 * 音效的触发分成两路，这不是随手写的，而是照着动画层那条已经成立的分工：
 *
 * - **一次性事件**走服务端广播流（`SPEC.md` §2.3「动画由事件驱动，不由状态 diff 驱动」）：
 *   发牌、翻公共牌、筹码声。它们本来就是"一段表演"，跟着画面同一批输入才不会对不上。
 * - **状态类**走快照：轮到你、这手你赢了。理由是「轮到你」这件事的唯一事实来源就是
 *   服务端算好的 `isMyTurn`，而操作按钮的亮不亮读的也是它。要是提示音改从 `turn:change`
 *   事件去推，就会出现**声音先响、按钮后亮**（事件和 patch 不保证同帧到），
 *   玩家听见"该你了"却点不动——这比不响更糟。
 *
 * 摊牌亮牌不响：那一瞬间的视觉信息（对方的牌）比音效有用，而一手里它可能出现好几次。
 */

import type { S2C_Broadcast } from '@poker-room/shared/view';
import { describe, expect, it } from 'vitest';

import { createSnapshotCues, soundForEvent } from '../src/sound/cues';
import type { SoundName } from '../src/sound/synth';

import { fakeSnapshot } from './fakeClient';

/** 广播流那一路：一条事件 → 一个音效或静默 */
const BROADCAST_CUES: readonly {
  label: string;
  event: S2C_Broadcast;
  expected: SoundName | null;
}[] = [
  { label: '发牌', event: { t: 'deal:start', count: 6, startSeat: 0 }, expected: 'deal' },
  { label: '翻牌圈三张', event: { t: 'board:deal', phase: 'flop', cards: [] }, expected: 'board' },
  { label: '转牌一张', event: { t: 'board:deal', phase: 'turn', cards: [] }, expected: 'board' },
  {
    label: '加注',
    event: { t: 'action:made', seatIndex: 3, action: { type: 'raise', totalBet: 120 }, chipsDelta: 100 },
    expected: 'chip',
  },
  {
    label: '跟注',
    event: { t: 'action:made', seatIndex: 1, action: { type: 'call' }, chipsDelta: 20 },
    expected: 'chip',
  },
  {
    label: '派彩（筹码飞给赢家）',
    event: { t: 'pot:awarded', potIndex: 0, winners: [2], amount: 320, handName: '', bestFive: [] },
    expected: 'chip',
  },
  {
    label: '弃牌（没筹码动）',
    event: { t: 'action:made', seatIndex: 2, action: { type: 'fold' }, chipsDelta: 0 },
    expected: null,
  },
  {
    label: '过牌（没筹码动）',
    event: { t: 'action:made', seatIndex: 2, action: { type: 'check' }, chipsDelta: 0 },
    expected: null,
  },
  // 洗牌紧跟着就是发牌，两声会叠成一片，所以只留发牌那一下
  { label: '洗牌', event: { t: 'shuffle' }, expected: null },
  {
    label: '开一手',
    event: { t: 'hand:start', handId: 'h-1', dealerSeat: 0, sbSeat: 1, bbSeat: 2 },
    expected: null,
  },
  // 轮到你由快照那一路负责，见文件头
  { label: '轮到某人的广播', event: { t: 'turn:change', seatIndex: 0, deadline: 1 }, expected: null },
  { label: '阶段结束', event: { t: 'round:end', phase: 'TURN' }, expected: null },
  { label: '进摊牌', event: { t: 'showdown:start', pots: [] }, expected: null },
  { label: '结算', event: { t: 'hand:end', results: [] }, expected: null },
  {
    label: '有人进桌',
    event: { t: 'player:joined', seatIndex: 4, profile: { id: 'p-4', nickname: '老王', avatarSeed: 'S' } },
    expected: null,
  },
  { label: '有人离桌', event: { t: 'player:left', seatIndex: 4 }, expected: null },
  { label: '有人发表情', event: { t: 'player:emoji', seatIndex: 4, emoji: 'laugh' }, expected: null },
  { label: '有人补筹码', event: { t: 'chips:rebuy', seatIndex: 4 }, expected: null },
];

describe('音效 · 广播事件的触发表', () => {
  it.each(BROADCAST_CUES)('$label → $expected', ({ event, expected }) => {
    expect(soundForEvent(event)).toBe(expected);
  });
});

describe('音效 · 快照里的「轮到你」', () => {
  it('还没见过快照时不响（刷新进来不该为过期局面补一声）', () => {
    const cues = createSnapshotCues();
    expect(cues.observe(null)).toBeNull();
  });

  it('第一次见到「轮到我」就响，之后同样为真不重复', () => {
    const cues = createSnapshotCues();
    expect(cues.observe(fakeSnapshot('K7QM3D', { isMyTurn: true }))).toBe('turn');
    expect(cues.observe(fakeSnapshot('K7QM3D', { isMyTurn: true, currentBet: 40 }))).toBeNull();
  });

  it('轮下去再轮回来，才算第二次', () => {
    const cues = createSnapshotCues();
    cues.observe(fakeSnapshot('K7QM3D', { isMyTurn: true }));
    cues.observe(fakeSnapshot('K7QM3D', { isMyTurn: false }));
    expect(cues.observe(fakeSnapshot('K7QM3D', { isMyTurn: true }))).toBe('turn');
  });

  it('旁观和别人的回合都不响', () => {
    const cues = createSnapshotCues();
    expect(cues.observe(fakeSnapshot('K7QM3D', { isMyTurn: false, mySeat: null }))).toBeNull();
    expect(cues.observe(fakeSnapshot('K7QM3D', { isMyTurn: false, mySeat: 2, currentTurn: 1 }))).toBeNull();
  });

  it('两个 tracker 各自记基线：换房 / 重挂不会被上一份状态压住', () => {
    const first = createSnapshotCues();
    first.observe(fakeSnapshot('K7QM3D', { isMyTurn: true }));
    expect(createSnapshotCues().observe(fakeSnapshot('K7QM3D', { isMyTurn: true }))).toBe('turn');
  });
});

describe('音效 · 快照里的「这手你赢了」', () => {
  const win = { playerId: 'self', seatIndex: 0, chips: 2300, delta: 300, handName: '两对' };
  const lose = { playerId: 'other', seatIndex: 1, chips: 1700, delta: -300, handName: '一对' };

  it('我赢的一手响一次，同一手后面的 patch 不再响', () => {
    const cues = createSnapshotCues();
    cues.observe(fakeSnapshot('K7QM3D', { handId: 'h-1', results: [win, lose] }));
    expect(cues.observe(fakeSnapshot('K7QM3D', { handId: 'h-1', results: [win, lose] }))).toBeNull();
  });

  it('下一手我输了不响，再下一手我赢了又响', () => {
    const cues = createSnapshotCues();
    cues.observe(fakeSnapshot('K7QM3D', { handId: 'h-1', results: [win, lose] }));
    // 新的一手开局会把 results 清空（`table-flow.ts` 的 `results: []`）
    cues.observe(fakeSnapshot('K7QM3D', { handId: 'h-2', results: [] }));
    expect(cues.observe(fakeSnapshot('K7QM3D', { handId: 'h-2', results: [lose, { ...win, delta: -50 }] }))).toBeNull();
    expect(cues.observe(fakeSnapshot('K7QM3D', { handId: 'h-3', results: [win] }))).toBe('win');
  });

  it('只赢不响的那种情况：delta 为 0（平分池里我没分到）', () => {
    const cues = createSnapshotCues();
    expect(cues.observe(fakeSnapshot('K7QM3D', { handId: 'h-1', results: [{ ...win, delta: 0 }] }))).toBeNull();
  });

  it('结算与轮到我同时出现时先报胜利，且不再补一条轮到你', () => {
    const cues = createSnapshotCues();
    expect(
      cues.observe(fakeSnapshot('K7QM3D', { handId: 'h-1', isMyTurn: true, results: [win, lose] })),
    ).toBe('win');
    expect(cues.observe(fakeSnapshot('K7QM3D', { handId: 'h-2', isMyTurn: true, results: [] }))).toBeNull();
  });
});
