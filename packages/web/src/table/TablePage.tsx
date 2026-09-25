/**
 * 牌桌（路由 `/t/:code`）。
 *
 * M0.4 阶段这里只有「谁在这一桌」，真正的发牌 / 下注 / 动画在 M1.6 才接上。
 * 但路由现在就要存在，原因有两个：
 *
 * 1. 等待室的「进入牌桌」按钮要有一个能去的地方，否则那个按钮在 M0.4 就得
 *    做成假的，而假按钮是最容易忘了拆的东西。
 * 2. 刷新 `/t/:code` 要能直接回到这一桌。这条路径依赖的是自动进房 effect，
 *    和 `/r/:code` 完全一样——现在把它跑通，M1.6 就不用再动连接层。
 */

import { isValidPairingCode, normalizePairingCode } from '@poker-room/shared';
import { useEffect, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';

import { useProfile } from '../state/ProfileContext';
import { useRoom } from '../state/RoomContext';
import { PlayerCount, PlayerList } from '../lobby/components/PlayerList';

export function TablePage(): ReactNode {
  const params = useParams();
  const { profile } = useProfile();
  const { status, snapshot, joinRoom } = useRoom();

  const code = normalizePairingCode(params['code'] ?? '');
  const codeIsValid = isValidPairingCode(code);

  useEffect(() => {
    if (!codeIsValid) return;
    void joinRoom(code, profile);
  }, [codeIsValid, code, profile, joinRoom]);

  if (!codeIsValid) {
    return (
      <section className="card card--accent">
        <h2 className="card__title">这个链接里的配对码不对</h2>
        <Link className="btn btn--primary" to="/">
          回大厅重新输入
        </Link>
      </section>
    );
  }

  const players = snapshot?.players ?? [];
  const connected = status === 'connected' && snapshot?.code === code;

  return (
    <div className="table-page">
      <section className="card">
        <div className="card__heading">
          <h2 className="card__title">牌桌 {code}</h2>
          <PlayerCount count={players.length} />
        </div>
        {connected ? (
          <PlayerList players={players} />
        ) : (
          <p className="empty">{status === 'connecting' ? '正在进入房间…' : '还没连上这一桌。'}</p>
        )}
      </section>

      <section className="card card--accent">
        <h2 className="card__title">牌局还没开始</h2>
        <p className="card__subtitle">
          发牌、下注、比牌这些要等规则引擎（M1）做完才会出现在这一页。
          现在这里能看到的是「谁在这一桌」，用于确认联机链路是通的。
        </p>
        <Link className="btn btn--ghost" to={`/r/${code}`}>
          回到等待室
        </Link>
      </section>
    </div>
  );
}
