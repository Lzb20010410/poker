/**
 * 大厅（路由 `/`）。
 *
 * 三件事：改自己的身份、开一桌、用配对码进别人的桌。
 *
 * ## 为什么进来就有昵称和头像
 *
 * `ProfileProvider` 在首次访问时就生成了一套默认身份并落盘。这不是偷懒，
 * 是为了让 `/r/配对码` 这种分享链接能**直接进房**——朋友在微信里点开链接，
 * 不该先被一个「请填写昵称」的表单拦住，进房之后再改名字也来得及。
 *
 * ## 按钮在 connecting 期间禁用
 *
 * 这是防重复连接的第一道闸（第二道在 `RoomContext` 的 `pendingKeyRef`）。
 * 手机网络慢的时候，「点了没反应」最容易被连点三次，而 Colyseus 那边
 * 三次 `create` 会开出三张桌子。
 */

import { isValidPairingCode } from '@poker-room/shared';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { useProfile } from '../state/ProfileContext';
import { useRoom } from '../state/RoomContext';
import { AvatarPreview } from './components/AvatarPreview';
import { CodeField } from './components/CodeField';
import { NicknameField } from './components/NicknameField';
import { PlayerCount } from './components/PlayerList';

export function LobbyPage(): ReactNode {
  const { profile, update, rerollAvatar } = useProfile();
  const { status, snapshot, createRoom, joinRoom, leaveRoom } = useRoom();
  const navigate = useNavigate();
  const [code, setCode] = useState('');

  const busy = status === 'connecting';
  const nicknameReady = profile.nickname.trim().length > 0;
  const inRoom = snapshot !== null;

  const onCreate = (): void => {
    void (async () => {
      const created = await createRoom(profile);
      // 失败时不导航：留在大厅，错误由 AppShell 里的 StatusBanner 说明
      if (created !== null) void navigate(`/r/${created}`);
    })();
  };

  const onJoin = (): void => {
    if (!isValidPairingCode(code)) return;
    void (async () => {
      const joined = await joinRoom(code, profile);
      if (joined) void navigate(`/r/${code}`);
    })();
  };

  return (
    <div className="lobby">
      <section className="card">
        <h2 className="card__title">你的身份</h2>
        <p className="card__subtitle">只存在这台设备的浏览器里，换设备就是另一个人。</p>

        <div className="identity">
          <div className="identity__avatar">
            <AvatarPreview seed={profile.avatarSeed} size={96} label="你的头像" />
            <button className="btn btn--ghost" type="button" onClick={rerollAvatar} disabled={busy}>
              换一个
            </button>
          </div>
          <div className="identity__fields">
            <NicknameField
              id="lobby-nickname"
              value={profile.nickname}
              onChange={(nickname) => {
                update({ nickname });
              }}
              disabled={busy}
            />
            {!nicknameReady && <p className="field__error">先给自己起个名字</p>}
          </div>
        </div>
      </section>

      {inRoom && (
        <section className="card card--accent">
          <h2 className="card__title">你已经在一桌里了</h2>
          <p className="card__subtitle">
            配对码 <strong className="code-inline">{snapshot.code}</strong> · <PlayerCount count={snapshot.players.length} />
          </p>
          <div className="btn-row">
            <button
              className="btn btn--primary"
              type="button"
              onClick={() => {
                void navigate(`/r/${snapshot.code}`);
              }}
            >
              回到等待室
            </button>
            <button
              className="btn btn--ghost"
              type="button"
              onClick={() => {
                void leaveRoom();
              }}
            >
              离开房间
            </button>
          </div>
        </section>
      )}

      <section className="card">
        <h2 className="card__title">开一桌</h2>
        <p className="card__subtitle">会生成一个 6 位配对码，发给朋友就能进来，最多 8 人。</p>
        <button className="btn btn--primary btn--block" type="button" onClick={onCreate} disabled={!readyToAct(busy, nicknameReady)}>
          {busy ? '正在创建…' : '创建房间'}
        </button>
      </section>

      <section className="card">
        <h2 className="card__title">加入一桌</h2>
        <CodeField id="lobby-code" value={code} onChange={setCode} onSubmit={onJoin} disabled={busy} />
        <button
          className="btn btn--primary btn--block"
          type="button"
          onClick={onJoin}
          disabled={!readyToAct(busy, nicknameReady) || !isValidPairingCode(code)}
        >
          加入房间
        </button>
      </section>
    </div>
  );
}

/**
 * 两个按钮共用的可用性判定。
 *
 * 抽成函数是因为「昵称空着就点不动」这条规则要同时管住创建和加入，
 * 写在两处 JSX 里迟早会只改一处。
 */
function readyToAct(busy: boolean, nicknameReady: boolean): boolean {
  return !busy && nicknameReady;
}
