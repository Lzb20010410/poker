/**
 * M2.1 追加：12 张自绘人头牌（J/Q/K × 4 花色）的结构约束。
 *
 * ## 为什么 `cardFaces.test.ts` 那 6 条不够
 *
 * 那 6 条防的是「查表串号 / 缺张 / 红黑写反」，全部是**跨 52 张**的性质。而这次是拿一个
 * 模板铺 12 个文件，失败方式完全不同，而且现有那张网一条都接不住：
 *
 * - **只换了字母**：J/Q/K 三张共用同一段人格，只有角标不同。它们在 120px 下是三张一样的牌，
 *   但 `cardFaces.test.ts` 的"52 张两两不同"照样绿——字节层面确实不同。
 * - **四个花色只换了颜色**：同上，而且更隐蔽，因为花色符号确实各不相同。
 * - **红花色只有角标是红的**：`df0000` 那条断言只看文件里有没有，不看它在哪儿。
 *
 * 所以这里补三条：**剥掉角标之后**，同花色的三个点数要不同、同点数的四个花色要不同、
 * 红花色要还带着红。剥角标靠的是文件里成对出现的 `<g data-corner>` 约定，
 * 这个约定本身由"至少两处 `rotate(180 83.543 121.333)`"那条用例盯着。
 */

import { describe, expect, it } from 'vitest';
import { SUITS, type Rank, type Suit } from '@poker-room/shared/view';

import { cardFaceSvg } from '../src/assets/cardFaces';

/** J/Q/K：上游 `simple` 版被换掉的那三个点数 */
const COURT_RANKS: readonly Rank[] = [11, 12, 13];

/** 牌心：上游数字牌用 `scale(-1,-1)` 做中心对称，等价于绕牌心转 180° */
const HALF_TURN = 'rotate(180 83.543 121.333)';

/**
 * 剥掉两块角标（左上 + 右下），只留画面本身。
 *
 * 依赖人头牌的书写约定：角标块内部**不得再嵌套** `<g>`，否则这个非贪婪匹配会提前收尾，
 * 于是"画面"里还残留半个角标，上面的三条断言就全都失去分辨力了。
 */
function artOnly(svg: string): string {
  return svg.replace(/<g data-corner[\s\S]*?<\/g>/g, '');
}

function court(rank: Rank, suit: Suit): string {
  return cardFaceSvg({ rank, suit });
}

describe('自绘人头牌', () => {
  it('每张都由"半幅 + 绕牌心 180°"构成，而不是把上下两半各画一遍', () => {
    for (const rank of COURT_RANKS) {
      for (const suit of SUITS) {
        const svg = court(rank, suit);
        // 角标一块、人格半幅一块。少于两处说明下半幅是手画的——那必然和上半幅对不齐。
        const turns = [...svg.matchAll(new RegExp(HALF_TURN.replace(/[.()]/g, '\\$&'), 'g'))].length;
        expect(turns, `${rank}${suit} 没有中心对称结构`).toBeGreaterThanOrEqual(2);
        expect(artOnly(svg), `${rank}${suit} 角标块里嵌套了 <g>`).not.toContain('data-corner');
      }
    }
  });

  it('同花色的 J/Q/K 剥掉角标后画面仍两两不同（防"只换了字母"）', () => {
    for (const suit of SUITS) {
      const arts = COURT_RANKS.map((rank) => artOnly(court(rank, suit)));
      expect(new Set(arts).size, `${suit} 的 J/Q/K 画面雷同`).toBe(COURT_RANKS.length);
    }
  });

  it('同点数的四个花色剥掉角标后画面两两不同（防"只换了颜色"）', () => {
    for (const rank of COURT_RANKS) {
      const arts = SUITS.map((suit) => artOnly(court(rank, suit)));
      expect(new Set(arts).size, `${rank} 的四个花色画面雷同`).toBe(SUITS.length);
    }
  });

  it('红花色的红在画面里，不只在角标上；黑花色剥掉角标后一滴红都没有', () => {
    for (const rank of COURT_RANKS) {
      for (const suit of SUITS) {
        const isRed = suit === 'h' || suit === 'd';
        expect(/DF0000/i.test(artOnly(court(rank, suit))), `${rank}${suit} 画面里没有红`).toBe(isRed);
      }
    }
  });

  it('角标里的花色符号锚在原点上（否则整枚符号会被 transform 甩出牌面）', () => {
    // 上游四个花色符号的 `d` 并不都是围绕原点画的：`club` 的起点是 (50.29, 22.70)，
    // 而角标和持物都按"符号以原点为中心"来写 `translate(...) scale(...)`。
    // 实测后果是梅花 K 的三叶草直接盖在脸上，而且它**不影响任何一条现有断言**——
    // 位置错在字节上完全看不出来。±12 是符号自身的半径上限（约 10.5）。
    for (const rank of COURT_RANKS) {
      for (const suit of SUITS) {
        const blocks = court(rank, suit).match(/<g data-corner[\s\S]*?<\/g>/g) ?? [];
        expect(blocks.length, `${rank}${suit} 角标块数量不对`).toBe(2);
        for (const block of blocks) {
          const d = /<path[^>]*\sd="([^"]+)"/.exec(block)?.[1];
          expect(d, `${rank}${suit} 角标里没有花色符号`).toBeTruthy();
          const start = /^[Mm]\s*(-?\d*\.?\d+)[,\s]+(-?\d*\.?\d+)/.exec((d ?? '').trim());
          expect(start, `${rank}${suit} 符号起点无法解析`).not.toBeNull();
          for (const raw of [start?.[1], start?.[2]]) {
            const value = Number(raw);
            expect(Math.abs(value), `${rank}${suit} 符号起点偏了 ${value}`).toBeLessThanOrEqual(12);
          }
        }
      }
    }
  });
});
