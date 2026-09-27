/**
 * 牌桌座位环（M2.2 起坐在桌面上，M2.3 起座位上要有内容）。
 *
 * ## 槽位是**相对视角**的，不是服务端座位号
 *
 * SPEC §4.2 要「自己的座位永远固定在正下方中央」，所以这一圈格子按 `layout.seats`
 * 的 `offset` 排（0 = 我，顺时针递增），玩家由 `relativeOffset` 换算后落位。
 * 服务端给的 `seatIndex` 仍然是一切显示的根据——庄 / 小盲 / 大盲、本手冻结身份、
 * `入座 N 号座位` 的标签，用的都是它，前端只是决定这个人在屏幕的哪一格。
 *
 * ## 空座位也要占一格
 *
 * 房主要看得见「还差几个人」，玩家要看得见自己能坐到哪。格子数由
 * `layout.seats.length`（= `config.maxPlayers`）决定，不是由「有几个人」决定。
 * 但**格子里的话只说一遍**：紧凑档里能入座时，「入座」按钮就是"这个位子空着"的说法，
 * 再叠一句「空座位」会把筹码那行顶出框（判据见下面 `canSit`）。
 *
 * ## 坐标只有一个来源
 *
 * `left/top/width/height` 全部来自 `layout.ts`，这里不加任何微调。
 * 「无重叠、无溢出」是在那边机器验算过的，一旦这里再 `+4px`，那份验证就作废了。
 *
 * ## 一格能塞下的东西就这么多（M2.3，紧凑档在 D-029 重排）
 *
 * `layout.ts` 解到坐满 8 人的竖屏手机上，一格里式档是 180×132、紧凑档是 104×44。
 * 全尺寸档排得下头像、昵称、筹码、两枚 20px 底牌与一整条徽章；紧凑档排不下那一套，
 * 于是它**换一套内容**而不是"同样东西缩小"：
 * 头像 22px、昵称与筹码各占一行（11px）、别人那两枚底牌缩成 9×13 的微型牌背仍然要画，
 * 角标只留 `core` 那几枚（判据见 `SeatBadge`）。昵称超 8 个码点先由 `displayNickname`
 * 省略，再由 CSS 的省略号按实际宽度收第二道，全名留在 `title` 里；所有金额走
 * `formatChips`，千分位的逗号不能省——牌桌上 `1234567` 和 `1,234,567` 是两种读法。
 * 筹码数变化的时候数字滚动而不是跳，那是 `ChipCount` 的事。
 *
 * 为什么微型牌背非留不可：他报回来的原话是「个人信息(筹码，手牌等信息)看不全」，
 * 而"这人手上有没有牌"是牌桌上最要紧的一件事，不能因为格子小就没掉。
 * 花色在 9px 上确实读不出，所以摊牌时（`reveals`）给的仍是正面。
 *
 * 弃牌是**压暗 + 一枚「已弃牌」文字徽章**，两件事都要：压暗对色弱玩家和读屏
 * 都不成立。紧凑档里它写成单字「弃」（全称在 `title` 与 `aria-label`），压暗不改座位
 * 尺寸——牌桌的几何是按「八个人都坐满」验算的，弃牌不该让位子缩掉一格。
 *
 * ## 这里显示的一切状态都来自服务端
 *
 * 庄家 / 小盲 / 大盲标记、当前轮到谁、谁已弃牌 / 全下 / 离线，
 * 全部读 `RoomSnapshot` 里服务端算好的字段。前端一个都不自己推。
 *
 * 筹码数来自 `players`（账户的当前余额），本手已投入来自 `handPlayers`
 * （这一手开始时冻结的身份）。两者是分开的两份数据，因为一个人可以
 * 中途离桌但这一手还在打（D-014）。
 */

import type { Card } from '@poker-room/shared/view';
import type { CSSProperties, ReactNode } from 'react';

import { AvatarPreview } from '../../lobby/components/AvatarPreview';
import type { ConnectedPlayer, HandPlayerView, RoomSnapshot } from '../../net/types';
import { displayNickname, formatChips } from '../format';
import { relativeOffset, type SeatSlot, type TableLayout } from '../layout';
import type { SeatEmote } from '../useSeatEmotes';
import { CardView, cardText } from './CardView';
import { ChipCount } from './ChipCount';
import { TurnRing } from './TurnRing';

export interface SeatListProps {
  readonly snapshot: RoomSnapshot;
  /** 桌面几何。座位框的坐标完全由它给出 */
  readonly layout: TableLayout;
  /**
   * 此刻要冒出来的表情气泡，按服务端座位号挂在格子上。
   * 它是**状态**不是排队的动画（`useSeatEmotes` 自己到点抹掉），所以不走 `data-anim`。
   */
  readonly seatEmotes: readonly SeatEmote[];
  /** 断线期间为 true：座位上的三个按钮一律不亮 */
  readonly disabled: boolean;
  readonly onSit: (seatIndex: number) => void;
  readonly onStand: () => void;
  readonly onRebuy: () => void;
}

/**
 * 座位身上的一枚角标。
 *
 * `core` 是**紧凑档留不留这枚**的判据，不是"重要不重要"的自评：104×44 的框里角标那一列
 * 每多一枚，昵称与筹码就少一截（那是他报的第 2 条）。所以只留「这一格里没有第二处可看」
 * 的那些——位置（D/SB/BB）与人的状态（弃 / 全下 / 旁观 / 断线）。
 * 剩下的都有自己的说法：行动中是整格的金框（`.seat--acting`），「你」是 `.seat--self`
 * 的边加固定在正下方那一格（SPEC §4.2），房主在房主面板里、已投在底池那一行里读得到。
 *
 * `compactText` 只有一处：「已弃牌」在紧凑档换成「弃」。一个汉字 11px，三个字 33px，
 * 那一列给不起。全称同时进 `title` 与 `aria-label`，读屏和悬停都还是完整的。
 */
interface SeatBadge {
  readonly key: string;
  readonly text: string;
  readonly compactText?: string;
  readonly tone?: 'acting' | 'warn' | 'self';
  readonly core: boolean;
}

/**
 * 座位上的徽章。只有服务端说了才算，前端不自己判断「这人是不是全下」。
 *
 * 字母角标按 SPEC §4.3 的 `D / SB / BB / ALL-IN`：一格座位在竖屏满桌时只有几十像素宽，
 * 「小盲」两个字的高度就把头像挤没了。弃牌继续留一条中文徽标，是因为「变暗」这个信号
 * 对色弱玩家和读屏都不成立（见下面 `seat--folded` 的注释）。
 */
function badgesFor(args: {
  readonly hand: HandPlayerView | undefined;
  readonly presence: ConnectedPlayer['presence'];
  readonly isDealer: boolean;
  readonly isSB: boolean;
  readonly isBB: boolean;
  readonly isActing: boolean;
  readonly committed: number;
  readonly isHost: boolean;
  readonly isMine: boolean;
}): readonly SeatBadge[] {
  const { hand, presence } = args;
  const badges: SeatBadge[] = [];
  if (args.isDealer) badges.push({ key: 'D', text: 'D', core: true });
  if (args.isSB) badges.push({ key: 'SB', text: 'SB', core: true });
  if (args.isBB) badges.push({ key: 'BB', text: 'BB', core: true });
  if (args.isActing) badges.push({ key: 'acting', text: '行动中', tone: 'acting', core: false });
  if (args.committed > 0) {
    badges.push({ key: 'committed', text: `已投 ${formatChips(args.committed)}`, core: false });
  }
  if (hand?.folded === true) {
    badges.push({ key: 'folded', text: '已弃牌', compactText: '弃', core: true });
  }
  if (hand?.allIn === true) badges.push({ key: 'allin', text: 'ALL-IN', core: true });
  if (hand?.sittingOut === true) badges.push({ key: 'sitting-out', text: '旁观', core: true });
  if (presence !== 'online') {
    badges.push({
      key: 'presence',
      text: presence === 'left' ? '已离桌' : '断线',
      tone: 'warn',
      core: true,
    });
  }
  if (args.isHost) badges.push({ key: 'host', text: '房主', core: false });
  if (args.isMine) badges.push({ key: 'self', text: '你', tone: 'self', core: false });
  return badges;
}

/** 这一格该显示的两张底牌：摊牌亮出来的正面 > 还在牌里的两张背面（`null`）> 什么都没有 */
function holeCardsOf(
  snapshot: RoomSnapshot,
  player: ConnectedPlayer,
  hand: HandPlayerView | undefined,
): readonly (Card | null)[] | null {
  const revealed = snapshot.reveals.find((row) => row.playerId === player.id);
  if (revealed !== undefined) return revealed.cards;
  // 「还在牌里」读的是服务端的冻结身份，前端不推：弃牌的人牌已经进弃牌堆了
  if (hand === undefined || hand.folded || hand.sittingOut) return null;
  return [null, null];
}

function slotStyle(slot: SeatSlot): CSSProperties {
  return { left: slot.x, top: slot.y, width: slot.w, height: slot.h };
}

export function SeatList({
  snapshot,
  layout,
  seatEmotes,
  disabled,
  onSit,
  onStand,
  onRebuy,
}: SeatListProps): ReactNode {
  const capacity = layout.seats.length;
  const mySeat = snapshot.mySeat;
  /** 本手结束后才允许重买，和服务端 `rebuyPlayer` 的前置条件一致 */
  const canRebuyNow = snapshot.phase === 'IDLE' || snapshot.phase === 'HAND_END';
  /** 我还没坐下（或在旁观）时，每个空格子上才亮「入座」 */
  const canSit = !disabled && mySeat === null;

  /** 槽位号 → 服务端座位号，即 `relativeOffset` 的逆运算。旁观时（`mySeat` 为 null）两者重合 */
  const seatIndexOf = (offset: number): number => {
    const base = mySeat ?? 0;
    return (((base + offset) % capacity) + capacity) % capacity;
  };
  const seatNumber = (index: number): string => `${index + 1} 号座位`;

  return (
    <ul className="seats seats--ring">
      {layout.seats.map((slot) => {
        const player: ConnectedPlayer | undefined = snapshot.players.find(
          (row) => row.seatIndex !== null && relativeOffset(row.seatIndex, mySeat, capacity) === slot.offset,
        );
        const seatIndex = player?.seatIndex ?? seatIndexOf(slot.offset);
        // 座位号会中途换人：上一位本手弃牌后离桌，服务端立刻把这个位子发给新来的人，
        // 而 `handPlayers` 里那一格的冻结身份仍然是他。只按座位合并就会把「已弃牌」贴到
        // 刚坐下的人身上，所以两处必须指向同一个人。
        const hand =
          player === undefined
            ? undefined
            : snapshot.handPlayers.find((row) => row.seatIndex === seatIndex && row.playerId === player.id);
        const isMine = player?.isSelf === true;
        const isDealer = snapshot.dealerSeat === seatIndex;
        const isActing = snapshot.currentTurn === seatIndex;
        const isFolded = hand?.folded === true;
        const seatLabel = seatNumber(seatIndex);
        // 我自己的两张底牌不在这一格里画：SPEC §4.2 要它在竖屏放大到屏宽 22%，
        // 而座位框在那个密度下只有几十像素。它归 `TablePage` 底部那条 `.hole-strip`。
        const holes = player === undefined || isMine ? null : holeCardsOf(snapshot, player, hand);
        const emote = seatEmotes.find((row) => row.seatIndex === seatIndex);
        const badges = badgesFor({
          hand,
          presence: player?.presence ?? 'online',
          isDealer,
          isSB: snapshot.sbSeat === seatIndex,
          isBB: snapshot.bbSeat === seatIndex,
          isActing,
          committed: hand?.committedThisStreet ?? 0,
          isHost: player?.isHost === true,
          isMine,
        });
        // 紧凑档只留 `core` 那几枚：那一列的宽度是从昵称与筹码嘴里抢出来的
        const shownBadges = slot.compact ? badges.filter((badge) => badge.core) : badges;

        return (
          <li
            className={[
              'seat',
              player === undefined ? 'seat--empty' : '',
              isMine ? 'seat--self' : '',
              isActing ? 'seat--acting' : '',
              isDealer ? 'seat--dealer' : '',
              isFolded ? 'seat--folded' : '',
              slot.compact ? 'seat--compact' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            key={`seat-${slot.offset}`}
            data-anim={`seat-${seatIndex}`}
            style={slotStyle(slot)}
          >
            {player === undefined ? (
              <>
                <span className="seat__avatar seat__avatar--empty" aria-hidden="true" />
                {/* 紧凑档里按钮能亮起来时不再叠一句「空座位」：同一件事在这里说两遍，
                    44px 的框就把筹码那两行挤没了（他报的第 2 条）。完整座位号在按钮的
                    `aria-label` 上，读屏与悬停都还听得到「入座 N 号座位」。 */}
                {!(slot.compact && canSit) && <span className="seat__name seat__name--empty">空座位</span>}
                {canSit && (
                  <button
                    className="btn btn--ghost seat__action"
                    type="button"
                    aria-label={`入座 ${seatLabel}`}
                    onClick={() => onSit(seatIndex)}
                  >
                    入座
                  </button>
                )}
              </>
            ) : (
              <>
                {/* 环绝对套在头像外圈，所以需要一个有位置的盒子来当它的包含块。
                    环不能挂在整格上：`.seat` 的高度由昵称/筹码/角标共同决定，一圈 SVG
                    跟着内容高低走就成了装饰而不是计时器（SPEC §4.3 把它画在头像那一格）。 */}
                <span className="seat__avatar-box">
                  <AvatarPreview
                    className="seat__avatar"
                    seed={player.avatarSeed}
                    size={48}
                    label={`${player.nickname} 的头像`}
                  />
                  {isActing && (
                    <TurnRing
                      deadline={snapshot.deadline}
                      clockOffsetMs={snapshot.clockOffsetMs}
                      totalMs={snapshot.config.actionTimeoutSec * 1000}
                    />
                  )}
                </span>
                <span className="seat__name" title={player.nickname}>
                  {displayNickname(player.nickname)}
                </span>
                {/* key 挂在人身上：换座时不该看到上一个人的筹码滚到我头上。
                    我那一格不画（D-038）：余额搬到底牌区那一叠筹码旁边，同一数额留两处
                    读数反而对不上；窄屏那一格本来也把七位数裁掉了。 */}
                {!isMine && <ChipCount key={player.id} value={player.chips} />}
                {holes !== null && (
                  <span className="seat__hole" data-anim={`hole-${seatIndex}`}>
                    {holes.map((card, index) => (
                      <CardView
                        card={card}
                        faceDown={card === null}
                        key={card === null ? `back-${index}` : cardText(card)}
                      />
                    ))}
                  </span>
                )}
                <span className="seat__flags">
                  {shownBadges.map((badge) => {
                    const short = slot.compact ? badge.compactText : undefined;
                    return (
                      <span
                        className={badge.tone === undefined ? 'badge' : `badge badge--${badge.tone}`}
                        key={badge.key}
                        // 缩短过的那一枚把全称挂在 title 与 aria-label 上：眼睛看「弃」，
                        // 读屏与悬停读「已弃牌」，不因为格子小就把信息降级
                        title={short === undefined ? undefined : badge.text}
                        aria-label={short === undefined ? undefined : badge.text}
                      >
                        {short ?? badge.text}
                      </span>
                    );
                  })}
                </span>
                {isMine && !disabled && mySeat !== null && (
                  <button className="btn btn--ghost seat__action" type="button" onClick={onStand}>
                    离座
                  </button>
                )}
                {isMine && !disabled && player.chips === 0 && canRebuyNow && (
                  <button className="btn btn--primary seat__action" type="button" onClick={onRebuy}>
                    重买
                  </button>
                )}
                {/* 表情气泡是盖在整格上的一层，不排队、到点自己消失（`useSeatEmotes`）。
                    文字而不是图片：四个表情的意思是「无奈/大笑/生气/挥手」，
                    再画四张图要多一套资产，而这套资产在 104px 的格子里认不出来。 */}
                {emote !== undefined && <span className="seat__emote">{emote.label}</span>}
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}
