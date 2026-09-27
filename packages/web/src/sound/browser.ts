/**
 * 向浏览器要一枚 `AudioContext`。
 *
 * 单独一个文件，因为整个音效层只有这一处**向音频全局伸手**，其余都从别处注入
 * （见 `player.ts`）。这样"浏览器给了什么"这件事在单测里是可替换的：
 * `soundPlayer.test.ts` 直接往 `globalThis` 上挂假构造函数就能测完这三条分支。
 *
 * `webkitAudioContext` 不是历史包袱：iOS Safari 直到 14.4 才认无前缀的名字，
 * 而「手机 Safari 能出声」正是 M4.2 的验收项。
 */

import type { SoundAudioContext } from './synth';

interface AudioContextConstructor {
  new (): SoundAudioContext;
}

interface AudioScope {
  readonly AudioContext?: AudioContextConstructor;
  readonly webkitAudioContext?: AudioContextConstructor;
}

/** 构造失败（名额用尽等）由调用方接住，这里不吞异常：只有 `player.ts` 知道该不该再试 */
export function openAudioContext(): SoundAudioContext | null {
  const scope = globalThis as typeof globalThis & AudioScope;
  const Constructor = scope.AudioContext ?? scope.webkitAudioContext;
  return Constructor === undefined ? null : new Constructor();
}
