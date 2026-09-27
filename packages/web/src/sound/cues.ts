/**
 * 「什么时候响一声」这张表（M4.2）。
 *
 * 触发分成两路，这不是随手分的，而是照着动画层那条已经成立的分工：
 *
 * - **一次性事件**跟服务端广播流（`SPEC.md` §2.3「动画由事件驱动，不由状态 diff 驱动」）：
 *   发牌、翻公共牌、筹码声。它们本来就是"一段表演"，跟画面用同一批输入才不会各说各话。
 * - **状态类**跟快照：轮到你、这手你赢了。
 *
 * 第二路为什么不跟着 `turn:change` 事件走，理由值得写下来：「轮到我」的唯一事实来源是
 * 服务端算好的 `isMyTurn`，而**操作按钮亮不亮读的也是它**。提示音要是改从事件推，
 * 就会出现「声音先响、按钮后亮」（事件与 patch 不保证同帧到），玩家听见该他了却点不动——
 * 这比不响更糟。跟着快照走，声音和按钮就永远同一帧。
 *
 * 摊牌亮牌不响：那一瞬间有用的是视觉信息，而一手里它可能出现好几次。
 */

import type { S2C_Broadcast } from '@poker-room/shared/view';

import type { RoomSnapshot } from '../net/types';

import type { SoundName } from './synth';

/**
 * 一条广播事件 → 一个音效，或者静默。
 *
 * 和 `anim/plan.ts` 一样把「不响」的分支逐条写出来，而不是 `default: return null`：
 * 以后协议加一类事件，编译器会逼着在这儿表个态，而不是让它悄悄静音。
 */
export function soundForEvent(event: S2C_Broadcast): SoundName | null {
  switch (event.t) {
    case 'deal:start':
      return 'deal';
    case 'board:deal':
      return 'board';
    // 只有筹码真的动了才响：弃牌、过牌没有筹码相碰，响就是骗人
    case 'action:made':
      return event.chipsDelta > 0 ? 'chip' : null;
    case 'pot:awarded':
      return 'chip';
    case 'hand:start':
    case 'shuffle':
    case 'turn:change':
    case 'round:end':
    case 'showdown:start':
    case 'hand:end':
    case 'player:joined':
    case 'player:left':
    case 'player:emoji':
    case 'chips:rebuy':
      return null;
  }
}

export interface SnapshotCues {
  /**
   * 观察一份新快照，返回这一帧该响的那一声（最多一声）。
   *
   * `null` = 还没有快照。此时**什么都不记**：基线要落在第一份真快照上，
   * 否则「刷新进来时正好轮到我」会被当成"没有变化"而永远不响。
   */
  readonly observe: (snapshot: RoomSnapshot | null) => SoundName | null;
}

/**
 * 快照里的「轮到你」和「这手你赢了」。
 *
 * 有状态（记上一次的 `isMyTurn`、已经报过胜利的那一手），所以是个工厂而不是纯函数——
 * 和 `anim/revealDelta.ts` 同一套写法：线上与测试各自持有一份，互不串基线。
 */
export function createSnapshotCues(): SnapshotCues {
  let turnOn = false;
  let wonHandId: string | null = null;

  return {
    observe: (snapshot) => {
      if (snapshot === null) return null;

      const turnRising = snapshot.isMyTurn && !turnOn;
      turnOn = snapshot.isMyTurn;

      // 服务端在开局那一帧会把 `results` 清空（`table-flow.ts` 的 `results: []`），
      // 所以「同一手只报一次」够用：不会因为上一手的结算残留重复响。
      const won = snapshot.results.some((result) => result.playerId === snapshot.myId && result.delta > 0);
      const freshWin = won && wonHandId !== snapshot.handId;
      if (freshWin) wonHandId = snapshot.handId;

      // 一帧最多一声。结算那一帧恰好又轮到某人（很罕见）时优先报胜利，
      // 「轮到你」的跃迁算已经用掉——下一手真正轮到那个人时还会再报。
      if (freshWin) return 'win';
      return turnRising ? 'turn' : null;
    },
  };
}
