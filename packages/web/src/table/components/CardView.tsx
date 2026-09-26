/**
 * 一张牌（M2.1 的牌面资产上屏）。
 *
 * ## 为什么是 `<img>` 而不是内联 `<svg>`
 *
 * 牌面 SVG 内部带 `id`（渐变、裁切路径）。一屏同时出现 5 张公共牌 + 8 格座位的底牌，
 * 内联就会在同一个文档里塞进几十个同名 id，`url(#…)` 会全部指到第一份上。
 * 走 `data:` URI 的 `<img>` 每张是一个独立文档，天然隔离，代价只是不能拿 CSS 改牌面内部。
 * 这件事 M2.1 在 `/dev/assets` 上已经踩过一次，见 `assets/pokerTable.ts` 的 id 前缀。
 *
 * `cardText` 降级成**无障碍名字**（`alt`）与结算面板的文案来源：牌面本身不再靠文字。
 *
 * ## `null` 是空位，不是背面
 *
 * `null` 表示「公共牌还没发到这一张」，背面表示「有牌但不能看」。两者对玩家的含义
 * 完全不同，读屏文案也分开说，所以三态继续在这里收口，不让调用方各自拼。
 */

import { rankLabel, suitSymbol, type Card } from '@poker-room/shared/view';
import type { ReactNode } from 'react';

import { CARD_BACK_DATA_URI } from '../../assets/cardBack';
import { cardFaceDataUri } from '../../assets/cardFaces';

/** 牌面文字，例如 `A♠`、`10♥`。摊牌面板和座位上的亮牌都复用它 */
export function cardText(card: Card): string {
  return `${rankLabel(card.rank)}${suitSymbol(card.suit)}`;
}

export interface CardViewProps {
  readonly card: Card | null;
  /** 有牌但不该给人看：别人的底牌、以及 M3 发牌动画还没翻面的那一瞬 */
  readonly faceDown?: boolean;
  /** 组成牌型的那五张之一（M3.5 的描边）。只有正面牌才可能亮起来 */
  readonly best?: boolean;
}

export function CardView({ card, faceDown = false, best = false }: CardViewProps): ReactNode {
  if (faceDown) {
    return <img alt="扣着的牌" className="card-view card-view--back" src={CARD_BACK_DATA_URI} />;
  }
  if (card === null) {
    return (
      <span aria-label="还没发到这一张" className="card-view card-view--empty">
        <span aria-hidden="true" />
      </span>
    );
  }
  // 花色类名保持在第二位：动画那边靠 `card-view--([shdc])` 认「这张是正面」，
  // 描边类加在它后面不会被认成花色
  const className = `card-view card-view--${card.suit}${best ? ' card-view--best' : ''}`;
  return <img alt={cardText(card)} className={className} src={cardFaceDataUri(card)} />;
}

/** 一排牌。`count` 用来补空位（公共牌固定 5 个槽位）；`highlight` 是要描边的那几张的牌名 */
export function CardRow({
  cards,
  count,
  highlight,
}: {
  readonly cards: readonly Card[];
  readonly count?: number;
  readonly highlight?: ReadonlySet<string>;
}): ReactNode {
  const total = count === undefined ? cards.length : Math.max(count, cards.length);
  return (
    <span className="card-row">
      {Array.from({ length: total }, (_, index) => {
        const card = cards[index] ?? null;
        return (
          <CardView
            key={`card-${index}`}
            card={card}
            best={card !== null && highlight !== undefined && highlight.has(cardText(card))}
          />
        );
      })}
    </span>
  );
}
