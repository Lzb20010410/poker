/**
 * 牌桌的音效接线（M4.2）。
 *
 * 两路输入，和动画层是同一套分工（`SPEC.md` §2.3「动画由事件驱动」）：
 *
 * - **广播事件** → `sound/cues.ts` 的 `soundForEvent`：发牌、翻公共牌、筹码、收池。
 *   跟画面用同一批输入，才不会「筹码音已经响了、动画还在路上」。
 * - **快照跃迁** → `createSnapshotCues()`：轮到你、这手你赢了。
 *   为什么不跟 `turn:change` 事件走，`cues.ts` 文件头写了：操作按钮亮不亮读的是
 *   `isMyTurn`，声音跟着快照才和它同一帧。
 *
 * ## 掉线期间快照那一路哑掉
 *
 * `link !== 'online'` 时手里那份快照是**冻在掉线瞬间**的（重连窗口约 56 秒，见
 * `net/types.ts`），那时的「轮到我」很可能早就不是事实——给一声提示等于把玩家喊回来
 * 点一个点不动的按钮。所以这一路喂给 cues 的是 `null`。注意只挡声音、**不动基线**：
 * 重连后服务端补推的那份快照如果还是轮到我，不会因此多响一声。
 *
 * 事件那一路不需要这道闸：socket 关了就没有新事件到达，`onEvent` 也不重放。
 *
 * ## 卸载即收订阅
 *
 * 退回大厅后服务端还在广播（同房间其他人在打），不摘订阅就会在空画面上排声音。
 * 和 `useAnimDirector` 的清理是同一个理由。
 */

import { useEffect, useMemo } from 'react';

import { createSnapshotCues, soundForEvent } from '../sound/cues';
import { useRoom } from '../state/RoomContext';
import { useSound } from '../state/SoundContext';

export function useTableSounds(): void {
  const { onEvent, snapshot, link } = useRoom();
  const { play } = useSound();

  /** 有状态的跃迁追踪器：跨快照记「上一次是否轮到我」「这一手报过赢没有」 */
  const cues = useMemo(() => createSnapshotCues(), []);

  useEffect(() => onEvent(
    (event) => {
      const name = soundForEvent(event);
      if (name !== null) play(name);
    },
  ), [onEvent, play]);

  useEffect(() => {
    const name = cues.observe(link === 'online' ? snapshot : null);
    if (name !== null) play(name);
  }, [snapshot, link, play, cues]);
}
