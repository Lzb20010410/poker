/**
 * 桌面（M2.2）：一张椭圆桌 + 一圈座位 + 公共牌 / 底池 / 牌堆。
 *
 * ## 为什么尺寸与坐标分两处算
 *
 * 盒子多大由 CSS 说了算（`aspect-ratio` + `max-height`，窄屏另有断点），
 * 组件只**量**它，不反过来用内联样式撑它。量到的尺寸喂给 `layoutTable()`，
 * 于是「桌面在屏幕上占多大」和「桌面里每格在哪」是两个互不干涉的决定。
 * 反过来说：这里所有 `left/top/width/height` 都是几何的输出，不是输入。
 *
 * ## 桌面图为什么按标准尺寸生成、再用 CSS 拉伸
 *
 * `pokerTable.ts` 里描金边、噪点、logo 的尺寸都是视口单位的比例值，而
 * `layout.felt` 的长宽比恒等于 `FELT_ASPECT` 的那两个数（横屏 2:1、竖屏 1.7:1，
 * 后者是 D-029 从 SPEC §4.2 的 1.3 改的；见 `tableLayout.test.ts` 里那条长宽比用例）。
 * 既然比例一致，等比拉伸与重画一张
 * 完全等价，却能避免「拖动窗口时每像素都重新生成一份 data URI」——
 * 那个缓存会随窗口尺寸无限膨胀。
 *
 * ## 覆盖层为什么要 `pointer-events: none`
 *
 * 公共牌 / 底池 / 牌堆三块都是 `inset: 0` 的绝对定位容器，不关掉指针事件就会
 * 整片盖在座位上，手机上「入座」按钮点着的全是牌。座位环反过来要开回来。
 */

import type { CSSProperties, ReactNode } from 'react';

import { CARD_BACK_DATA_URI } from '../../assets/cardBack';
import { tableFeltDataUri } from '../../assets/pokerTable';
import type { RoomSnapshot } from '../../net/types';
import { formatChips } from '../format';
import { FELT_ASPECT, layoutTable } from '../layout';
import type { SeatEmote } from '../useSeatEmotes';
import { useStageSize } from '../useStageSize';
import { CardView } from './CardView';
import { SeatList } from './SeatList';

/** 桌面 SVG 的标准宽度。真实渲染时被等比拉伸到 `layout.felt.w` */
const FELT_CANVAS_WIDTH = 1000;

function boxStyle(box: { x: number; y: number; w: number; h: number }): CSSProperties {
  return { left: box.x, top: box.y, width: box.w, height: box.h };
}

export interface TableStageProps {
  readonly snapshot: RoomSnapshot;
  readonly disabled: boolean;
  readonly seatEmotes: readonly SeatEmote[];
  readonly onSit: (seatIndex: number) => void;
  readonly onStand: () => void;
  readonly onRebuy: () => void;
}

export function TableStage({ snapshot, disabled, seatEmotes, onSit, onStand, onRebuy }: TableStageProps): ReactNode {
  const { ref, size } = useStageSize();
  const layout = layoutTable({ ...size, capacity: snapshot.config.maxPlayers });
  const aspect = FELT_ASPECT[layout.orientation];

  const feltUri = tableFeltDataUri({
    felt: snapshot.config.felt,
    idPrefix: 'table-stage',
    width: FELT_CANVAS_WIDTH,
    height: Math.round(FELT_CANVAS_WIDTH / aspect),
  });

  return (
    <div className="felt-stage" ref={ref}>
      <img className="felt-stage__felt" src={feltUri} alt="牌桌桌面" style={boxStyle(layout.felt)} />

      {/* 挤到连一块牌背都放不下时几何给 null：压在座位上比没有牌堆更糟 */}
      {layout.deck !== null && (
        <div className="felt-stage__deck" data-anim="deck" style={boxStyle(layout.deck)}>
          <img src={CARD_BACK_DATA_URI} alt="" aria-hidden="true" />
        </div>
      )}

      <div className="felt-stage__board" role="region" aria-label="公共牌">
        {layout.board.map((slot, index) => (
          <span className="felt-stage__slot" data-anim={`board-${index}`} key={`board-${index}`} style={boxStyle(slot)}>
            <CardView card={snapshot.board[index] ?? null} />
          </span>
        ))}
      </div>

      <p
        className={`felt-stage__pot${layout.potTight ? ' felt-stage__pot--tight' : ''}`}
        data-anim="pot"
        style={boxStyle(layout.pot)}
      >
        <span className="felt-stage__pot-label">底池</span>
        <span className="felt-stage__pot-amount">{formatChips(snapshot.potTotal)}</span>
      </p>

      <SeatList
        snapshot={snapshot}
        layout={layout}
        seatEmotes={seatEmotes}
        disabled={disabled}
        onSit={onSit}
        onStand={onStand}
        onRebuy={onRebuy}
      />
    </div>
  );
}
