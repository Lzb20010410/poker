/**
 * 摊牌与结算面板。
 *
 * 三块信息全都是从服务端来的，前端不做任何判定：
 * - `reveals`：定向 `showdown:reveal` 消息攒下来的亮牌，绑定的是**冻结身份**
 *   （`playerId`），所以中途换座、离桌都不会让「谁亮了什么」串到人身上；
 * - `awards`：`pot:awarded` 事件，一个池一条，写明赢家座位、金额和牌型；
 * - `results`：schema 里本手结束后的每人筹码与变动。
 *
 * 赢家座位要变成名字：座位号是给机器看的，玩家要看的是「老王拿走 300」。
 * 名字**只**从 `handPlayers`（这一手的冻结身份）取；查不到就写「N 号座位」。
 * 不退回 `players`（当前在册的人），因为座位会被回收再发给新玩家，
 * 拿当前住户顶替冻结身份等于把这一手的派彩记错人。
 *
 * 没有这三块内容时整个面板不渲染——牌局刚开始就挂一个空的「摊牌」区，
 * 比不挂更容易让人以为已经开过一局了。
 */

import type { ReactNode } from 'react';

import type { AwardView, RevealView, ResultView, RoomSnapshot } from '../../net/types';
import { formatChips } from '../format';
import { bestFiveKeys } from '../showdownHand';
import { CardRow } from './CardView';

export interface ShowdownPanelProps {
  readonly snapshot: RoomSnapshot;
}

function nameOfSeat(snapshot: RoomSnapshot, seat: number): string {
  // 只认这一手的冻结身份。派彩事件带的是座位号，而座位号会换人（上一位离桌后位子立刻回收），
  // 因此"查不到冻结身份时退回当前在册玩家"是不安全的：那等于把这一手的钱记给现在坐在这儿的
  // 人。报不出名字就报座位号，宁可含糊也不能点错人。
  const frozen = snapshot.handPlayers.find((player) => player.seatIndex === seat);
  return frozen?.nickname ?? `${seat + 1} 号座位`;
}

function nameOfPlayer(snapshot: RoomSnapshot, playerId: string): string {
  const frozen = snapshot.handPlayers.find((player) => player.playerId === playerId);
  if (frozen !== undefined) return frozen.nickname;
  const seated = snapshot.players.find((player) => player.id === playerId);
  return seated?.nickname ?? '某位玩家';
}

export function ShowdownPanel({ snapshot }: ShowdownPanelProps): ReactNode {
  const { reveals, awards, results } = snapshot;
  if (reveals.length === 0 && awards.length === 0 && results.length === 0) return null;

  return (
    <section className="card card--wide" role="region" aria-label="摊牌与结算">
      <h3 className="card__title">摊牌与结算</h3>

      {reveals.length > 0 && (
        <ul className="reveal-list">
          {reveals.map((reveal: RevealView) => (
            <li className="reveal-list__item" key={reveal.playerId}>
              <span className="reveal-list__name">{nameOfPlayer(snapshot, reveal.playerId)}</span>
              <span className="reveal-list__cards">
                <CardRow cards={reveal.cards} />
              </span>
            </li>
          ))}
        </ul>
      )}

      {awards.length > 0 && (
        <ul className="award-list">
          {awards.map((award: AwardView, index) => (
            <li className="award-list__item" key={`award-${award.potIndex}-${index}`}>
              <span className="award-list__pot">{award.potIndex === 0 ? '主池' : `边池 ${award.potIndex}`}</span>
              <span className="award-list__amount">{formatChips(award.amount)}</span>
              <span className="award-list__winners">
                {award.winners.map((seat) => nameOfSeat(snapshot, seat)).join('、')}
              </span>
              <span className="award-list__hand">{award.handName}</span>
              {/*
                * 赢家那一排摆的是**他的七张**（两枚亮出的底牌 + 五张公共牌），再把其中
                * 组成牌型的五张描出来（M3.5）。只画那五张的话「高亮」就无从谈起，
                * 「含公共牌」也无从检查。
                *
                * 平分底池时一个赢家一排：`award.bestFive` 只有 `winners[0]` 那一份，
                * 按点数补齐的那一轮在 `bestFiveKeys` 里，见那个文件的头。
                *
                * 查不到这个座位的亮牌就退回只画五张——那是「没翻开的牌」，不是「少两张」。
                * 单人获胜（别人全弃牌）时 `bestFive` 是空的，整排不画：那手牌根本没翻开。
                */}
              {award.bestFive.length > 0 &&
                award.winners.map((seat) => {
                  const reveal = reveals.find((row) => row.seatIndex === seat);
                  const seven = reveal === undefined ? [...award.bestFive] : [...reveal.cards, ...snapshot.board];
                  return (
                    <span className="award-list__hand-row" key={`award-${award.potIndex}-hand-${seat}`}>
                      <CardRow cards={seven} highlight={bestFiveKeys(seven, award.bestFive)} />
                    </span>
                  );
                })}
            </li>
          ))}
        </ul>
      )}

      {results.length > 0 && (
        <ul className="result-list">
          {results.map((result: ResultView) => (
            <li className="result-list__item" key={result.playerId}>
              <span className="result-list__name">{nameOfPlayer(snapshot, result.playerId)}</span>
              <span className={`result-list__delta ${result.delta >= 0 ? 'result-list__delta--up' : 'result-list__delta--down'}`}>
                {result.delta >= 0 ? `+${formatChips(result.delta)}` : formatChips(result.delta)}
              </span>
              <span className="result-list__chips">{formatChips(result.chips)}</span>
              {result.handName !== '' && <span className="result-list__hand">{result.handName}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
