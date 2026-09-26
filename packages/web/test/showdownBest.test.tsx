/**
 * `bestFive` 高亮描边（M3.5）。
 *
 * TASKS.md M3.5 那两条验收线是**成对**的：「高亮的确实是组成牌型的 5 张（含公共牌）」
 * 和「平分底池时多个赢家都正确高亮」。它们共同要求牌桌上摊开的是**这手牌的全部七张**
 * （两枚底牌 + 五张公共牌），然后把其中五张描出来——只画那五张的话「高亮」无从谈起，
 * 「含公共牌」也无从检查。所以这里既测挑得对不对，也测摆的是七张。
 *
 * ## 为什么挑牌要按点数补一轮
 *
 * `award.bestFive` 是引擎按 `winners[0]` 那手牌算出来的五张（见
 * `shared/src/engine/table-settlement.ts`）。平分底池意味着几家的**点数**完全相同，
 * 但**花色未必**：公共牌 6♣7♣8♣9♣，甲拿 10♥、乙拿 10♠，两家同为 10 高顺子、各得一半池，
 * 可 `bestFive` 里那枚 10 是红心。只按「这张牌本身」精确匹配，乙那一排就只描得出四张——
 * 而屏幕上他会以为自己少一张，那是比不描更糟的误导。所以第二轮按点数补齐
 * （花色只在精确匹配那一轮用）。
 *
 * ## 为什么还要读一次样式表
 *
 * 描边住在 CSS 里。`.card-view--best` 挂了却没人写，屏幕上它就是一群和别的牌一模一样的图：
 * DOM 全绿、看不出差别。和 `seatTimer.test.tsx` 同一个道理。
 */

import { act, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Card, Rank, Suit } from '@poker-room/shared/view';

import { cardText } from '../src/table/components/CardView';
import { bestFiveKeys } from '../src/table/showdownHand';
import { TablePage } from '../src/table/TablePage';
import { createFakeClient, fakePlayer, FULL_LEGAL, type FakeRoomHandle } from './fakeClient';
import { renderWithProviders, resetWebState, seedProfile, TEST_PROFILE } from './harness';

const CODE = 'K7QM3D';

/** `cardText` 的反向：写测试时用 `J♠` 比写 `{ rank: 11, suit: 's' }` 好读 */
const RANKS: Record<string, Rank> = {
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  '10': 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};
const SUITS: Record<string, Suit> = { '♠': 's', '♥': 'h', '♦': 'd', '♣': 'c' };

function card(text: string): Card {
  const rank = RANKS[text.slice(0, -1)];
  const suit = SUITS[text.slice(-1)];
  if (rank === undefined || suit === undefined) throw new Error(`测试里写了不存在的牌：${text}`);
  return { rank, suit };
}

function hand(...texts: string[]): Card[] {
  return texts.map(card);
}

/** 两枚底牌：`RevealView.cards` 是固定长度的元组，靠 `.map` 推不出来 */
function hole(first: string, second: string): readonly [Card, Card] {
  return [card(first), card(second)];
}

const names = (cards: Iterable<Card>): Set<string> => new Set(Array.from(cards, cardText));

describe('bestFiveKeys · 该描边的到底是哪几张', () => {
  const seven = hand('J♠', 'J♦', '2♣', '9♦', 'K♥', 'J♥', '7♠');
  const best = hand('J♠', 'J♦', 'J♥', 'K♥', '9♦');

  it('五张都在这个人的七张里时，描出来的就是这五张', () => {
    expect(bestFiveKeys(seven, best)).toEqual(names(best));
  });

  it('公共牌参与组成牌型时，公共牌也在描边里（不只描他那两枚底牌）', () => {
    // J♥ / K♥ / 9♦ 三张都来自公共牌，缺任何一张就说明「含公共牌」这条不成立
    const picked = bestFiveKeys(seven, best);
    expect(hand('J♥', 'K♥', '9♦').every((c) => picked.has(cardText(c)))).toBe(true);
  });

  it('没参与牌型的两张不描', () => {
    const picked = bestFiveKeys(seven, best);
    expect(picked.has('2♣')).toBe(false);
    expect(picked.has('7♠')).toBe(false);
  });

  it('平分底池：点数一样、花色不一样时按点数补齐那一张', () => {
    // 公共牌 6♣7♣8♣9♣，甲 10♥、乙 10♠，两家同为 10 高顺子。引擎交回的是甲的那五张
    const bestFromA = hand('10♥', '9♣', '8♣', '7♣', '6♣');
    const bSeven = hand('10♠', '4♣', '6♣', '7♣', '8♣', '9♣', '2♦');
    expect(bestFiveKeys(bSeven, bestFromA)).toEqual(new Set(['10♠', '9♣', '8♣', '7♣', '6♣']));
  });

  it('这张牌不在他的七张里（连点数都对不上）时不描，也不硬凑第五张', () => {
    const picked = bestFiveKeys(seven, [...hand('J♠', 'J♦', 'J♥'), card('A♦'), card('5♦')]);
    expect(picked).toEqual(new Set(['J♠', 'J♦', 'J♥']));
  });

  it('同一枚牌不会被描两次', () => {
    expect(bestFiveKeys(seven, [...best, card('J♠')]).size).toBe(5);
  });
});

const CSS = readFileSync(resolve('src/styles/global.css'), 'utf8');

describe('描边在样式表里真的有主人', () => {
  it('.card-view--best 声明了 outline 或 box-shadow（漏了就和别的牌长得一模一样）', () => {
    const rule = /\.card-view--best\s*\{([^}]*)\}/.exec(CSS);
    expect(rule).not.toBeNull();
    expect(/(outline|box-shadow):/.test(rule?.[1] ?? '')).toBe(true);
  });
});

describe('摊牌面板 · 摆七张、描五张', () => {
  const me = fakePlayer('self', TEST_PROFILE.nickname, true, { seatIndex: 0, isHost: true, legal: FULL_LEGAL });
  const laowang = fakePlayer('peer-2', '老王', false, { seatIndex: 1 });
  const laoli = fakePlayer('peer-3', '老李', false, { seatIndex: 2 });

  beforeEach(() => {
    resetWebState();
    seedProfile();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetWebState();
  });

  async function openTable(): Promise<FakeRoomHandle> {
    const fake = createFakeClient();
    renderWithProviders(
      `/t/${CODE}`,
      <Routes>
        <Route path="/" element={null} />
        <Route path="/t/:code" element={<TablePage />} />
      </Routes>,
      { client: fake.client },
    );
    await screen.findByRole('heading', { name: `牌桌 ${CODE}` });
    const room = fake.rooms.get(CODE);
    if (room === undefined) throw new Error(`假 client 里没有房间 ${CODE}`);
    return room;
  }

  function frozen(playerId: string, seatIndex: number, nickname: string, avatarSeed: string) {
    return {
      playerId,
      seatIndex,
      nickname,
      avatarSeed,
      folded: false,
      allIn: false,
      sittingOut: false,
      hasActed: true,
      committedThisStreet: 20,
      committedTotal: 100,
    };
  }

  /** 每个赢家一排：这一排摊开了几张、其中描边的是哪几张 */
  function rows(): { readonly spread: number; readonly outlined: Set<string> }[] {
    const panel = screen.getByRole('region', { name: '摊牌与结算' });
    const rowList = panel.querySelectorAll('.award-list__hand-row');
    return Array.from(rowList, (row) => ({
      spread: row.querySelectorAll('img').length,
      outlined: new Set(Array.from(row.querySelectorAll('img.card-view--best'), (img) => img.getAttribute('alt') ?? '')),
    }));
  }

  it('赢家那一排摆的是他的七张牌，其中组成牌型的五张被描出来', async () => {
    const room = await openTable();
    act(() => {
      room.pushPlayers([me, laowang]);
      room.patch({
        phase: 'SHOWDOWN',
        isMyTurn: false,
        currentTurn: null,
        board: hand('2♣', '9♦', 'K♥', 'J♥', '7♠'),
        handPlayers: [
          frozen('self', 0, TEST_PROFILE.nickname, me.avatarSeed),
          frozen('peer-2', 1, '老王', laowang.avatarSeed),
        ],
        reveals: [{ playerId: 'peer-2', seatIndex: 1, cards: hole('J♠', 'J♦') }],
        awards: [{ potIndex: 0, winners: [1], amount: 200, handName: '三条', bestFive: hand('J♠', 'J♦', 'J♥', 'K♥', '9♦') }],
      });
    });
    await screen.findByText('三条');
    expect(rows()).toEqual([{ spread: 7, outlined: new Set(['J♠', 'J♦', 'J♥', 'K♥', '9♦']) }]);
  });

  it('平分底池时两个赢家各摆各的七张，各描五张', async () => {
    const room = await openTable();
    act(() => {
      room.pushPlayers([me, laowang, laoli]);
      room.patch({
        phase: 'SHOWDOWN',
        isMyTurn: false,
        currentTurn: null,
        board: hand('6♣', '7♣', '8♣', '9♣', '2♦'),
        handPlayers: [
          frozen('peer-2', 1, '老王', laowang.avatarSeed),
          frozen('peer-3', 2, '老李', laoli.avatarSeed),
        ],
        reveals: [
          { playerId: 'peer-2', seatIndex: 1, cards: hole('10♥', '3♠') },
          { playerId: 'peer-3', seatIndex: 2, cards: hole('10♠', '4♣') },
        ],
        // 引擎按 winners[0] 报回来的五张：那枚 10 是红心
        awards: [{ potIndex: 0, winners: [1, 2], amount: 120, handName: '顺子', bestFive: hand('10♥', '9♣', '8♣', '7♣', '6♣') }],
      });
    });
    await screen.findByText('顺子');
    expect(rows()).toEqual([
      { spread: 7, outlined: new Set(['10♥', '9♣', '8♣', '7♣', '6♣']) },
      // 老李那排里描的是黑桃 10：就是按点数补的那一张
      { spread: 7, outlined: new Set(['10♠', '9♣', '8♣', '7♣', '6♣']) },
    ]);
  });

  it('只剩一人未弃牌时不摆这一排：牌没翻开，就没有五张可描', async () => {
    const room = await openTable();
    act(() => {
      room.pushPlayers([me, laowang]);
      room.patch({
        phase: 'HAND_END',
        isMyTurn: false,
        currentTurn: null,
        handPlayers: [frozen('self', 0, TEST_PROFILE.nickname, me.avatarSeed)],
        reveals: [],
        awards: [{ potIndex: 0, winners: [0], amount: 30, handName: '其他玩家弃牌', bestFive: [] }],
      });
    });
    const panel = await screen.findByRole('region', { name: '摊牌与结算' });
    expect(within(panel).getByText('其他玩家弃牌')).toBeInTheDocument();
    expect(panel.querySelectorAll('.award-list__hand-row')).toHaveLength(0);
    expect(panel.querySelectorAll('.card-view--best')).toHaveLength(0);
  });
});
