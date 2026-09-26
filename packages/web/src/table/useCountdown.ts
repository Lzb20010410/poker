/**
 * 倒计时：把服务端的绝对时刻换成本地显示的剩余时间。
 *
 * 对外两档：`useCountdown` 给整秒（文字），`useCountdownMs` 给毫秒（M3.5 的倒计时环）。
 *
 * ## 为什么不在本地自己每秒减一
 *
 * 手机切到后台再回来，本地那套「自己数」的计时器和服务端早就对不上了，
 * 玩家会看到「剩余 27 秒」而服务端刚刚已经把他超时Fold掉。
 * 所以这里每次 tick 都重新算 `deadline - (本地时间 + 时钟偏移)`：
 *
 * - `deadline` 是**服务端时钟**下的截止时刻；
 * - `clockOffsetMs` 是收到这份快照那会儿 `serverTime - Date.now()` 的差
 *   （见 `net/view.ts`），用它把本地时间挪到服务端那条时间轴上。
 *
 * 归零之后停在 0，不再往下变负数——「-3 秒」对玩家没有任何意义，
 * 而超时这一步服务端 1 秒内就会推新状态过来。
 *
 * `now` 是可注入的，只为了测试里能精确控制时间；生产路径用 `Date.now`。
 *
 * ## 为什么是 `useSyncExternalStore` 而不是 `useState` + `useEffect`
 *
 * 「当前还剩几秒」这份数据的真正来源是**时钟**，不是组件里的某块状态：
 * 用 state 存它就意味着要在 effect 里同步写一次（挂载和 `deadline` 变化时各一次），
 * 否则新的一步会先按旧的剩余秒数渲染出来，最多错整整一秒。
 * 而「在 effect 里同步 setState」正是 React 新 lint 规则禁掉的东西，禁得有道理——
 * 它多跑一轮渲染，还把「值从哪来」说得含含糊糊。
 *
 * 所以这里把时钟当成外部 store：订阅负责每秒推一次变化，取值负责**在渲染时现算**。
 * 没有缓存的中间状态，`deadline` 一换，下一次渲染读到的就是新答案。
 * 但「现算」有个前提：同一帧里读两次必须给同一个答案（React 在 commit 阶段会再读一次
 * 和渲染时比对），所以取值按 tick 归档——见 `getSnapshot` 里那段。
 *
 * 本项目是纯客户端 SPA（Vite，不做 SSR / hydration），所以第三个参数
 * `getServerSnapshot` 用不上；哪天要加服务端渲染，这里得补上。
 */

import { useCallback, useSyncExternalStore } from 'react';

/**
 * 内部那份「还剩多少毫秒」的 store。
 *
 * 与 `useCountdown` 唯一的区别是单位与粒度：环要的是连续量（一秒一跳的圆环看着像卡帧），
 * 文字要的是整秒（没人读得懂「还剩 12.4 秒」）。两者共用一条订阅逻辑，
 * 免得「归零后停下」「target 为 null 时不订阅」这两条保证写两遍、漏一遍。
 */
function useRemainingMs(
  target: number | null,
  clockOffsetMs: number,
  tickMs: number,
  now: () => number,
): number | null {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (target === null) return () => undefined;
      const timer = window.setInterval(onStoreChange, tickMs);
      return () => {
        window.clearInterval(timer);
      };
    },
    [target, tickMs],
  );

  const getSnapshot = useCallback((): number | null => {
    if (target === null) return null;
    // 归零后停在 0：负数一路变小会让这个 store 每秒都"变了"，白重渲染一个早就走完的环
    const raw = Math.max(0, target - (now() + clockOffsetMs));
    /*
     * 读数**归档到 tick**。`useSyncExternalStore` 在 commit 阶段会再读一次和渲染时比对，
     * 不一样就强制重渲染——而 `now()` 每毫秒都在变小，于是牌桌这种渲染耗时几毫秒的
     * 重页面会一路转到 React 抛 `Maximum update depth exceeded`（第 50 层嵌套更新）。
     * 这条是 M3.2 造回放器时撞出来的，`test/useCountdown.test.tsx` 钉着。
     * 归档之后：一秒一跳的文字只在整秒边界上改口，200ms 一档的环同理，
     * 与「外部 store 每 tick 才有新信息」这件事本身一致。显示值不受影响（整秒那档
     * 外面本来就是 `ceil`）。
     */
    return Math.ceil(raw / tickMs) * tickMs;
  }, [clockOffsetMs, now, target, tickMs]);

  return useSyncExternalStore(subscribe, getSnapshot);
}

/** 剩余整秒；`target` 为 null 时返回 null，表示「现在没有计时器该亮」 */
export function useCountdown(
  target: number | null,
  clockOffsetMs: number,
  now: () => number = Date.now,
): number | null {
  const msLeft = useRemainingMs(target, clockOffsetMs, 1000, now);
  return msLeft === null ? null : Math.ceil(msLeft / 1000);
}

/** 环的刷新粒度。200ms 足够让一圈 30 秒看着在走，又不必每帧重画 */
const RING_TICK_MS = 200;

/**
 * 剩余毫秒，粒度 200ms。给倒计时环用。
 *
 * 这里刻意不用 `requestAnimationFrame`：一环 30 秒，200ms 一档已经看不出台阶，
 * 而 rAF 会跟着标签页可见性走——切回前台那一刻补一大帧，反而在玩家眼里跳一下。
 */
export function useCountdownMs(
  target: number | null,
  clockOffsetMs: number,
  now: () => number = Date.now,
): number | null {
  return useRemainingMs(target, clockOffsetMs, RING_TICK_MS, now);
}
