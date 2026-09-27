/**
 * 页面外壳：页头 + 状态横幅 + 提示堆 + 内容。
 *
 * 三个页面（大厅 / 等待室 / 牌桌）共用，所以状态横幅和提示堆只在这里渲染一次——
 * 它们直接读 `useRoom()`，各页面不必把 status / failure / link / notices 再传一遍。
 *
 * 页头固定写着「朋友局 · 纯虚拟筹码」：这是 DECISIONS.md D-000 的定位声明，
 * 开源当作品集时 README 顶部也要有同一句话。放在每个页面都看得见的地方，
 * 比只写在 README 里更不容易被人误当成能真钱对赌的东西。
 *
 * 页头最右边是音效开关（M4.2）：三个页面都有，玩家进桌之前就能先试一声，
 * 不必为了静音跑回大厅。
 */

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { SoundToggle } from './sound/SoundToggle';
import { useRoom } from './state/RoomContext';
import { NoticeStack } from './lobby/components/NoticeStack';
import { StatusBanner } from './lobby/components/StatusBanner';

export interface AppShellProps {
  readonly children: ReactNode;
}

export function AppShell({ children }: AppShellProps): ReactNode {
  const { status, failure, link, notices, dismissFailure, dismissNotice } = useRoom();

  return (
    <div className="app">
      <header className="app__header">
        <Link className="app__brand" to="/">
          私局德州
        </Link>
        <span className="app__tagline">朋友局 · 纯虚拟筹码 · 不涉及任何真实价值交换</span>
        <SoundToggle />
      </header>

      <main className="app__main">
        <StatusBanner status={status} failure={failure} link={link} onDismissFailure={dismissFailure} />
        <NoticeStack notices={notices} onDismiss={dismissNotice} />
        {children}
      </main>
    </div>
  );
}
