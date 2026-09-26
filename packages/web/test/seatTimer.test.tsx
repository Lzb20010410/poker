/**
 * 行动者的提示件（M3.5）：呼吸光圈 + 倒计时环。
 *
 * SPEC §3.2 给 `turn:change` 那一行写的是「目标座位呼吸光圈（CSS animation 循环）+
 * 倒计时环（SVG `stroke-dashoffset`，由 `deadline` 驱动）」，§4.3 把这两样列进座位组件的
 * 内容清单。它们一个住在 CSS 里、一个住在 SVG 里，**恰好都是 jsdom 看不见的东西**，
 * 所以这里的断言全部挑「看不见、但写坏了会立刻咬人」的那几条：
 *
 * 1. **环走的是服务端那条时间轴**。`deadline` 是服务端时钟下的绝对时刻，本地时间要先加
 *    `clockOffsetMs` 才能和它相减。符号写反一次的后果是玩家看到一圈还剩 20 秒、服务端
 *    早已把他超时弃牌——而这恰好是肉眼最难发现的那种错（本机偏移通常只有几毫秒）。
 * 2. **它是时间戳的函数，不是「每秒减一」的累积**。所以刷新 / 切后台回来必须直接跳到
 *    正确答案，而不是从满环重走一遍（M3.5 验收线的原话）。
 * 3. **环真的画得出来**。`stroke-dashoffset` 只对**描边**有效，样式表里漏一句 `stroke`
 *    就是一片透明：DOM 结构、属性值全对，屏幕上什么都没有，而且没有任何单测会红。
 *    所以这里去读 `global.css` 的文本，把「JSX 挂的类名有主人」钉住
 *    （`cardFaces.test.ts` 读文件是同一个道理）。
 *
 * 环的粗细、颜色好不好看仍归 `/dev/replay` 的肉眼活（D-028）。
 */

import { act, render, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ACTION_WARNING_SEC } from '@poker-room/shared/view';

import type { HandPlayerView, RoomSnapshot } from '../src/net/types';
import { SeatList } from '../src/table/components/SeatList';
import { FALLBACK_STAGE, layoutTable } from '../src/table/layout';
import { fakePlayer, fakeSnapshot } from './fakeClient';

/** 一个固定的「服务端时刻」。用真墙上时钟的话，`deadline` 与 `Date.now()` 的差会随测试跑多久而漂 */
const T0 = 1_780_000_000_123;
/** 默认行动时限（`DEFAULT_TABLE_CONFIG.actionTimeoutSec`），环的分母就是它 */
const TIMEOUT_MS = 30_000;

const me = fakePlayer('self', '我', true, { seatIndex: 0, chips: 1000 });
const peer = fakePlayer('peer-2', '老王', false, { seatIndex: 1, chips: 1800 });

function hand(playerId: string, seatIndex: number, nickname: string): HandPlayerView {
  return {
    playerId,
    seatIndex,
    nickname,
    avatarSeed: `seed-${playerId}`,
    folded: false,
    allIn: false,
    sittingOut: false,
    hasActed: false,
    committedThisStreet: 0,
    committedTotal: 0,
  };
}

function tableSnapshot(overrides: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return fakeSnapshot('K7QM3D', {
    players: [me, peer],
    handPlayers: [hand('self', 0, '我'), hand('peer-2', 1, '老王')],
    phase: 'PREFLOP',
    mySeat: 0,
    currentTurn: 0,
    isMyTurn: true,
    deadline: T0 + TIMEOUT_MS,
    clockOffsetMs: 0,
    potTotal: 30,
    currentBet: 20,
    ...overrides,
  });
}

const LAYOUT = layoutTable({ ...FALLBACK_STAGE, capacity: 8 });

function seatList(snapshot: RoomSnapshot) {
  return (
    <SeatList
      snapshot={snapshot}
      layout={LAYOUT}
      seatEmotes={[]}
      disabled={false}
      onSit={() => {}}
      onStand={() => {}}
      onRebuy={() => {}}
    />
  );
}

/** 挂上去，交回三个「问某一格」的探针 */
function mountTable(snapshot: RoomSnapshot) {
  const { container } = render(seatList(snapshot));
  /** 某个名字的座位格子。断言一律限定在这一格，免得「别处也有」蒙过去 */
  const seatOf = (nickname: string): HTMLElement => {
    const row = within(container).getByText(nickname).closest('li');
    if (row === null) throw new Error(`${nickname} 不在任何座位格子里`);
    return row;
  };
  return {
    container,
    /** 那一格有没有环 */
    ringOf: (nickname: string): Element | null => seatOf(nickname).querySelector('.seat__ring'),
    /** 环已经走过多少：`stroke-dashoffset / stroke-dasharray`，0 = 满环、1 = 走完 */
    swept: (nickname: string): number => {
      const el = seatOf(nickname).querySelector('.seat__ring__progress');
      if (el === null) throw new Error(`${nickname} 这一格没有进度描边`);
      const dash = Number(el.getAttribute('stroke-dasharray'));
      const offset = Number(el.getAttribute('stroke-dashoffset'));
      // 属性缺失时 Number() 给 NaN，`dash > 0` 一起挡掉：漏写 dasharray 不该被当成「比例为 0」
      expect(Number.isFinite(dash) && dash > 0 && Number.isFinite(offset)).toBe(true);
      return offset / dash;
    },
    /** 警告态挂在环自己身上（换描边色 + 闪烁），不是挂在整格上 */
    warnOf: (nickname: string): Element | null => seatOf(nickname).querySelector('.seat__ring--warn'),
  };
}

/** 把 fake 时钟往前推，并让 React 把这一段时间里所有 tick 都消化掉（不包 act 会刷一屏警告） */
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

const CSS = readFileSync(resolve('src/styles/global.css'), 'utf8');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('倒计时环 · 谁身上有', () => {
  it('只有轮到的那一格有环', () => {
    const table = mountTable(tableSnapshot());
    expect(table.ringOf('我')).not.toBeNull();
    expect(table.ringOf('老王')).toBeNull();
  });

  it('没轮到人（deadline 为 null）时不画环：一圈永远不动的装饰比没有更糟', () => {
    const table = mountTable(tableSnapshot({ currentTurn: null, isMyTurn: false, deadline: null }));
    expect(table.container.querySelector('.seat__ring')).toBeNull();
  });

  it('环不给读屏念：秒数已经由 `.table-timer` 那句话说了', () => {
    const table = mountTable(tableSnapshot());
    expect(table.ringOf('我')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('倒计时环 · 走的是哪条时间轴', () => {
  it('时限刚开始时是满环', () => {
    const table = mountTable(tableSnapshot());
    expect(table.swept('我')).toBeCloseTo(0, 2);
  });

  it('过了 10 秒就走过 1/3（分母是 config.actionTimeoutSec，不是前端自己猜的 20 秒）', () => {
    const table = mountTable(tableSnapshot());
    advance(10_000);
    expect(table.swept('我')).toBeCloseTo(10_000 / TIMEOUT_MS, 2);
  });

  it('服务端时钟比本地快 5 秒时，环按服务端的读法来', () => {
    const table = mountTable(tableSnapshot({ clockOffsetMs: 5_000 }));
    // 本地此刻是 T0，服务端已经 T0+5000：还剩 25 秒，也就是已经走过 5 秒
    expect(table.swept('我')).toBeCloseTo(5_000 / TIMEOUT_MS, 2);
  });

  it('刷新后一挂上就是当前值，不从满环重走：环读的是时间戳差值，不是本地累计', () => {
    const first = mountTable(tableSnapshot());
    advance(25_000);
    expect(first.swept('我')).toBeCloseTo(25_000 / TIMEOUT_MS, 2);

    // 重新挂载 = 刷新页面。时间没有倒退回去，环也就不会从满环重播一次
    const again = mountTable(tableSnapshot());
    expect(again.swept('我')).toBeCloseTo(25_000 / TIMEOUT_MS, 2);
  });

  it('超时之后停在走完，不反着多出一截', () => {
    const table = mountTable(tableSnapshot());
    advance(TIMEOUT_MS + 4_000);
    expect(table.swept('我')).toBeCloseTo(1, 3);
  });
});

describe('倒计时环 · 最后 10 秒', () => {
  it('还剩 10 秒以上时不带警告态', () => {
    const table = mountTable(tableSnapshot());
    advance(TIMEOUT_MS - ACTION_WARNING_SEC * 1000 - 2_000);
    expect(table.warnOf('我')).toBeNull();
  });

  it('进入最后 10 秒（`ACTION_WARNING_SEC`）后环进入警告态', () => {
    const table = mountTable(tableSnapshot());
    advance(TIMEOUT_MS - ACTION_WARNING_SEC * 1000 + 500);
    expect(table.warnOf('我')).not.toBeNull();
  });
});

/**
 * CSS 侧的三条。为什么在这里读样式表而不是只断言类名：这一组视觉件**全部**住在
 * `global.css` 里，「JSX 挂了类名、样式表里没人」是一个 DOM 全绿、屏幕全黑的失败模式，
 * 而 `seatContent.test.tsx` 那类别名断言恰好挡不住它。
 */
describe('呼吸光圈与环 · 样式表里真的有主人', () => {
  it('.seat--acting 挂着一个无限循环的 animation，且指向一个真的 @keyframes', () => {
    const acting = /\.seat--acting\s*\{([^}]*)\}/.exec(CSS);
    expect(acting).not.toBeNull();
    const animation = /animation:\s*([\w-]+)[^;]*infinite/.exec(acting?.[1] ?? '');
    expect(animation).not.toBeNull();
    expect(CSS).toContain(`@keyframes ${animation?.[1]}`);
  });

  it('环的三条描边都在（漏了 stroke 就是一片透明）', () => {
    expect(CSS).toMatch(/\.seat__ring__track\s*\{[^}]*stroke:/);
    expect(CSS).toMatch(/\.seat__ring__progress\s*\{[^}]*stroke:/);
    expect(CSS).toMatch(/\.seat__ring--warn[^{]*\{[^}]*stroke:/);
  });

  it('环绝对定位在头像那一格里，不参与座位排版：座位框的无重叠验算只管盒子，挤进内容会把昵称顶出去', () => {
    expect(CSS).toMatch(/\.seat__ring\s*\{[^}]*position:\s*absolute/);
    expect(CSS).toMatch(/\.seat__ring\s*\{[^}]*pointer-events:\s*none/);
  });
});
