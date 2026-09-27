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
 * `SoundProvider` 在两者之间：它谁都不依赖（只依赖 localStorage 和浏览器的手势），
 * 但 `AppShell` 里的音效开关要用它，所以必须在 shell 外面。放 `RoomProvider` 外侧
 * 而不是内侧，是为了让「切页面 / 换房间」都不重挂它——音效的手势状态和静音档
 * 是整个应用一份，不跟着连接走。
 *
 * ## 路由
 *
 * | 路径 | 页面 | 说明 |
 * |---|---|---|
 * | `/` | 大厅 | 改身份 / 开一桌 / 输码进桌 |
 * | `/r/:code` | 等待室 | 配对码 + 分享链接 + 已进来的人 |
 * | `/t/:code` | 牌桌 | M1.6 接入真正的牌局 |
 * | `/dev/assets` | 资产总览 | M2.1 的目视验收页，玩家不会走这儿 |
 * | `/dev/table` | 牌桌布局总览 | M2.2 的目视验收页，同上 |
 * | `/dev/replay` | 状态回放器 | M3.2 的动画调试台，喂硬编码事件序列，不连服务端 |
 *
 * 兜底路由重定向到 `/`：配对码是 6 位字符，手打错一位就会落到一个不存在的路径上，
 * 给个 404 页面不如直接把玩家送回大厅。
 */

import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from './AppShell';
import { ErrorBoundary } from './ErrorBoundary';
import { DevAssetsPage } from './dev/DevAssetsPage';
import { DevReplayPage } from './dev/DevReplayPage';
import { DevTablePage } from './dev/DevTablePage';
import { LobbyPage } from './lobby/LobbyPage';
import { WaitingRoomPage } from './lobby/WaitingRoomPage';
import { ProfileProvider } from './state/ProfileContext';
import { RoomProvider } from './state/RoomContext';
import { SoundProvider } from './state/SoundContext';
import { TablePage } from './table/TablePage';

/**
 * 路由表。单独抽出来只为了一件事：测试能在不挂 Provider、不连服务端的情况下
 * 断言「`/dev/assets` 命中的是资产页，而不是被 `*` 兜底送回大厅」。
 * 直接 render `<App />` 的话，`RoomProvider` 会去要一个真 client。
 */
export function AppRoutes(): ReactNode {
  return (
    <Routes>
      <Route path="/" element={<LobbyPage />} />
      <Route path="/r/:code" element={<WaitingRoomPage />} />
      <Route path="/t/:code" element={<TablePage />} />
      {/* 静态段比 `*` 优先级高，放在它前面只是为了读起来顺，不是靠顺序取胜 */}
      <Route path="/dev/assets" element={<DevAssetsPage />} />
      <Route path="/dev/table" element={<DevTablePage />} />
      <Route path="/dev/replay" element={<DevReplayPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function App(): ReactNode {
  return (
    <ErrorBoundary>
      <ProfileProvider>
        <SoundProvider>
          <RoomProvider>
            <BrowserRouter>
              <AppShell>
                <AppRoutes />
              </AppShell>
            </BrowserRouter>
          </RoomProvider>
        </SoundProvider>
      </ProfileProvider>
    </ErrorBoundary>
  );
}
