import { describe, it } from 'vitest';

import { expectPots, player, type Contribution } from './sidepot-fixtures';
import type { Pot } from '../src/types';

describe('calculatePots — RULES-SPEC §4.1 / §4.3，逐例验证筹码守恒', () => {
  const cases: readonly { name: string; players: readonly Contribution[]; pots: readonly Pot[] }[] = [
    {
      name: '1 两人等额投入：单池 200',
      players: [player(0, 100), player(1, 100)],
      pots: [{ amount: 200, eligible: [0, 1] }],
    },
    {
      name: '2 短码全下：主池 100，独享边池 50',
      players: [player(0, 50), player(1, 100)],
      pots: [{ amount: 100, eligible: [0, 1] }, { amount: 50, eligible: [1] }],
    },
    {
      name: '3 三人一档全下：主池 150，边池 100',
      players: [player(0, 50), player(1, 100), player(2, 100)],
      pots: [{ amount: 150, eligible: [0, 1, 2] }, { amount: 100, eligible: [1, 2] }],
    },
    {
      name: '4 两级全下：90 / 100 / 120，总额 310',
      players: [player(0, 30), player(1, 80), player(2, 200)],
      pots: [
        { amount: 90, eligible: [0, 1, 2] },
        { amount: 100, eligible: [1, 2] },
        { amount: 120, eligible: [2] },
      ],
    },
    {
      name: '5 弃牌者的筹码保留，但不能赢池',
      players: [player(0, 100, true), player(1, 100), player(2, 100)],
      pots: [ { amount: 300, eligible: [1, 2] } ],
    },
    {
      name: '6 全下后有人弃牌：边池必须是 100 而非 50',
      players: [player(0, 50), player(1, 100, true), player(2, 100)],
      pots: [{ amount: 150, eligible: [0, 2] }, { amount: 100, eligible: [2] }],
    },
    {
      name: '10 五人多级全下，中间弃牌层合并：150 / 180 / 200',
      players: [player(0, 30), player(1, 80), player(2, 60, true), player(3, 180), player(4, 180)],
      pots: [
        { amount: 150, eligible: [0, 1, 3, 4] },
        { amount: 180, eligible: [1, 3, 4] },
        { amount: 200, eligible: [3, 4] },
      ],
    },
    {
      name: '12 的模块部分：全员等额投入，全员 eligible（runout 由 table 验证）',
      players: [player(0, 50), player(3, 50), player(7, 50)],
      pots: [{ amount: 150, eligible: [0, 3, 7] }],
    },
    {
      name: '14 小盲弃牌：相同 eligible 的相邻层合并成 250',
      players: [player(0, 50, true), player(1, 100), player(2, 100)],
      pots: [{ amount: 250, eligible: [1, 2] }],
    },
    {
      name: '无资格的多个超额层逐个并入上一有效池',
      players: [player(0, 30), player(2, 30), player(4, 80, true), player(7, 120, true)],
      pots: [{ amount: 260, eligible: [0, 2] }],
    },
    {
      name: '先产生不同资格的边池，再并入弃牌者超额层',
      players: [player(0, 30), player(2, 50), player(7, 100, true)],
      pots: [{ amount: 90, eligible: [0, 2] }, { amount: 90, eligible: [2] }],
    },
    {
      name: '连续三个同资格层合并，保留非排序的座位输入',
      players: [player(7, 100), player(4, 20, true), player(0, 100), player(2, 50, true)],
      pots: [{ amount: 270, eligible: [7, 0] }],
    },
    { name: '空参与者返回空池', players: [], pots: [] },
    {
      name: '零投入不创建池，包括已弃牌者',
      players: [player(0, 0), player(7, 0, true)],
      pots: [],
    },
    {
      name: '零投入层被跳过，零投入玩家不获得正额池资格',
      players: [player(0, 0), player(3, 50), player(7, 50)],
      pots: [{ amount: 100, eligible: [3, 7] }],
    },
    {
      name: '总额可恰好达到安全整数上限',
      players: [player(0, Number.MAX_SAFE_INTEGER - 1), player(7, 1)],
      pots: [
        { amount: 2, eligible: [0, 7] },
        { amount: Number.MAX_SAFE_INTEGER - 2, eligible: [0] },
      ],
    },
    {
      name: '8 人 8 个投入层均保留，单筹码差额也守恒',
      players: Array.from({ length: 8 }, (_, seat) => player(seat, seat + 1)),
      pots: Array.from({ length: 8 }, (_, level) => ({
        amount: 8 - level,
        eligible: Array.from({ length: 8 - level }, (_, offset) => level + offset),
      })),
    },
  ];

  it.each(cases)('$name', ({ players, pots }) => {
    expectPots(Object.freeze(players.map((entry) => Object.freeze(entry))), pots);
  });
});
