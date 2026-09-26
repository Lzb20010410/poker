import { describe, expect, it } from 'vitest';

import { evaluate7 } from '../src/engine';
import { expectBestFive, expectOrder, seven } from './evaluator-fixtures';

const cases = [
  {
    title: '轮子顺小于六高顺',
    a: 'As 2h 3d 4c 5s Kh 9d', b: '2s 3h 4d 5c 6s Kh 9d', order: -1,
  },
  {
    title: '最大顺子 TJQKA 大于九到 K 的顺子',
    a: '10s Jh Qd Kc As 4h 2d', b: '9s 10h Jd Qc Ks 4h 2d', order: 1,
  },
  {
    title: '轮子同花顺小于六高同花顺',
    a: 'As 2s 3s 4s 5s Kh 9d', b: '2h 3h 4h 5h 6h Ks 9d', order: -1,
  },
  {
    title: '同花 AK952 小于 AK953，比较到第五张',
    a: 'As Ks 9s 5s 2s Qh Jd', b: 'Ah Kh 9h 5h 3h Qs Jd', order: -1,
  },
  {
    title: '四条 K 的 A 踢脚胜过 2 踢脚，后三张用三种花色的 2',
    a: 'Ks Kh Kd Kc As 9h 2d', b: 'Ks Kh Kd Kc 2s 2h 2d', order: 1,
  },
  {
    title: '葫芦 AAA22 小于 AAA33，空 kickers 不丢失对子比较',
    a: 'As Ah Ad 2s 2h 9d 7c', b: 'As Ah Ad 3s 3h 9d 7c', order: -1,
  },
  {
    title: '葫芦 AAA22 大于 KKKAA，三条优先于对子',
    a: 'As Ah Ad 2s 2h 9d 7c', b: 'Ks Kh Kd As Ah 9d 7c', order: 1,
  },
  {
    title: '两对 AA22K 大于 AA22Q，单张踢脚决定胜负',
    a: 'As Ah 2s 2h Kd 9c 7d', b: 'As Ah 2s 2h Qd 9c 7d', order: 1,
  },
  {
    title: '两对 AA22 小于 AA33，第二对子优先于踢脚',
    a: 'As Ah 2s 2h Kd 9c 7d', b: 'As Ah 3s 3h Qd 9c 7d', order: -1,
  },
  {
    title: '两对大对子优先，小对子和 A 踢脚不能反超',
    a: 'Ks Kh 2s 2h 8d 7c 4d', b: 'Qs Qh Js Jh Ad 7c 4d', order: 1,
  },
  {
    title: '一对先比较对子点数，而不是高踢脚',
    a: 'Ks Kh Qd 9c 7s 4h 2d', b: 'Qs Qh Ad Kc 9s 4h 2d', order: 1,
  },
  {
    title: '一对第一层踢脚 K 胜 Q，不受后两张反向影响',
    a: 'As Ah Kd 9c 7s 4h 2d', b: 'As Ah Qd Jc 10s 4h 2d', order: 1,
  },
  {
    title: '一对第二层踢脚 Q 胜 J，不受第三层较低影响',
    a: 'As Ah Kd Qc 7s 4h 2d', b: 'As Ah Kd Jc 9s 4h 2d', order: 1,
  },
  {
    title: '一对第三层踢脚 AAKQ9 大于 AAKQ8',
    a: 'As Ah Kd Qc 9s 4h 2d', b: 'As Ah Kd Qc 8s 4h 2d', order: 1,
  },
  {
    title: '三条点数优先于两个高踢脚',
    a: '8s 8h 8d Qc 9s 4h 2d', b: '7s 7h 7d Ac Ks 4h 2d', order: 1,
  },
  {
    title: '三条比较第一踢脚',
    a: '7s 7h 7d Ac 9s 4h 2d', b: '7s 7h 7d Kc Qs 4h 2d', order: 1,
  },
  {
    title: '三条比较第二踢脚',
    a: '7s 7h 7d Ac Ks 4h 2d', b: '7s 7h 7d Ac Qs 4h 2d', order: 1,
  },
  {
    title: '四条点数优先于 A 踢脚',
    a: 'Ks Kh Kd Kc 2s 2h 2d', b: 'Qs Qh Qd Qc As 9h 2d', order: 1,
  },
  {
    title: '同花按第一张 A 胜 K',
    a: 'As Js 9s 5s 2s Qh 7d', b: 'Kh Qh 9h 5h 2h Js 7d', order: 1,
  },
  {
    title: '同花按第二张 K 胜 Q',
    a: 'As Ks 9s 5s 2s Qh Jd', b: 'Ah Qh Jh 5h 2h Ks 7d', order: 1,
  },
  {
    title: '同花按第三张 9 胜 8',
    a: 'As Ks 9s 5s 2s Qh Jd', b: 'Ah Kh 8h 7h 3h Qs Jd', order: 1,
  },
  {
    title: '同花按第四张 5 胜 4',
    a: 'As Ks 9s 5s 2s Qh Jd', b: 'Ah Kh 9h 4h 3h Qs Jd', order: 1,
  },
  {
    title: '高牌在前四张相同时比较第五张',
    a: 'As Kh 9d 7c 5s 3h 2d', b: 'Ah Ks 9c 7d 4s 3h 2d', order: 1,
  },
  {
    title: '同花异花色平分，黑桃不比红心大',
    a: 'As Ks 9s 5s 2s Qh Jd', b: 'Ah Kh 9h 5h 2h Qs Jd', order: 0,
  },
  {
    title: '高牌异花色平分，不以花色编码 score',
    a: 'As Kh 9d 7c 5s 3h 2d', b: 'Ah Kd 9c 7s 5h 3d 2c', order: 0,
  },
  {
    title: '不同花色的轮子平分，不将领域 A=14 误加进分值',
    a: 'As 2h 3d 4c 5s Kh 9d', b: 'Ah 2d 3c 4s 5h Kd 9c', order: 0,
  },
  {
    title: '一对相同五张时，废牌不参与比大小',
    a: 'As Ah Kd Qc 9s 4h 2d', b: 'As Ah Kd Qc 9s 7h 3d', order: 0,
  },
  {
    title: '双三条与同强葫芦平分，solver 多出的第六张无影响',
    a: 'As Ah Ad Ks Kh Kd 2c', b: 'As Ah Ad Ks Kh 9d 2c', order: 0,
  },
  {
    title: '六张同花与同强五张同花平分，低同花废牌无影响',
    a: 'As Ks 9s 7s 5s 2s Qh', b: 'As Ks 9s 7s 5s 3h Qd', order: 0,
  },
] satisfies readonly { title: string; a: string; b: string; order: -1 | 0 | 1 }[];

describe('compare：人工同类比较与平局', () => {
  it.each(cases)('$title', ({ a, b, order }) => {
    expectOrder(evaluate7(seven(a)), evaluate7(seven(b)), order);
  });
});

describe('compare：九种类别依次递增', () => {
  it.each([
    ['一对胜高牌', '2s 2h 9d 7c 5s 4h 3d', 'As Kh Qd 9c 7s 4h 2d'],
    ['两对胜一对', '3s 3h 2d 2c 9s 7h 5d', 'As Ah Kd Qc 9s 4h 2d'],
    ['三条胜两对', '2s 2h 2d 9c 7s 5h 3d', 'As Ah Kd Kc Qs 4h 2d'],
    ['顺子胜三条', 'As 2h 3d 4c 5s Kh 9d', 'As Ah Ad Kc Qs 4h 2d'],
    ['同花胜顺子', '2s 4s 7s 9s Js Qh Ad', 'As Kh Qd Jc 10s 4h 2d'],
    ['葫芦胜同花', '2s 2h 2d 3c 3s 9h 7d', 'As Ks Qs 9s 7s 4h 2d'],
    ['四条胜葫芦', '2s 2h 2d 2c 3s 7h 9d', 'As Ah Ad Ks Kh 9d 2c'],
    ['同花顺胜四条', 'As 2s 3s 4s 5s Kh 9d', 'As Ah Ad Ac Ks 9h 2d'],
  ])('%s', (_title, a, b) => {
    expectOrder(evaluate7(seven(a)), evaluate7(seven(b)), 1);
  });
});

describe('evaluate7：底牌与公共牌', () => {
  it('双方都使用公共同花顺时完全平分', () => {
    const board = '9s 8s 7s 6s 5s';
    const a = seven(`As Ah ${board}`);
    const b = seven(`Kd Qd ${board}`);
    const first = evaluate7(a);
    const second = evaluate7(b);
    expectBestFive(first, a, board);
    expectBestFive(second, b, board);
    expectOrder(first, second, 0);
  });

  it('两张底牌与三张公共牌组成的同花优于纯公共高牌', () => {
    const board = 'Qs 9s 2s Kh 3d';
    const a = seven(`As Js ${board}`);
    const b = seven(`8h 7d ${board}`);
    const first = evaluate7(a);
    const second = evaluate7(b);
    expectBestFive(first, a, 'As Qs Js 9s 2s');
    expectBestFive(second, b, 'Kh Qs 9s 8h 7d');
    expectOrder(first, second, 1);
  });

  it('公共四条 K 时，各自底牌的 A 与 Q 踢脚决定胜负', () => {
    const board = 'Ks Kh Kd Kc 2s';
    const a = seven(`As 3h ${board}`);
    const b = seven(`Qd Jh ${board}`);
    const first = evaluate7(a);
    const second = evaluate7(b);
    expectBestFive(first, a, 'Ks Kh Kd Kc As');
    expectBestFive(second, b, 'Ks Kh Kd Kc Qd');
    expect(first.kickers).toEqual([14]);
    expect(second.kickers).toEqual([12]);
    expectOrder(first, second, 1);
  });

  it('公共四条加 A 已是最佳五张时，底牌不能破坏平分', () => {
    const board = 'Ks Kh Kd Kc As';
    const a = seven(`Qs Jh ${board}`);
    const b = seven(`9d 2h ${board}`);
    const first = evaluate7(a);
    const second = evaluate7(b);
    expectBestFive(first, a, board);
    expectBestFive(second, b, board);
    expectOrder(first, second, 0);
  });
});
