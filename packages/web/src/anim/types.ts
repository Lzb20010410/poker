/**
 * 动画任务与队列的可测契约（SPEC §3.1）。
 *
 * 这里**不认识 DOM、不认识 GSAP、不认识牌桌**。一帧动画怎么画出来是 `renderer.ts`
 * 那层的事；队列只保证四件事：一次播一个、能被打断、积压就作废、坏了不卡死。
 * 把这三件事写在一个不带 DOM 的文件里，是因为 SPEC §3.1 那四条验收标准
 * 全部是关于**顺序**的，而顺序是唯一能被机器可靠证明的东西。
 */

/** 一段动画交给队列的东西。`id` 只用于日志与断言，队列不解释它 */
export interface AnimTask {
  readonly id: number;
  /** 基准时长（毫秒）。倍速由队列乘，任务自己不知道现在是快放还是慢放 */
  readonly durationMs: number;
  /**
   * 开播。`done` 被调用即视为这一段结束（队列据此启动下一段）；
   * 返回值是中止句柄——跳过时队列调它。
   *
   * **`play` 同步抛错不会拖垮队列**，见 `queue.ts` 的 `startNext`：一段动画写坏了
   * 只意味着那一段不播，玩家不该因此再也点不动按钮。
   */
  readonly play: (done: () => void, durationMs: number) => (() => void) | void;
  /**
   * 立刻把这一段放到终态。跳过、积压清空、看门狗三条路都会走到这里，
   * 而且是在 `play` 返回的中止句柄**之后**再调一次——所以实现必须幂等。
   */
  readonly settle: () => void;
}

/** 队列在某一时刻的样子。`pending` **不含**正在播的那一段 */
export interface AnimQueueState {
  readonly blocked: boolean;
  readonly pending: readonly AnimTask[];
  readonly active: AnimTask | null;
  readonly speed: number;
}

export type AnimQueueListener = (state: AnimQueueState) => void;
export type AnimQueueUnsubscribe = () => void;

export interface AnimQueue {
  readonly push: (task: AnimTask) => void;
  readonly skip: () => void;
  /** 重连：不播历史，直接终态。效果与 `skip` 相同，分开命名是因为语义不同 */
  readonly flush: () => void;
  /** 倍速：1 原速、0.5 加速（SPEC §3.1「加速开关」） */
  readonly setSpeed: (speed: number) => void;
  readonly state: () => AnimQueueState;
  readonly subscribe: (listener: AnimQueueListener) => AnimQueueUnsubscribe;
  readonly destroy: () => void;
}
