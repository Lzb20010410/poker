/**
 * 「刚才谁新亮了牌」的增量判定（SPEC §3.2 的亮牌动画入口）。
 *
 * ## 为什么它是独立一份
 *
 * 线上牌桌从连接上的快照增量里推（`useAnimDirector`），`/dev/replay`（M3.2）从硬编码
 * 帧序列里推。两边要的是**同一条保证**：刷新页面或换场景后第一份快照只对齐、不播。
 * 这条规则一旦复制成两份，回放器验的就不是线上那一套——而回放器存在的全部意义
 * 就是「在不启动服务端的情况下复现线上那条动画序列」。
 *
 * ## 「首次观察只对齐、不播」
 *
 * 亮牌不在广播流里（D-002 / D-013），只能从快照的 `reveals` 增量里推。刷新页面或断线
 * 重连后，`subscribe` 会同步推一份当前快照，里面往往已经带着摊牌的正面——那一刻把它
 * 翻一遍就是「重播历史动画」，而玩家要的是当前局面，不是上一手的表演。
 *
 * 「首次」必须是**第一份真快照**，不能是挂载时那份占位空数组：`TablePage` 的 hook
 * 在进房 promise 落地之前就在跑，那时 `snapshot` 还是 `null`。把那条空数组记成基线，
 * 基线就永远是空，刷新进摊牌时补推的那几个人全成了「新亮的」——上面这条保证直接失效。
 * 所以入参收成 `readonly RevealView[] | null`，`null` 表示「还没有快照」，什么都记不下。
 */

import type { RevealView } from '../net/types';

export interface RevealTracker {
  /**
   * 喂进当前快照的 `reveals`。返回**该播的那几行**（没见过的那些），没有新行就返回空数组。
   * `null` = 还没有任何真快照：不记基线，也不播。
   */
  readonly observe: (rows: readonly RevealView[] | null) => readonly RevealView[];
  /** 忘掉基线：回放器换场景 / 重来时用，下一份快照只对齐不播 */
  readonly reset: () => void;
}

export function createRevealTracker(): RevealTracker {
  /** `null` = 还没见过任何一份快照，见文件头 */
  let seen: Set<string> | null = null;

  return {
    observe: (rows) => {
      if (rows === null) return [];
      const ids = new Set(rows.map((row) => row.playerId));
      const previous = seen;
      seen = ids;
      if (previous === null) return [];
      return rows.filter((row) => !previous.has(row.playerId));
    },
    reset: () => {
      seen = null;
    },
  };
}
