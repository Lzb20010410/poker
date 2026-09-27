/**
 * 播放器的生命周期：什么时候**不许**碰 AudioContext（M4.2 的验收核心）。
 *
 * 自动播放策略下，在没有用户手势的时机创建或播放 AudioContext，表现是控制台一条警告
 * （Chrome / 桌面）或者干脆永远静音且状态停在 `suspended`（iOS Safari）。三条规矩就是
 * 为了挡住这两件事：
 *
 * 1. 没解锁过一声都不放，连上下文都不建 ——「首次加载不触发浏览器自动播放警告」；
 * 2. 上下文只建一枚、全程复用（iOS 每页只有约 4 个名额）；
 * 3. `state === 'suspended'` 才 `resume()`：切回来还挂着起（后台、手势过期）就再唤醒一次。
 *
 * 这一层**不知道静音**。要不要出声是策略，归 `state/SoundContext.tsx`（那里同时管 localStorage
 * 和页头开关的文案）；这一层只管机制：手势、上下文、调度。两边各管一件，
 * 于是「静音时连 AudioContext 都不建」这条保证在 Provider 那一侧成立，不必在这里再判一次。
 *
 * 另外两条是"别把界面搞挂"：浏览器不支持 Web Audio 时静默退化（且只试一次，
 * 不在每个音效上都重跑一遍探测），以及 `resume()` 被拒时不许漏出未处理的 promise
 * rejection——这条是被调用在 `pointerdown` 处理器里的，漏出去就是整个应用跟着崩。
 *
 * 「解锁」由谁调？`state/SoundContext.tsx` 在 window 上挂 `pointerdown` / `keydown`
 * （`passive: true`，不抢事件）。玩家第一次碰屏幕之前，这一层什么都不会发生。
 */

import { playSound, type SoundAudioContext, type SoundName } from './synth';

export interface SoundPlayer {
  /** 用户手势里调：建上下文并唤醒它。幂等 */
  readonly unlock: () => void;
  /** 放一声。未解锁或浏览器不支持时是空操作 */
  readonly play: (name: SoundName) => void;
}

export interface SoundPlayerDeps {
  /** 向浏览器要一枚上下文；不支持就返回 null，抛错也按不支持处理 */
  readonly openAudioContext: () => SoundAudioContext | null;
}

export function createSoundPlayer(deps: SoundPlayerDeps): SoundPlayer {
  let context: SoundAudioContext | null = null;
  /** 探测只做一次：不支持就是不支持，别每个音效再撞一遍 */
  let probed = false;
  let unlocked = false;

  const open = (): SoundAudioContext | null => {
    if (probed) return context;
    probed = true;
    try {
      context = deps.openAudioContext();
    } catch {
      // iOS 上上下文名额用尽会直接抛。静音退化，不冒到调用方。
      context = null;
    }
    return context;
  };

  const wake = (audio: SoundAudioContext): void => {
    if (audio.state !== 'suspended') return;
    // 切后台、手势过期都可能让这个 promise 被拒。这里唯一正确的处理是不处理。
    void audio.resume().catch(() => undefined);
  };

  return {
    unlock: () => {
      unlocked = true;
      const audio = open();
      if (audio !== null) wake(audio);
    },
    play: (name) => {
      if (!unlocked) return;
      const audio = open();
      if (audio === null) return;
      wake(audio);
      playSound(name, audio);
    },
  };
}
