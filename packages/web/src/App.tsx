/**
 * 应用根组件：Provider 层 + 路由表。
 *
 * ## Provider 的顺序是有讲究的
 *
 * `ErrorBoundary` 在最外层：它要能接住下面任何一层的渲染错误，
 * 包括 Provider 自己出错（比如 `useProfile` 在 Provider 外面被调用时抛的那个错）。
 *
 * `RoomProvider` 在 `BrowserRouter` **外面**：连接的寿命应该跟整个应用一样长，
 * 而不是跟某个路由一样长。放里面的话每次切路由都会重新挂载 Provider，
 * 玩家就会在自己的房间里反复进出（详见 RoomContext.tsx 顶部的说明）。
 *
 * `ProfileProvider` 在 `RoomProvider` 外面：进房要用到昵称和头像 seed。
 *
 * ## 路由
 *
 * | 路径 | 页面 | 说明 |
 * |---|---|---|
 * | `/` | 大厅 | 改身份 / 开一桌 / 输码进桌 |
 * | `/r/:code` | 等待室 | 配对码 + 分享链接 + 已进来的人 |
 * | `/t/:code` | 牌桌 | M0.4 只显示成员，M1.6 接入真正的牌局 |
 *
 * 兜底路由重定向到 `/`：配对码是 6 位字符，手打错一位就会落到一个不存在的路径上，
 * 给个 404 页面不如直接把玩家送回大厅。
 */

import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from './AppShell';
import { ErrorBoundary } from './ErrorBoundary';
import { LobbyPage } from './lobby/LobbyPage';
import { WaitingRoomPage } from './lobby/WaitingRoomPage';
import { ProfileProvider } from './state/ProfileContext';
import { RoomProvider } from './state/RoomContext';
import { TablePage } from './table/TablePage';

export function App(): ReactNode {
  return (
    <ErrorBoundary>
      <ProfileProvider>
        <RoomProvider>
          <BrowserRouter>
            <AppShell>
              <Routes>
                <Route path="/" element={<LobbyPage />} />
                <Route path="/r/:code" element={<WaitingRoomPage />} />
                <Route path="/t/:code" element={<TablePage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </AppShell>
          </BrowserRouter>
        </RoomProvider>
      </ProfileProvider>
    </ErrorBoundary>
  );
}
