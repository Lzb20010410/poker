/**
 * 摊牌描边：从一个人的七张牌里挑出「组成牌型的那五张」（M3.5）。
 *
 * ## 这里只挑，不判
 *
 * 五张是引擎算好的（`shared/src/engine/evaluator.ts` 交回 `bestFive`，派彩事件原样带上来），
 * 这个文件做的事只是把它映射回**这一排要画出来的七张牌**上的哪几个位置。
 * 谁赢、牌型多大，前端一处都不自己算（AGENTS.md 铁律：规则只住在 `shared/engine`）。
 *
 * ## 为什么不能只按「这张牌本身」精确匹配
 *
 * `award.bestFive` 是按 `winners[0]` 那手牌算的（见 `table-settlement.ts` 那行
 * `hands.get(award.winners[0])`）。平分底池时几家的**点数**必然完全相同——否则就打不成平手，
 * 但**花色未必**：公共牌 6♣7♣8♣9♣，甲拿 10♥、乙拿 10♠，两家同为 10 高顺子、各分一半池，
 * 而报回来的那五张里那枚 10 是红心。只按精确牌面匹配，乙那一排只描得出四张：
 * 屏幕上他会以为自己少一张，那是比不描更糟的误导。
 *
 * 所以分两轮：先按整张牌精确配对（花色对得上就该用花色），剩下那些按点数补
 * （同一枚点数只会用掉一次，所以不会多描）。两轮都配不上的那张直接放弃——
 * 那说明它不在这人的七张里，硬找一张替它上去就是凭空给牌桌加牌。
 */

import type { Card } from '@poker-room/shared/view';

import { cardText } from './components/CardView';

/**
 * 交回该描边的牌的 `cardText` 集合，用来喂 `CardRow` 的 `highlight`。
 *
 * 键而不是索引：调用方那一排里同一个数组还会被 `CardView` 拿去当 `key`，
 * 索引一旦因为谁被过滤掉而错位，描边就会挪到别的牌上；牌面本身不会。
 */
export function bestFiveKeys(seven: readonly Card[], bestFive: readonly Card[]): Set<string> {
  const pool = new Map<string, Card>();
  for (const card of seven) {
    const key = cardText(card);
    if (!pool.has(key)) pool.set(key, card);
  }

  const picked = new Set<string>();
  const needRankMatch: Card[] = [];
  for (const card of bestFive) {
    const key = cardText(card);
    if (pool.delete(key)) picked.add(key);
    else needRankMatch.push(card);
  }

  for (const card of needRankMatch) {
    for (const [key, candidate] of pool) {
      if (candidate.rank !== card.rank) continue;
      pool.delete(key);
      picked.add(key);
      break;
    }
  }

  return picked;
}
