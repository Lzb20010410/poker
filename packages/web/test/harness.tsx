/**
 * 测试渲染脚手架。
 *
 * Provider 的嵌套顺序和 `src/App.tsx` 里保持一致
 * （Profile → Sound → Room → Router → Shell），因为 `AppShell` 同时要读 `useRoom()`、
 * `useSound()` 和用 `<Link>`，顺序错了测试就会以「找不到 context」的方式失败，
 * 而那种失败看不出真正的原因。
 */

import { cleanup, render, type RenderResult } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';

import { AppShell } from '../src/AppShell';
import { clearAvatarCache } from '../src/avatar';
import type { GameClient } from '../src/net/types';
import type { SoundPlayer } from '../src/sound/player';
import { PROFILE_STORAGE_KEY, type StoredProfile } from '../src/state/profile';
import { ProfileProvider } from '../src/state/ProfileContext';
import { resetSharedClient, RoomProvider } from '../src/state/RoomContext';
import { SoundProvider } from '../src/state/SoundContext';

/** 固定身份。随机昵称会让断言变成正则匹配，不如直接钉死 */
export const TEST_PROFILE: StoredProfile = { nickname: '阿博', avatarSeed: 'FixedSeed01' };

export interface RenderOptions {
  /** 注入假 client。不传就用真的（会去连 localhost:2567，测试里别这么干） */
  readonly client?: GameClient;
  /**
   * 注入播放器。不传就自己建一枚真的：jsdom 里没有 `AudioContext`，
   * 它会安静地退化成一枚什么都不放的播放器，所以绝大多数测试不必管这一项。
   * 要断言"响没响"的测试（`soundWiring.test.tsx`）传的是真播放器 + 假上下文。
   */
  readonly sound?: SoundPlayer;
  /**
   * 打开 StrictMode。
   *
   * 生产构建里 `main.tsx` 本来就开着，dev 下它会把每个 effect 跑两遍。
   * 「打开分享链接自动进房」正是靠 effect 触发的，所以防重复连接的守卫
   * 只有在 StrictMode 下才真正被测到。
   */
  readonly strict?: boolean;
}

export function seedProfile(profile: StoredProfile = TEST_PROFILE): void {
  window.localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
}

/**
 * 每个测试前后都要调。
 *
 * 四项状态里有三项是模块级的（头像缓存、共享 client、localStorage），
 * 漏掉任何一项都会让「单独跑通过、一起跑失败」。
 */
export function resetWebState(): void {
  cleanup();
  window.localStorage.clear();
  clearAvatarCache();
  resetSharedClient();
}

export function renderWithProviders(initialPath: string, routes: ReactNode, options: RenderOptions = {}): RenderResult {
  const tree = (
    <ProfileProvider>
      <SoundProvider player={options.sound}>
        <RoomProvider client={options.client}>
          <MemoryRouter initialEntries={[initialPath]}>
            <AppShell>{routes}</AppShell>
          </MemoryRouter>
        </RoomProvider>
      </SoundProvider>
    </ProfileProvider>
  );

  return render(options.strict === true ? <StrictMode>{tree}</StrictMode> : tree);
}
