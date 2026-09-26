/**
 * 等待室里的玩家列表。
 *
 * M0.4 只需要显示「谁已经进来了」。M1 之后牌桌另有自己的座位视图（`table/SeatList`），
 * 这里继续服务大厅 / 等待室。传入的数组**已经按座位排好序**（`net/view.ts` 负责排序，
 * 旁观者排最后），所以组件只管渲染，不再自己按 id 排。
 */

import { DEFAULT_TABLE_CONFIG } from '@poker-room/shared/view';
import type { ReactNode } from 'react';

import type { ConnectedPlayer } from '../../net/types';
import { AvatarPreview } from './AvatarPreview';

export interface PlayerListProps {
  readonly players: readonly ConnectedPlayer[];
}

export function PlayerList({ players }: PlayerListProps): ReactNode {
  if (players.length === 0) {
    return <p className="empty">还没有人进来，把配对码发给朋友吧。</p>;
  }

  return (
    <ul className="player-list">
      {players.map((player) => (
        <li className="player-list__item" key={player.id}>
          <AvatarPreview seed={player.avatarSeed} size={48} label={`${player.nickname} 的头像`} />
          <span className="player-list__name">{player.nickname}</span>
          {player.isSelf && <span className="badge badge--self">你</span>}
        </li>
      ))}
      {/*
        空座位也画出来。看到「3/8」是个数字，看到 5 个虚线框是「还差几个人就能开局」，
        后者对房主的决策有用得多（要不要再拉人）。
      */}
      {Array.from({ length: DEFAULT_TABLE_CONFIG.maxPlayers - players.length }, (_, index) => (
        <li className="player-list__item player-list__item--empty" key={`empty-${index}`}>
          <span className="player-list__empty-slot" aria-hidden="true" />
          <span className="player-list__name player-list__name--empty">空座位</span>
        </li>
      ))}
    </ul>
  );
}

/** 人数计数，形如 `3/8`。单独抽出来是因为等待室和牌桌都要显示 */
export function PlayerCount({ count }: { count: number }): ReactNode {
  return (
    <span className="player-count">
      {count}/{DEFAULT_TABLE_CONFIG.maxPlayers}
    </span>
  );
}
