/**
 * 房间等待室（路由 `/r/:code`）。
 *
 * 这个页面有两种进入方式，行为必须一致：
 * 1. 在大厅点「创建房间」/「加入房间」后被 `navigate` 过来 —— 连接已经建好了，
 *    `RoomContext` 里 `snapshot.code === code`，effect 里的 `joinRoom` 会立刻返回 true，不重连。
 * 2. 直接打开分享链接 `/r/K7QM3D` —— 还没连接，effect 触发 `joinRoom`，
 *    用的是 `ProfileProvider` 里那套（首次访问自动生成的）身份。
 *
 * 第 2 种是「朋友点开微信里的链接就能进房」的关键路径，也是 StrictMode 下
 * effect 会被打两遍的那条路径，防重复连接靠 `RoomContext` 的 `pendingKeyRef`。
 */

import { isValidPairingCode, normalizePairingCode } from '@poker-room/shared';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { useProfile } from '../state/ProfileContext';
import { useRoom } from '../state/RoomContext';
import { PlayerCount, PlayerList } from './components/PlayerList';

/** 「已复制」提示的停留时长。太短看不见，长了挡住按钮 */
const COPIED_HINT_MS = 2_000;

export function WaitingRoomPage(): ReactNode {
  const params = useParams();
  const { profile } = useProfile();
  const { status, snapshot, joinRoom, leaveRoom } = useRoom();
  const navigate = useNavigate();

  const code = normalizePairingCode(params['code'] ?? '');
  const codeIsValid = isValidPairingCode(code);

  const [copied, setCopied] = useState(false);
  const shareInputRef = useRef<HTMLInputElement>(null);
  const copiedTimerRef = useRef<number | null>(null);

  // 自动进房。依赖里放 joinRoom（useCallback 稳定引用）而不是整个 room 对象，
  // 否则每次状态变化都会重跑这个 effect。
  useEffect(() => {
    if (!codeIsValid) return;
    void joinRoom(code, profile);
  }, [codeIsValid, code, profile, joinRoom]);

  // 卸载时清掉「已复制」的定时器，避免在已卸载的组件上 setState
  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    },
    [],
  );

  if (!codeIsValid) {
    return (
      <section className="card card--accent">
        <h2 className="card__title">这个链接里的配对码不对</h2>
        <p className="card__subtitle">
          配对码是 6 位，只用不含 I O 0 1 的大写字母和数字。收到的是「{params['code'] ?? '（空）'}」。
        </p>
        <Link className="btn btn--primary" to="/">
          回大厅重新输入
        </Link>
      </section>
    );
  }

  const shareUrl = `${window.location.origin}/r/${code}`;
  const players = snapshot?.players ?? [];
  const connected = status === 'connected' && snapshot?.code === code;

  const onCopy = (): void => {
    void (async () => {
      try {
        // 非安全上下文（http://<局域网 IP>）下 `navigator.clipboard` 是 undefined，
        // 这里会抛 TypeError，被下面接住。手机同局域网访问是本项目的主要场景之一，
        // 所以必须有退化路径，不能让「复制」变成唯一能拿到链接的方式。
        await navigator.clipboard.writeText(shareUrl);
        setCopied(true);
        if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = window.setTimeout(() => {
          setCopied(false);
        }, COPIED_HINT_MS);
      } catch {
        shareInputRef.current?.select();
      }
    })();
  };

  const onLeave = (): void => {
    void (async () => {
      await leaveRoom();
      void navigate('/');
    })();
  };

  return (
    <div className="waiting">
      <section className="card card--accent">
        <h2 className="card__title">配对码</h2>
        <p className="join-code">{code}</p>
        <p className="card__subtitle">把下面这个链接发给朋友，点开就能进这一桌。</p>

        <div className="share">
          <input ref={shareInputRef} className="share__input" type="text" readOnly value={shareUrl} />
          <button className="btn btn--ghost" type="button" onClick={onCopy}>
            {copied ? '已复制' : '复制'}
          </button>
        </div>
      </section>

      <section className="card">
        <div className="card__heading">
          <h2 className="card__title">已进来的人</h2>
          <PlayerCount count={players.length} />
        </div>
        {connected ? (
          <PlayerList players={players} />
        ) : (
          <p className="empty">
            {status === 'connecting' ? '正在进入房间…' : '还没连上这一桌。'}
          </p>
        )}
      </section>

      <section className="card">
        <div className="btn-row">
          {/*
            没连上时渲染 disabled 的 <button> 而不是 `to="#"` 的 <Link>：
            一个指向 `#` 的链接对键盘和读屏用户是「可点但点了没反应」，
            而 disabled 按钮是明确的「现在不行」。
          */}
          {connected ? (
            <Link className="btn btn--primary" to={`/t/${code}`}>
              进入牌桌
            </Link>
          ) : (
            <button className="btn btn--primary" type="button" disabled>
              进入牌桌
            </button>
          )}
          <button className="btn btn--ghost" type="button" onClick={onLeave}>
            离开房间
          </button>
        </div>
        <p className="card__subtitle">牌桌要等规则引擎（M1）做完才能真正开局，现在只是一个等待视图。</p>
      </section>
    </div>
  );
}
