/**
 * 表情气泡（M3.5）。SPEC §4.3 把它列在座位组件的内容清单最后一行，§3.2 的动画表里没有它——
 * 因为它**不是**一段要排队播的表演：一条 `player:emoji` 是「这人刚表达了点什么」，
 * 它该立刻出现在那一格上、两秒后自己消失，而不是排在发牌动画后面三秒才冒出来，
 * 更不是那三秒里把操作按钮按住。所以 `planEvent` 对它返回 `null`（不占队列）是对的，
 * 缺的是接收端：事件在 `net/events.ts` 里判完形状之后就没人在了。
 *
 * ## 这里钉住的四件事
 *
 * 1. **落在哪一格**：事件带的是座位号，气泡就该出现在那一格，别处不该有。
 * 2. **会自己消失**：不消失的表情一直贴在座位上，玩家会以为还在等那个人表态。
 * 3. **只认服务端给的那四个 id**：`protocol.ts` 里 `emoji` 的类型是 `string`
 *    （服务端只保证"这是一条文本"），前端拿它去查文案表，查不到就当没收到——
 *    把未知字符串直接刷到牌桌上，等于给不属于牌桌的内容开一个显示位。
 * 4. **发的和收的是同一份文案**：表情条上写「大笑」，别人屏幕上冒出来的也得是「大笑」。
 *    两头都从 `EmoteBar` 那张表读，所以这里把同一句字面量在两端各断言一次。
 *
 * 时钟的用法沿用 `table.test.tsx` 那一组倒计时用例：先用真时钟把页面挂起来，
 * 再切到 fake timers 掐这一条要测的那段。
 */

import { act, render, screen, within, type RenderResult } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RoomSnapshot } from '../src/net/types';
import { SeatList } from '../src/table/components/SeatList';
import { FALLBACK_STAGE, layoutTable } from '../src/table/layout';
import { TablePage } from '../src/table/TablePage';
import { EMOTE_TTL_MS } from '../src/table/useSeatEmotes';
import { createFakeClient, fakePlayer, fakeSnapshot, FULL_LEGAL, type FakeRoomHandle } from './fakeClient';
import { renderWithProviders, resetWebState, seedProfile, TEST_PROFILE } from './harness';

const CODE = 'K7QM3D';
const me = fakePlayer('self', TEST_PROFILE.nickname, true, { seatIndex: 0, isHost: true, legal: FULL_LEGAL });
const peer = fakePlayer('peer-2', '老王', false, { seatIndex: 1, chips: 1800 });

const LAYOUT = layoutTable({ ...FALLBACK_STAGE, capacity: 8 });

/**
 * 某一格里的气泡文案，没有则 null。
 *
 * 一律先在 `.seats--ring` 里找名字，而不是整页找：`TEST_PROFILE.nickname` 在牌桌上
 * 至少出现两次（座位格 + 顶部身份条），`getByText` 会直接报「found multiple elements」。
 * 断言也顺带限定在这一格，免得「别处也有」蒙过去。
 */
function emoteOf(container: HTMLElement, nickname: string): string | null {
  const ring = container.querySelector<HTMLElement>('.seats--ring');
  if (ring === null) throw new Error('这一页没有座位环');
  const row = within(ring).getByText(nickname).closest('li');
  if (row === null) throw new Error(`${nickname} 不在任何座位格子里`);
  const bubble = row.querySelector('.seat__emote');
  return bubble === null ? null : (bubble.textContent ?? '');
}

describe('表情气泡 · 组件层（给什么座位亮什么格子）', () => {
  function mount(snapshot: RoomSnapshot, seatEmotes: readonly { seatIndex: number; label: string }[]) {
    return render(
      <SeatList
        snapshot={snapshot}
        layout={LAYOUT}
        seatEmotes={seatEmotes}
        disabled={false}
        onSit={() => {}}
        onStand={() => {}}
        onRebuy={() => {}}
      />,
    );
  }

  const base = fakeSnapshot(CODE, { players: [me, peer], mySeat: 0 });

  it('气泡只出现在事件带来的那一格上', () => {
    const { container } = mount(base, [{ seatIndex: 1, label: '大笑' }]);
    expect(emoteOf(container, '老王')).toBe('大笑');
    expect(emoteOf(container, TEST_PROFILE.nickname)).toBeNull();
  });

  it('没有表情时一格气泡都不画', () => {
    const { container } = mount(base, []);
    expect(container.querySelector('.seat__emote')).toBeNull();
  });
});

describe('表情气泡 · 接收端（事件 → 气泡 → 自己消失）', () => {
  let page: RenderResult;

  beforeEach(() => {
    resetWebState();
    seedProfile();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetWebState();
  });

  /** 挂整页 → 推进到「我和老王都坐下、轮到我」→ 切到 fake timers 交回房间句柄 */
  async function openTable(): Promise<FakeRoomHandle> {
    const fake = createFakeClient();
    page = renderWithProviders(
      `/t/${CODE}`,
      <Routes>
        <Route path="/" element={null} />
        <Route path="/t/:code" element={<TablePage />} />
      </Routes>,
      { client: fake.client },
    );
    await screen.findByRole('heading', { name: `牌桌 ${CODE}` });
    const room = fake.rooms.get(CODE);
    if (room === undefined) throw new Error(`假 client 里没有房间 ${CODE}`);
    act(() => {
      room.pushPlayers([me, peer]);
      room.patch({ isMyTurn: true, currentTurn: 0, mySeat: 0, phase: 'PREFLOP', potTotal: 30, currentBet: 20 });
    });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    return room;
  }

  function pushEvent(room: FakeRoomHandle, event: unknown): void {
    act(() => {
      room.pushEvent(event);
    });
  }

  function bubble(): Element | null {
    return page.container.querySelector('.seat__emote');
  }

  it('收到 player:emoji 就在对应座位冒出来，文案与表情条上同一份表', async () => {
    const room = await openTable();
    // 发的一端：表情条上确实有一枚按钮叫「大笑」
    expect(screen.getByRole('button', { name: '大笑' })).toBeInTheDocument();
    pushEvent(room, { t: 'player:emoji', seatIndex: 1, emoji: 'laugh' });
    // 收的一端：同一句话出现在老王那一格上，而不在我这一格
    expect(bubble()?.textContent).toBe('大笑');
    expect(emoteOf(page.container, '老王')).toBe('大笑');
    expect(emoteOf(page.container, TEST_PROFILE.nickname)).toBeNull();
  });

  it(`到点自己消失（${EMOTE_TTL_MS}ms 之后不留残留）`, async () => {
    const room = await openTable();
    pushEvent(room, { t: 'player:emoji', seatIndex: 1, emoji: 'laugh' });
    expect(bubble()).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(EMOTE_TTL_MS);
    });
    expect(bubble()).toBeNull();
  });

  it('同一个人连发两条：后一条把前一条换掉，而不是叠两层', async () => {
    const room = await openTable();
    pushEvent(room, { t: 'player:emoji', seatIndex: 1, emoji: 'laugh' });
    pushEvent(room, { t: 'player:emoji', seatIndex: 1, emoji: 'angry' });
    expect(page.container.querySelectorAll('.seat__emote')).toHaveLength(1);
    expect(bubble()?.textContent).toBe('生气');
  });

  it('两个不同的人各发一条：两格各自亮各自的，各自的时钟也各自走', async () => {
    const room = await openTable();
    pushEvent(room, { t: 'player:emoji', seatIndex: 1, emoji: 'laugh' });
    act(() => {
      vi.advanceTimersByTime(EMOTE_TTL_MS - 500);
    });
    pushEvent(room, { t: 'player:emoji', seatIndex: 0, emoji: 'wave' });
    expect(page.container.querySelectorAll('.seat__emote')).toHaveLength(2);

    // 再过 600ms：第一条总共走完（TTL-500 又 600 = 超期 100ms），第二条还剩 400ms
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(page.container.querySelectorAll('.seat__emote')).toHaveLength(1);
    expect(bubble()?.textContent).toBe('挥手');
  });

  it('服务端给一个不认识的 emoji id 时什么都不画：牌桌的显示位不给别的东西', async () => {
    const room = await openTable();
    pushEvent(room, { t: 'player:emoji', seatIndex: 1, emoji: 'check-engine-light' });
    expect(bubble()).toBeNull();
  });

  it('发给一个桌上没有的座位号时不炸也不画，牌桌照常可玩', async () => {
    const room = await openTable();
    pushEvent(room, { t: 'player:emoji', seatIndex: 7, emoji: 'laugh' });
    expect(bubble()).toBeNull();
    expect(screen.getByRole('button', { name: /跟注/ })).toBeEnabled();
  });

  it('气泡活过一次快照更新：它是"刚才发生了什么"，不在服务端的状态里', async () => {
    const room = await openTable();
    pushEvent(room, { t: 'player:emoji', seatIndex: 1, emoji: 'laugh' });
    act(() => {
      room.patch({ potTotal: 90 });
    });
    expect(bubble()?.textContent).toBe('大笑');
  });
});
