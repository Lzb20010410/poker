/**
 * 页面外壳：页头 + 状态横幅 + 内容。
 *
 * 三个页面（大厅 / 等待室 / 牌桌）共用，所以状态横幅只在这里渲染一次——
 * 它直接读 `useRoom()`，各页面不必把 status / failure / link 再传一遍。
 *
 * 页头固定写着「朋友局 · 纯虚拟筹码」：这是 DECISIONS.md D-000 的定位声明，
 * 开源当作品集时 README 顶部也要有同一句话。放在每个页面都看得见的地方，
 * 比只写在 README 里更不容易被人误当成能真钱对赌的东西。
 */

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { useRoom } from './state/RoomContext';
import { StatusBanner } from './lobby/components/StatusBanner';

export interface AppShellProps {
  readonly children: ReactNode;
}

export function AppShell({ children }: AppShellProps): ReactNode {
  const { status, failure, link, dismissFailure } = useRoom();

  return (
    <div className="app">
      <header className="app__header">
        <Link className="app__brand" to="/">
          私局德州
        </Link>
        <span className="app__tagline">朋友局 · 纯虚拟筹码 · 不涉及任何真实价值交换</span>
      </header>

      <main className="app__main">
        <StatusBanner status={status} failure={failure} link={link} onDismissFailure={dismissFailure} />
        {children}
      </main>
    </div>
  );
}
