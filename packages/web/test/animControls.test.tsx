/**
 * 动画控制的 React 胶水单测。
 *
 * 这里验的是**接线**：事件从连接流进队列、队列状态回流组件、掉线和卸载各要发生什么。
 * 队列本身的规则在 `animQueue.test.ts`，事件分流在 `animDirector.test.ts`，
 * 三层各钉各的，坏在哪一层就红在哪一层。
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { ANIM_SPEED_FAST } from '../src/anim/rig';
import { useAnimDirector, type AnimControls } from '../src/anim/useAnimDirector';
import type { AnimRenderer } from '../src/anim/director';
import type { AnimPlan } from '../src/anim/plan';
import type { GameClient, RevealView } from '../src/net/types';
import { RoomProvider, useRoom, type RoomStatus } from '../src/state/RoomContext';
import { createFakeRoom, type FakeRoomHandle } from './fakeClient';

const CODE = 'K7QM3D';
const PROFILE = { nickname: '阿博', avatarSeed: 'FixedSeed01' };
const NO_REVEALS: readonly RevealView[] = [];

/** 一条摊牌亮牌。`playerId` 是增量判定的键，座位号只影响翻哪一格 */
function revealRow(seatIndex: number): RevealView {
  return {
    playerId: `p-${String(seatIndex)}`,
    seatIndex,
    cards: [
      { rank: 14, suit: 's' },
      { rank: 13, suit: 'h' },
    ],
  };
}

/** `renderHook` 的那个 ref，只声明这条测试线要读的两样 */
type HookRef = { readonly current: AnimControls & { readonly status: RoomStatus } };

/** props 上必须显式带上 `| null`，否则 `renderHook` 会从初值把类型推成「永远是 null」 */
interface HookProps {
  readonly rows: readonly RevealView[] | null;
}
const NO_SNAPSHOT: HookProps = { rows: null };

interface Probe {
  readonly plans: AnimPlan[];
  readonly settled: number[];
  /** 让正在播的那一段正常播完 */
  readonly finish: () => void;
  readonly renderer: AnimRenderer;
}

/**
 * 假渲染器。
 *
 * 用普通闭包而不是 `useState` 记账：这些数组只在 `act` 之后被断言读，不参与渲染，
 * 放进 state 只会让每个事件多一次重渲染，把「队列状态变了」这个信号混进别的变化里。
 */
function createProbe(): Probe {
  const plans: AnimPlan[] = [];
  const settled: number[] = [];
  let done: (() => void) | null = null;
  return {
    plans,
    settled,
    finish: () => {
      const callback = done;
      done = null;
      callback?.();
    },
    renderer: (plan, id) => {
      plans.push(plan);
      return {
        id,
        durationMs: plan.durationMs,
        play: (onDone) => {
          done = onDone;
          return () => {
            done = null;
          };
        },
        settle: () => {
          settled.push(id);
        },
      };
    },
  };
}

/** 手动放行的「连接什么时候到手」，用来看住订阅与连接的先后 */
interface Gate {
  readonly wait: () => Promise<void>;
  readonly release: () => void;
}

function createGate(): Gate {
  let release: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait: () => pending, release: () => release() };
}

/**
 * 把在飞的 promise 链跑到它当前能跑到的地方。
 *
 * 一个 `await` 边界就会把整个微任务队列排空（排空过程中新入队的也一起排），
 * 所以「进房」链上除闸门之外的每一步都走完了；包在 `act` 里是为了让链上那些
 * `setState` 立刻变成可断言的渲染结果。
 */
async function flush(): Promise<void> {
  await act(async () => undefined);
}

interface Harness {
  readonly room: FakeRoomHandle;
  readonly probe: Probe;
  readonly result: HookRef;
  readonly gate: Gate;
  readonly unmount: () => void;
  /** 换一份快照的 `reveals` 进来，等价于收到一次新的 state patch */
  readonly pushReveals: (rows: readonly RevealView[]) => void;
}

/**
 * 牌桌页真实的先后顺序：导演的订阅 effect 先进场，进房 effect 还在等 promise。
 * 这个顺序是这条测试线全部的意义——写成「先连好再挂导演」就测不到总线那一层了。
 *
 * `rows` 起手必须是 `null`：`TablePage` 在拿到第一份快照之前传的就是 `null`，
 * 而「什么时候开始记增量基线」正是这条线要测的东西。起手给 `[]` 会让假环境比真页面
 * 更像「已经见过局面」，于是刷新重连那条保证在这里根本测不出来。
 */
function setup(): Harness {
  const room = createFakeRoom(CODE);
  const probe = createProbe();
  const gate = createGate();
  const client: GameClient = {
    createRoom: async () => room.connection,
    joinRoom: async () => {
      await gate.wait();
      return room.connection;
    },
  };
  const { result, unmount, rerender } = renderHook(
    ({ rows }: HookProps) => {
      const controls = useAnimDirector(probe.renderer, rows);
      const { joinRoom, status } = useRoom();
      useEffect(() => {
        void joinRoom(CODE, PROFILE);
      }, [joinRoom]);
      return { ...controls, status };
    },
    {
      initialProps: NO_SNAPSHOT,
      wrapper: function Wrapper({ children }: { children: ReactNode }) {
        return <RoomProvider client={client}>{children}</RoomProvider>;
      },
    },
  );
  return {
    room,
    probe,
    result,
    gate,
    unmount,
    pushReveals: (rows) => rerender({ rows }),
  };
}

/** 放进房闸门并等状态落成 connected */
async function connect(harness: Harness): Promise<void> {
  harness.gate.release();
  await waitFor(() => {
    expect(harness.result.current.status).toBe('connected');
  });
  // 真页面里第一份**非 null** 的 `reveals` 来自连接建立时 `subscribe` 同步推的那一份快照，
  // 这里跟着补一次，否则测试看到的是「永远没见过快照」，与牌桌页不是一回事
  harness.pushReveals(harness.room.snapshot().reveals);
}

describe('事件流进队列、队列状态回流组件', () => {
  it('事件到达即遮罩，播完自动放行', async () => {
    const harness = setup();
    const { room, probe, result } = harness;
    await connect(harness);
    expect(result.current.blocked).toBe(false);

    act(() => {
      room.pushEvent({ t: 'shuffle' });
    });
    expect(result.current.blocked).toBe(true);
    expect(probe.plans.map((plan) => plan.kind)).toEqual(['shuffle']);

    act(probe.finish);
    expect(result.current.blocked).toBe(false);
  });

  /**
   * 总线存在的理由，也是这条最容易写错的保证。
   *
   * 牌桌页里导演的订阅 effect 和自动进房 effect 在**同一个 commit** 跑，而进房要等一个
   * promise。要是 `onEvent` 直接读当时那条连接（`connectionRef.current` 还是 null），
   * 导演拿到的是一个空退订，此后**一段动画都不会播**，界面永远不会灰按钮。
   * 上面那条用例如果把订阅时机改晚一点就能侥幸通过，所以这里单独钉一次顺序。
   */
  it('订阅发生在连接建立之前，连上之后事件照样进队列', async () => {
    const harness = setup();
    const { room, probe, result } = harness;
    // 闸门还没放：进房已经 started（状态是 connecting），但连接还没到手
    await flush();
    expect(result.current.status).toBe('connecting');

    act(() => {
      room.pushEvent({ t: 'shuffle' });
    });
    expect(probe.plans).toHaveLength(0);

    await connect(harness);
    act(() => {
      room.pushEvent({ t: 'shuffle' });
    });
    expect(probe.plans).toHaveLength(1);
    expect(result.current.blocked).toBe(true);
  });

  /**
   * 卸载后必须真的退订。后果不是内存泄漏这么简单：玩家离开牌桌回到大厅，服务端那边还在广播，
   * 队列就会在一个已经不存在的画面层上继续排动画。
   */
  it('卸载之后再来事件，一段都不排', async () => {
    const harness = setup();
    const { room, probe, unmount } = harness;
    await connect(harness);
    act(() => {
      room.pushEvent({ t: 'shuffle' });
    });
    expect(probe.plans).toHaveLength(1);

    unmount();
    // 卸载时正在播的那一段落终态（画面层已经不在了，半张牌比没牌更糟）
    expect(probe.settled).toEqual([1]);
    act(() => {
      room.pushEvent({ t: 'shuffle' });
    });
    expect(probe.plans).toHaveLength(1);
  });

  it('掉线瞬间遮罩塌回终态，没播完的那段落终态而不是丢在半空', async () => {
    const harness = setup();
    const { room, probe, result } = harness;
    await connect(harness);
    act(() => {
      room.pushEvent({ t: 'shuffle' });
    });
    expect(result.current.blocked).toBe(true);

    act(() => {
      room.dropConnection();
    });
    expect(result.current.blocked).toBe(false);
    expect(probe.settled).toEqual([1]);
  });

  it('倍速与跳过从控制对象可达，状态跟着变', async () => {
    const harness = setup();
    const { room, probe, result } = harness;
    await connect(harness);
    act(() => {
      result.current.setSpeed(ANIM_SPEED_FAST);
    });
    expect(result.current.speed).toBe(ANIM_SPEED_FAST);

    act(() => {
      room.pushEvent({ t: 'shuffle' });
    });
    act(() => {
      result.current.skip();
    });
    expect(result.current.blocked).toBe(false);
    expect(probe.settled).toEqual([1]);
  });

  it('大厅里（还没有任何连接）挂上也不炸', () => {
    const client: GameClient = {
      createRoom: async () => {
        throw new Error('不该在这里建房');
      },
      joinRoom: async () => {
        throw new Error('不该在这里进房');
      },
    };
    const probe = createProbe();
    const { result } = renderHook(() => useAnimDirector(probe.renderer, null), {
      wrapper: function Wrapper({ children }: { children: ReactNode }) {
        return <RoomProvider client={client}>{children}</RoomProvider>;
      },
    });
    expect(result.current.blocked).toBe(false);
    expect(result.current.speed).toBe(1);
  });
});

/**
 * 摊牌亮牌的入队。
 *
 * 它是整套动画里唯一**不由广播事件驱动**的一段（D-002 / D-013：别人的底牌只能定向发，
 * 广播流里根本没有这条事件），所以只能从快照 `reveals` 的增量里推。
 * 「增量」这件事有两个方向都会出错：把首次观察当增量就是刷新页面重播一遍历史，
 * 把增量当首次就是别人亮了牌画面却毫无反应——两头都得钉。
 */
describe('摊牌亮牌从快照增量入队', () => {
  const reveals = (harness: Harness): AnimPlan[] => harness.probe.plans.filter((plan) => plan.kind === 'reveal');

  it('连接那份快照里已经亮着的牌只对齐基线，不补播', async () => {
    // 刷新 / 断线重连进摊牌：连接一到手，`subscribe` 同步推的那份快照里就已经带着
    // 亮过牌的那两个人。这一刻不能翻——玩家要的是当前局面，不是上一手的表演，
    // 而且这一段动画会把操作按钮按灰一小会儿。
    const harness = setup();
    act(() => {
      harness.room.patch({ reveals: [revealRow(3), revealRow(5)] });
    });
    await connect(harness);
    expect(reveals(harness)).toHaveLength(0);

    // 同一个 patch 内容再来一次（后续动作会带着同一批 `reveals` 重复推）
    harness.pushReveals([revealRow(3), revealRow(5)]);
    expect(reveals(harness)).toHaveLength(0);

    // 基线之上的那一个人才是增量：这一条要是也 0 段，就是"把增量当首次"
    harness.pushReveals([revealRow(3), revealRow(5), revealRow(7)]);
    expect(reveals(harness)).toHaveLength(1);
  });

  it('新亮出来的那一行入队一段，段里只带新行', async () => {
    const harness = setup();
    await connect(harness);
    harness.pushReveals([revealRow(3)]);

    const plans = reveals(harness);
    expect(plans).toHaveLength(1);
    if (plans[0]?.event.t !== 'reveal') throw new Error('期望是一条 reveal 计划');
    expect(plans[0].event.rows.map((row) => row.playerId)).toEqual(['p-3']);
  });

  it('一次 patch 里同时亮三个人仍是一段：摊牌不该被拉成三倍长', async () => {
    const harness = setup();
    await connect(harness);
    harness.pushReveals([revealRow(1), revealRow(4), revealRow(6)]);

    const plans = reveals(harness);
    expect(plans).toHaveLength(1);
    if (plans[0]?.event.t !== 'reveal') throw new Error('期望是一条 reveal 计划');
    expect(plans[0].event.rows).toHaveLength(3);
  });

  it('已经翻过的人再进一次 patch 不会重播；新一手清空后同一个人可以再翻', async () => {
    const harness = setup();
    await connect(harness);
    harness.pushReveals([revealRow(3)]);
    expect(reveals(harness)).toHaveLength(1);

    // 后续动作（别人下注）带着同一批 reveals 又推一次
    harness.pushReveals([revealRow(3), revealRow(5)]);
    expect(reveals(harness)).toHaveLength(2);

    // 下一手开始：reveals 清空
    harness.pushReveals(NO_REVEALS);
    expect(reveals(harness)).toHaveLength(2);
    harness.pushReveals([revealRow(3)]);
    expect(reveals(harness)).toHaveLength(3);
  });
});
