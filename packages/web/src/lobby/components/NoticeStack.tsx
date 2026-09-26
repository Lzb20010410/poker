/**
 * 提示堆：服务端临时说给我听的话。
 *
 * ## 和 `StatusBanner` 的分工
 *
 * `StatusBanner` 说的是**连接**怎么样了（连不上、正在重连、连接已断开），
 * 那是同一条状态的当前值，只该有一条。这里说的是**一件件发生过的事**：
 * 服务端刚拒了我这一步、旧的重连凭证失效了、我用新身份重新入座了。
 * 后者是一条条流水，会累积、也会被单独关掉，所以是列表而不是横幅。
 *
 * ## role 的选择和横幅同一套理由
 *
 * - `error` → `role="alert"`：这类话几乎都是「你刚点的那下没生效」，
 *   玩家必须马上知道，不然他会以为动作已经打出去了。
 * - `info` → `role="status"`：温和播报，不打断读屏当前念的内容。
 *
 * 每条都得能单独关掉：断线重连一趟可能攒出三四条，全堆在屏幕上
 * 又关不掉，等于用「提示」堵住了牌桌。
 */

import type { ReactNode } from 'react';

import type { Notice } from '../../net/types';

export interface NoticeStackProps {
  readonly notices: readonly Notice[];
  readonly onDismiss: (id: number) => void;
}

export function NoticeStack({ notices, onDismiss }: NoticeStackProps): ReactNode {
  if (notices.length === 0) return null;

  return (
    <div className="notice-stack">
      {notices.map((notice) => (
        <div
          className={`notice notice--${notice.kind}`}
          key={notice.id}
          role={notice.kind === 'error' ? 'alert' : 'status'}
        >
          <span className="notice__text">{notice.message}</span>
          <button className="notice__close" type="button" aria-label="关掉这条提示" onClick={() => onDismiss(notice.id)}>
            关掉
          </button>
        </div>
      ))}
    </div>
  );
}
