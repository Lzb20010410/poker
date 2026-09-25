/**
 * 本地身份（昵称 + 头像 seed）的 React 上下文。
 *
 * 单独抽一个 Provider 是因为三个地方要用它：大厅（编辑）、房间上下文（进房时
 * 随 join options 上送）、等待室（显示「你」是谁）。prop 钻三层不值当。
 *
 * 首次访问就生成一套默认身份并落盘，**不弹任何「请先填昵称」的门槛**：
 * 玩家点开 `/r/配对码` 这种分享链接时要能直接进房，改名随时可以在大厅改。
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import {
  createDefaultProfile,
  loadProfile,
  randomAvatarSeed,
  saveProfile,
  type StoredProfile,
} from './profile';

export interface ProfileContextValue {
  readonly profile: StoredProfile;
  /**
   * 改昵称或换头像 seed。传进来的值会原样进 state，最终由服务端再清洗一遍。
   *
   * 函数成员一律写成属性而不是方法签名，否则从 `useProfile()` 解构下来
   * 会触发 `@typescript-eslint/unbound-method`（理由见 net/types.ts 里的说明）。
   */
  readonly update: (patch: { nickname?: string; avatarSeed?: string }) => void;
  /** 随机换一个头像。玩家不想用当前这张脸时的唯一出路 */
  readonly rerollAvatar: () => void;
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

export function ProfileProvider({ children }: { children: ReactNode }): ReactNode {
  // 初始值走函数式，`loadProfile` 只在挂载时读一次 localStorage
  const [profile, setProfile] = useState<StoredProfile>(() => loadProfile() ?? createDefaultProfile());

  useEffect(() => {
    saveProfile(profile);
  }, [profile]);

  const update = useCallback((patch: { nickname?: string; avatarSeed?: string }) => {
    setProfile((current) => ({
      nickname: patch.nickname ?? current.nickname,
      avatarSeed: patch.avatarSeed ?? current.avatarSeed,
    }));
  }, []);

  const rerollAvatar = useCallback(() => {
    setProfile((current) => ({ ...current, avatarSeed: randomAvatarSeed() }));
  }, []);

  const value = useMemo<ProfileContextValue>(
    () => ({ profile, update, rerollAvatar }),
    [profile, update, rerollAvatar],
  );

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

/**
 * 取当前身份。
 *
 * Provider 外面调用直接抛错而不是返回一个假默认值：那是个静默的错误来源
 * （组件会显示一个永远不会被保存的昵称），宁可开发时就炸。
 */
export function useProfile(): ProfileContextValue {
  const value = useContext(ProfileContext);
  if (value === null) {
    throw new Error('useProfile 必须在 <ProfileProvider> 内部使用');
  }
  return value;
}
