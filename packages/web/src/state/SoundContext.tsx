/**
 * 音效的 React 上下文：把「机制」（`sound/player.ts`）接到「策略」上。
 *
 * ## 这一层管三件事，纯层各管一件
 *
 * | 谁 | 管什么 |
 * |---|---|
 * | `sound/player.ts` | 手势、上下文生命周期、调度。**不知道静音** |
 * | `sound/settings.ts` | 静音档读写（无痕模式接住异常） |
 * | 本文件 | 谁调它、什么时候调、要不要调 |
 *
 * ## 「解锁」挂在 window 上，而不是每个按钮的 onClick 里
 *
 * 浏览器的自动播放策略只认用户手势（`SPEC.md` §4.7 那句「AudioContext 只在首次用户
 * 交互后初始化」）。要拿到这个手势，最省事的做法是在 window 上监听
 * `pointerdown` / `keydown`：玩家在任何地方碰一下屏幕都算，不必在每个可点元素上
 * 补一遍 `unlock()`，也不会漏掉某个后来新增的按钮。监听是 `passive` 的——
 * 只读事件，不改默认行为，滚动和点击选中一切如常。
 *
 * ## 静音时连 `unlock()` 都不发起
 *
 * 于是真播放器根本没机会去建上下文。iOS 每页只有约 4 个 AudioContext 名额，
 * 把名额留给真要响的东西；「静音连上下文都不建」这条保证在这一层成立，
 * `player.ts` 里不必再判一次。
 *
 * ## 取消静音的这一下当场响一声
 *
 * 验收项里有一条「手机 Safari 与 Chrome 都能出声」，而它最难自测：静音着进桌
 * → 取消静音 → 得等下一手牌才知道响不响。这一声（`turn`，五声里最短促的一响）
 * 就发生在玩家点开关的那个手势里，手机上点完立刻能听见，不用等、不用猜。
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { openAudioContext } from '../sound/browser';
import { createSoundPlayer, type SoundPlayer } from '../sound/player';
import type { SoundName } from '../sound/synth';
import { loadMuted, saveMuted } from '../sound/settings';

export interface SoundContextValue {
  /** 当前是否静音。页头开关的文案读它 */
  readonly muted: boolean;
  /** 放一声。静音时到这里就被挡掉，未解锁时由播放器吞掉 */
  readonly play: (name: SoundName) => void;
  /** 切换静音。写 localStorage，并在切回有声时当场响一声 */
  readonly toggleMuted: () => void;
}

export interface SoundProviderProps {
  readonly children: ReactNode;
  /**
   * 注入播放器。测试传的是「真播放器 + 假上下文」，于是门禁、调度、手势顺序
   * 全部走真代码，只有浏览器那部分被替掉。不传就自己建一枚（jsdom 里没有
   * `AudioContext`，会安静地退化成一枚什么都不放的播放器）。
   */
  readonly player?: SoundPlayer;
}

const SoundContext = createContext<SoundContextValue | null>(null);

export function SoundProvider({ children, player }: SoundProviderProps): ReactNode {
  const [muted, setMuted] = useState<boolean>(() => loadMuted());
  const sink = useMemo(() => player ?? createSoundPlayer({ openAudioContext }), [player]);

  /**
   * 门禁读 ref，不读 state。
   *
   * 两个理由：window 上的手势监听因此可以只挂一次（不必跟着开关重注册）；
   * `play` 的函数身份因此保持稳定，牌桌那些 `[onEvent, play]` 的 effect 不会
   * 因为玩家点了下开关就重新订阅一遍事件流。
   */
  const mutedRef = useRef<boolean>(muted);

  const play = useCallback(
    (name: SoundName) => {
      if (mutedRef.current) return;
      sink.play(name);
    },
    [sink],
  );

  const toggleMuted = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    saveMuted(next);
    setMuted(next);
    if (next) return;
    // 这一次调用就发生在玩家点开关的手势里，是解锁的最佳时机
    sink.unlock();
    sink.play('turn');
  }, [sink]);

  useEffect(() => {
    const wake = (): void => {
      if (mutedRef.current) return;
      sink.unlock();
    };
    window.addEventListener('pointerdown', wake, { passive: true });
    window.addEventListener('keydown', wake);
    return () => {
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', wake);
    };
  }, [sink]);

  const value = useMemo<SoundContextValue>(() => ({ muted, play, toggleMuted }), [muted, play, toggleMuted]);

  return <SoundContext.Provider value={value}>{children}</SoundContext.Provider>;
}

/**
 * 取音效开关。
 *
 * Provider 外面直接抛错，和 `useProfile` / `useRoom` 同一口径：返回一份"什么都不响"
 * 的默认值会让接线错误静默变成"这游戏没声音"，那种 bug 没人查得出来。
 */
export function useSound(): SoundContextValue {
  const value = useContext(SoundContext);
  if (value === null) {
    throw new Error('useSound 必须在 <SoundProvider> 内部使用');
  }
  return value;
}
