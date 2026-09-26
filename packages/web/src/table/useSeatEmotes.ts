/**
 * 表情气泡的状态（M3.5）：把「谁发了哪条表情」变成「哪一格上挂着什么」。
 *
 * ## 为什么它是 React 状态，而不是动画队列里的一段
 *
 * 队列存在的意义是**排他**：发牌、筹码飞行、收池这些得一个一个来，否则玩家看不清发生了什么，
 * 所以队列非空时操作按钮要按住（SPEC §3.1）。表情不是这一类：它不改变任何画面上的事实，
 * 也不占用玩家的操作。把它塞进队列的代价很具体——有人连发三个表情，
 * 后面两个就排在发牌动画之后两三秒才出现，那时那句「大笑」早就没意义了。
 * 所以 `planEvent` 对它返回 `null`（见 `anim/plan.ts`），气泡自己走这一条短生命周期状态。
 *
 * ## 为什么不塞进快照
 *
 * `RoomSnapshot` 是「现在的牌桌长什么样」，而一条表情是「刚才谁表达了点什么」。
 * 后者落在快照里会一直挂到有人清它为止，而服务端没有理由为一张脸去改状态机。
 *
 * ## 一个座位只留最新的一条
 *
 * 同一人两秒内连发两条时，后一条把前一条**换掉**，而不是叠两层、也不是各留一个到期时钟。
 * 按座位存还有一个附带好处：清掉旧定时器再挂新的，就不会出现"上一条的时钟把下一条摘走"。
 *
 * ## 为什么拆成「水槽」和「接线的钩子」两层
 *
 * 产品里的表情来自连接（`useSeatEmotes`），而 `/dev/replay`（M3.2）里没有连接，
 * 只有一份硬编码的事件脚本。如果回放页自己再写一套 TTL 逻辑，它验的就是**另一套**气泡，
 * 而不是牌桌上真那套——回放器一旦和线上不一致，它就失去了存在的意义。
 * 所以下面 `useSeatEmoteSink` 是那一份唯一的实现（座位去重 + 到期时钟 + 卸载清理），
 * 两边都只是给它喂数据。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { useRoom } from '../state/RoomContext';
import { emoteLabel } from './components/EmoteBar';

/** 一条气泡在牌桌上停留多久。比一段动画长（它不是表演），比一手牌短（它不该活到下一步） */
export const EMOTE_TTL_MS = 2400;

/** 某一格身上此刻挂着的那句话 */
export interface SeatEmote {
  readonly seatIndex: number;
  readonly label: string;
}

export interface SeatEmoteSink {
  readonly emotes: readonly SeatEmote[];
  /**
   * 一条表情落到座位上。参数收的是**服务端的 emoji id**而不是文案：
   * 查表这一步只住在这里，所以「发出去的是 laugh、别人看到别的」构造不出来。
   * 表里没有的 id 直接忽略（协议里 `emoji` 是 `string`，服务端不保证它是那四个之一）。
   */
  readonly emit: (seatIndex: number, emoji: string) => void;
}

export function useSeatEmoteSink(): SeatEmoteSink {
  const [emotes, setEmotes] = useState<readonly SeatEmote[]>([]);
  /** 座位号 → 那条气泡的到期时钟。存 ref 而不是 state：时钟本身不是要渲染的东西 */
  const timers = useRef(new Map<number, number>());

  const emit = useCallback((seatIndex: number, emoji: string): void => {
    const label = emoteLabel(emoji);
    if (label === undefined) return;
    const pending = timers.current;
    const previous = pending.get(seatIndex);
    if (previous !== undefined) window.clearTimeout(previous);
    const handle = window.setTimeout(() => {
      pending.delete(seatIndex);
      setEmotes((rows) => rows.filter((row) => row.seatIndex !== seatIndex));
    }, EMOTE_TTL_MS);
    pending.set(seatIndex, handle);
    setEmotes((rows) => [...rows.filter((row) => row.seatIndex !== seatIndex), { seatIndex, label }]);
  }, []);

  const clear = useCallback((): void => {
    // 不摘这些时钟的话，玩家退回大厅后每条表情都会在两秒后对着已卸载的组件 setState
    for (const handle of timers.current.values()) window.clearTimeout(handle);
    timers.current.clear();
  }, []);

  useEffect(() => clear, [clear]);

  return { emotes, emit };
}

/** 产品用这一条：表情来自连接上的 `player:emoji` 广播 */
export function useSeatEmotes(): SeatEmoteSink {
  const { onEvent } = useRoom();
  const sink = useSeatEmoteSink();
  /** 依赖里只放 `emit`：`sink` 这个对象每次渲染都是新的，放进依赖会每次渲染重订一次连接 */
  const { emit } = sink;

  useEffect(
    () =>
      onEvent((event) => {
        if (event.t === 'player:emoji') emit(event.seatIndex, event.emoji);
      }),
    [onEvent, emit],
  );

  return sink;
}
