import { describe, expect, it } from 'vitest';

import {
  ALL_CARD_IDS,
  BETTING_PHASES,
  DEFAULT_TABLE_CONFIG,
  FELT_VALUES,
  PHASES,
  RANKS,
  SUITS,
  cardId,
  isBettingPhase,
  parseCardId,
  rankLabel,
  suitIndex,
  suitSymbol,
} from '../src/types';

describe('常量表', () => {
  it('SUITS 是 4 种花色，顺序固定（下标即 suitIndex）', () => {
    expect(SUITS).toEqual(['s', 'h', 'd', 'c']);
  });

  it('RANKS 是 2..14 共 13 个点数，升序', () => {
    expect(RANKS).toHaveLength(13);
    expect(RANKS[0]).toBe(2);
    expect(RANKS[12]).toBe(14);
  });

  it('PHASES 按状态机顺序排列，含 8 个阶段', () => {
    expect(PHASES).toEqual([
      'IDLE',
      'DEALING',
      'PREFLOP',
      'FLOP',
      'TURN',
      'RIVER',
      'SHOWDOWN',
      'HAND_END',
    ]);
  });

  it('BETTING_PHASES 是 PHASES 的子集', () => {
    for (const phase of BETTING_PHASES) expect(PHASES).toContain(phase);
  });

  it('ALL_CARD_IDS 有 52 个且互不重复', () => {
    expect(ALL_CARD_IDS).toHaveLength(52);
    expect(new Set(ALL_CARD_IDS).size).toBe(52);
  });

  it('默认牌桌配置符合 RULES-SPEC §5.3', () => {
    expect(DEFAULT_TABLE_CONFIG).toEqual({
      smallBlind: 10,
      bigBlind: 20,
      startingChips: 2000,
      maxPlayers: 8,
      actionTimeoutSec: 30,
      minPlayersToStart: 2,
      // 桌布是纯展示字段，但它跟着一份配置同步给所有人，所以和规则字段同表断言
      felt: 'green',
    });
    expect(DEFAULT_TABLE_CONFIG.bigBlind).toBe(DEFAULT_TABLE_CONFIG.smallBlind * 2);
    expect(DEFAULT_TABLE_CONFIG.startingChips).toBe(DEFAULT_TABLE_CONFIG.bigBlind * 100);
    expect(FELT_VALUES).toContain(DEFAULT_TABLE_CONFIG.felt);
  });
});

describe('牌的显示', () => {
  it('rankLabel：11-14 用字母，其余用数字', () => {
    expect(rankLabel(14)).toBe('A');
    expect(rankLabel(13)).toBe('K');
    expect(rankLabel(12)).toBe('Q');
    expect(rankLabel(11)).toBe('J');
    expect(rankLabel(10)).toBe('10');
    expect(rankLabel(2)).toBe('2');
  });

  it('suitSymbol：四种花色各有符号', () => {
    expect(suitSymbol('s')).toBe('♠');
    expect(suitSymbol('h')).toBe('♥');
    expect(suitSymbol('d')).toBe('♦');
    expect(suitSymbol('c')).toBe('♣');
  });

  it('suitIndex：与 SUITS 下标一致', () => {
    expect(suitIndex('s')).toBe(0);
    expect(suitIndex('h')).toBe(1);
    expect(suitIndex('d')).toBe(2);
    expect(suitIndex('c')).toBe(3);
    SUITS.forEach((suit, i) => expect(suitIndex(suit)).toBe(i));
  });

  it('cardId 组合点数与花色', () => {
    expect(cardId({ rank: 14, suit: 's' })).toBe('As');
    expect(cardId({ rank: 10, suit: 'd' })).toBe('10d');
  });
});

describe('parseCardId', () => {
  it('接受全部 52 个合法标识', () => {
    for (const id of ALL_CARD_IDS) {
      expect(cardId(parseCardId(id))).toBe(id);
    }
  });

  it('每次返回新对象，不共享可变引用', () => {
    const a = parseCardId('As');
    const b = parseCardId('As');
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it('非法标识抛错（大小写、越界点数、非法花色、空串、多余字符）', () => {
    for (const bad of ['', 'A', 'Asx', 'as', 'aS', '1s', '15s', 'Ax', 'Xs', 'A s', '10x', 'T s']) {
      expect(() => parseCardId(bad)).toThrow(/非法的牌标识/);
    }
  });
});

describe('isBettingPhase', () => {
  it('四个下注阶段为 true', () => {
    for (const phase of ['PREFLOP', 'FLOP', 'TURN', 'RIVER'] as const) {
      expect(isBettingPhase(phase)).toBe(true);
    }
  });

  it('非下注阶段为 false（这些阶段不接受玩家动作）', () => {
    for (const phase of ['IDLE', 'DEALING', 'SHOWDOWN', 'HAND_END'] as const) {
      expect(isBettingPhase(phase)).toBe(false);
    }
  });
});
