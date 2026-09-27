/**
 * 音效的 React 接线（M4.2 验收 ①②③ 就在这一层成立）。
 *
 * 纯层各管一件事：`player.ts` 管「没有手势就不许碰 AudioContext」，`cues.ts` 管
 * 「什么时候响哪一声」，`settings.ts` 管「静音档存哪」。这一层把它们接进 React 的
 * 生命周期，所以这里测的是**接线的顺序和条件**。
 *
 * 关键取巧：注入的播放器不是记录调用的假货，而是**真播放器 + 假上下文**
 * （`createSoundPlayer` over `FakeAudio`）。于是断言的都是真门禁下的真结果：
 *
 * - `opens`（构造过几枚上下文）—— 验收「首次加载不触发浏览器自动播放警告」；
 * - `heard`（哪些声音真的排进了调度器）—— 未解锁时真播放器自己会吞掉，
 *   所以这一列同时证明了门禁生效，而不是证明"我们的假货记性很好"。
 *
 * 另外钉住的几件：静音时连 `openAudioContext` 都不被调用（不占 iOS 那几枚名额）、
 * 取消静音的那一次点击当场响一声（手机 Safari 上不用等下一手牌就能确认出声）、
 * 开关状态写进 localStorage（刷新后保持）、掉线期间一声不响。
 */

import { act, fireEvent, render, screen, type RenderResult } from '@testing-library/react';
import { type ReactNode } from 'react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RoomSnapshot } from '../src/net/types';
import { createSoundPlayer, type SoundPlayer } from '../src/sound/player';
import type { SoundName } from '../src/sound/synth';
import { SOUND_MUTED_KEY } from '../src/sound/settings';
import { SoundToggle } from '../src/sound/SoundToggle';
import { TablePage } from '../src/table/TablePage';
import { SoundProvider, useSound } from '../src/state/SoundContext';
import { createFakeClient, fakePlayer, FULL_LEGAL, type FakeRoomHandle } from './fakeClient';
import { FakeAudio } from './fakeAudio';
import { renderWithProviders, resetWebState, seedProfile, TEST_PROFILE } from './harness';

/**
 * 真播放器 + 假上下文，套一层能记账的壳。
 *
 * 壳是给 `SoundProvider` 当 `player` 注入用的：Provider 和播放器之间的每一次调用
 * 都从这儿过，于是 `heard` 记的是「真门禁放行、并且真的排进了调度器」的那几声——
 * 未解锁时 `real.play` 自己会吞掉（振荡器数量不动），所以这一列同时证明了门禁生效，
 * 而不是证明"我们的假货记性很好"。
 */
function sounding() {
  const audio = new FakeAudio();
  let opens = 0;
  const real = createSoundPlayer({
    openAudioContext: () => {
      opens += 1;
      return audio;
    },
  });
  const heard: SoundName[] = [];
  const player: SoundPlayer = {
    unlock: () => real.unlock(),
    play: (name) => {
      const before = audio.oscillators.length;
      real.play(name);
      if (audio.oscillators.length > before) heard.push(name);
    },
  };
  return {
    player,
    audio,
    heard,
    opens: (): number => opens,
    clear: (): void => {
      heard.length = 0;
    },
  };
}

type Sounding = ReturnType<typeof sounding>;

/** 直接读 context 的探针：在 Provider 内部触发 play，绕开页面上那些按钮 */
function Probe(): ReactNode {
  const { play } = useSound();
  return (
    <button type="button" onClick={() => play('chip')}>
      播一声
    </button>
  );
}

/** 页头那个开关（单独挂载，不经过 AppShell） */
function mountToggle(sounding: Sounding): RenderResult {
  return render(
    <SoundProvider player={sounding.player}>
      <SoundToggle />
    </SoundProvider>,
  );
}

function mountProbe(sounding: Sounding): RenderResult {
  return render(
    <SoundProvider player={sounding.player}>
      <Probe />
    </SoundProvider>,
  );
}

describe('音效接线 · 手势与自动播放', () => {
  let s: Sounding;

  beforeEach(() => {
    resetWebState();
    s = sounding();
  });

  afterEach(() => {
    resetWebState();
  });

  it('挂载本身一枚上下文都不建，一声都不响', async () => {
    mountProbe(s);
    expect(s.opens()).toBe(0);
    expect(s.heard).toEqual([]);
  });

  it('第一次点击才建上下文（那一下就是用户手势）', async () => {
    mountProbe(s);
    fireEvent.pointerDown(window);
    expect(s.opens()).toBe(1);
  });

  it('键盘玩家的那一下也算手势', async () => {
    mountProbe(s);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(s.opens()).toBe(1);
  });

  it('解锁之前 play 什么都不做（玩家还没碰过屏幕，牌桌自己开打了也不许响）', async () => {
    mountProbe(s);
    fireEvent.click(screen.getByRole('button', { name: '播一声' }));
    expect(s.heard).toEqual([]);
    expect(s.opens()).toBe(0);
  });

  it('解锁之后照常出声，而且全程只建一枚上下文', async () => {
    mountProbe(s);
    fireEvent.pointerDown(window);
    fireEvent.click(screen.getByRole('button', { name: '播一声' }));
    fireEvent.click(screen.getByRole('button', { name: '播一声' }));
    expect(s.heard).toEqual(['chip', 'chip']);
    expect(s.opens()).toBe(1);
  });

  it('静音时手势和播放都不碰播放器：不建上下文，iOS 的名额留给要响的东西', async () => {
    window.localStorage.setItem(SOUND_MUTED_KEY, 'muted');
    mountProbe(s);
    fireEvent.pointerDown(window);
    fireEvent.click(screen.getByRole('button', { name: '播一声' }));
    expect(s.opens()).toBe(0);
    expect(s.heard).toEqual([]);
  });

  it('组件卸载后，窗口上的手势不再碰播放器', async () => {
    const view = mountProbe(s);
    view.unmount();
    fireEvent.pointerDown(window);
    expect(s.opens()).toBe(0);
  });
});

describe('音效接线 · 开关与持久化', () => {
  let s: Sounding;

  beforeEach(() => {
    resetWebState();
    s = sounding();
  });

  afterEach(() => {
    resetWebState();
  });

  it('默认是开的，页头上看得见当前状态', async () => {
    mountToggle(s);
    expect(screen.getByRole('button', { name: '音效：开' })).toBeInTheDocument();
  });

  it('点一下变成关，同时写进 localStorage（刷新后保持）', async () => {
    mountToggle(s);
    fireEvent.click(screen.getByRole('button', { name: '音效：开' }));
    expect(screen.getByRole('button', { name: '音效：关' })).toBeInTheDocument();
    expect(window.localStorage.getItem(SOUND_MUTED_KEY)).toBe('muted');
  });

  it('重新挂载时从 localStorage 恢复「关」，并且一声都不响', async () => {
    window.localStorage.setItem(SOUND_MUTED_KEY, 'muted');
    mountToggle(s);
    expect(screen.getByRole('button', { name: '音效：关' })).toBeInTheDocument();
    fireEvent.pointerDown(window);
    expect(s.opens()).toBe(0);
  });

  it('取消静音的那一次点击当场响一声（手机上不必等下一手牌就能确认真的出声）', async () => {
    window.localStorage.setItem(SOUND_MUTED_KEY, 'muted');
    mountToggle(s);
    fireEvent.click(screen.getByRole('button', { name: '音效：关' }));
    expect(s.heard).toEqual(['turn']);
    expect(window.localStorage.getItem(SOUND_MUTED_KEY)).toBe('audible');
    expect(screen.getByRole('button', { name: '音效：开' })).toBeInTheDocument();
  });

  it('Provider 外面用 useSound 直接抛错，不悄悄退回"什么都不响"', async () => {
    expect(() => render(<Probe />)).toThrow(/SoundProvider/);
  });
});

describe('音效接线 · 牌桌', () => {
  const CODE = 'K7QM3D';
  const me = fakePlayer('self', TEST_PROFILE.nickname, true, { seatIndex: 0, isHost: true, legal: FULL_LEGAL });
  const peer = fakePlayer('peer-2', '老王', false, { seatIndex: 1, chips: 1800 });

  let s: Sounding;
  let room: FakeRoomHandle;

  beforeEach(() => {
    resetWebState();
    seedProfile();
    s = sounding();
  });

  afterEach(() => {
    resetWebState();
  });

  /** 挂整张牌桌（harness 注入 sound），推进到「我和老王都坐下、快照已到位」 */
  async function openTable(overrides: Partial<RoomSnapshot> = {}): Promise<FakeRoomHandle> {
    const fake = createFakeClient();
    renderWithProviders(
      `/t/${CODE}`,
      <Routes>
        <Route path="/" element={null} />
        <Route path="/t/:code" element={<TablePage />} />
      </Routes>,
      { client: fake.client, sound: s.player },
    );
    await screen.findByRole('heading', { name: `牌桌 ${CODE}` });
    const handle = fake.rooms.get(CODE);
    if (handle === undefined) throw new Error(`假 client 里没有房间 ${CODE}`);
    act(() => {
      handle.pushPlayers([me, peer]);
      handle.patch({ mySeat: 0, ...overrides });
    });
    room = handle;
    s.clear();
    return handle;
  }

  /** 玩家碰了第一下屏幕：这之后声音才被允许 */
  function gesture(): void {
    fireEvent.pointerDown(window);
  }

  function pushEvent(event: unknown): void {
    act(() => {
      room.pushEvent(event);
    });
  }

  function patch(changes: Partial<RoomSnapshot>): void {
    act(() => {
      room.patch(changes);
    });
  }

  it('刚进桌（还没碰过屏幕）一声都不响，上下文也不建', async () => {
    await openTable();
    pushEvent({ t: 'deal:start', count: 2, startSeat: 0 });
    patch({ isMyTurn: true, currentTurn: 0, phase: 'PREFLOP' });
    expect(s.opens()).toBe(0);
    expect(s.heard).toEqual([]);
  });

  it('解锁后，发牌 / 翻公共牌 / 筹码各响各的那一声', async () => {
    await openTable();
    gesture();
    pushEvent({ t: 'deal:start', count: 2, startSeat: 0 });
    pushEvent({
      t: 'board:deal',
      phase: 'flop',
      cards: [
        { rank: 14, suit: 's' },
        { rank: 13, suit: 'h' },
        { rank: 2, suit: 'd' },
      ],
    });
    pushEvent({ t: 'action:made', seatIndex: 1, action: { type: 'raise', totalBet: 120 }, chipsDelta: 100 });
    expect(s.heard).toEqual(['deal', 'board', 'chip']);
  });

  it('弃牌不响：没有筹码相碰，响就是骗人', async () => {
    await openTable();
    gesture();
    pushEvent({ t: 'action:made', seatIndex: 1, action: { type: 'fold' }, chipsDelta: 0 });
    expect(s.heard).toEqual([]);
  });

  it('轮到我响一声；同一步里再推几帧快照不重复响', async () => {
    await openTable();
    gesture();
    patch({ isMyTurn: true, currentTurn: 0, phase: 'PREFLOP' });
    expect(s.heard).toEqual(['turn']);
    patch({ potTotal: 60 });
    patch({ currentBet: 30 });
    expect(s.heard).toEqual(['turn']);
  });

  it('别人接手后再轮到我，第二次照样响', async () => {
    await openTable();
    gesture();
    patch({ isMyTurn: true, currentTurn: 0 });
    patch({ isMyTurn: false, currentTurn: 1 });
    patch({ isMyTurn: true, currentTurn: 0 });
    expect(s.heard).toEqual(['turn', 'turn']);
  });

  it('解锁前被吞掉的那一声不补播，但下一次跃迁照常响', async () => {
    // 刷新进来时正好轮到我：那一帧的声音确实丢了——浏览器在没有手势时不允许出声，
    // 这条没有绕过去的办法。值得钉住的是它**只丢一次**：解锁后轮转到别人再回到我，
    // 提示音就回来了。不去"补播"上一次跃迁是刻意的：那声「轮到你」会在玩家
    // 随便点第一下的时候冒出来，而那一下往往就是他自己正要动的操作。
    await openTable({ isMyTurn: true, currentTurn: 0 });
    gesture();
    expect(s.heard).toEqual([]);
    patch({ isMyTurn: false, currentTurn: 1 });
    patch({ isMyTurn: true, currentTurn: 0 });
    expect(s.heard).toEqual(['turn']);
  });

  it('这手我赢了响一声；同一手再推快照不重复响', async () => {
    await openTable({ handId: 'hand-7' });
    gesture();
    patch({
      results: [
        { playerId: 'self', seatIndex: 0, chips: 2400, delta: 400, handName: '两对' },
        { playerId: 'peer-2', seatIndex: 1, chips: 1600, delta: -400, handName: '高牌' },
      ],
    });
    expect(s.heard).toEqual(['win']);
    patch({ potTotal: 800 });
    expect(s.heard).toEqual(['win']);
  });

  it('赢的是别人时不响', async () => {
    await openTable({ handId: 'hand-7' });
    gesture();
    patch({
      results: [{ playerId: 'peer-2', seatIndex: 1, chips: 2600, delta: 800, handName: '葫芦' }],
    });
    expect(s.heard).toEqual([]);
  });

  it('下一手又赢了会再响（按 handId 去重，不按"这辈子只报一次"）', async () => {
    await openTable({ handId: 'hand-7' });
    gesture();
    patch({ results: [{ playerId: 'self', seatIndex: 0, chips: 2400, delta: 400, handName: '两对' }] });
    patch({ results: [] });
    patch({ handId: 'hand-8' });
    patch({ results: [{ playerId: 'self', seatIndex: 0, chips: 2800, delta: 400, handName: '顺子' }] });
    expect(s.heard).toEqual(['win', 'win']);
  });

  it('掉线期间不响「轮到你」：那时快照是过期的，那句提示早已不是事实', async () => {
    // 只钉快照那一路。广播事件那一路不用挡：socket 已经关了，断线期间压根不会有
    // 新事件到达（`onEvent` 也不重放，见 net/types.ts）。而 React 这边手里那份
    // 快照是**冻在掉线瞬间**的，它要是还能触发一声，喊的就是一个点不动的按钮。
    await openTable();
    gesture();
    s.clear();
    act(() => {
      room.dropConnection();
    });
    patch({ isMyTurn: true, currentTurn: 0 });
    expect(s.heard).toEqual([]);
  });

  it('静音时整桌一声不出，也不建上下文', async () => {
    window.localStorage.setItem(SOUND_MUTED_KEY, 'muted');
    s = sounding();
    await openTable();
    gesture();
    pushEvent({ t: 'deal:start', count: 2, startSeat: 0 });
    patch({ isMyTurn: true, currentTurn: 0 });
    expect(s.opens()).toBe(0);
    expect(s.heard).toEqual([]);
  });

  it('退回大厅后事件不再响：订阅随组件一起收掉', async () => {
    await openTable();
    gesture();
    s.clear();
    const handle = room;
    resetWebState();
    handle.pushEvent({ t: 'deal:start', count: 2, startSeat: 0 });
    expect(s.heard).toEqual([]);
  });
});
