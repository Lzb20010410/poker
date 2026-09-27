/**
 * 牌桌（`/t/:code`）的行为测试。
 *
 * 这一份是 M1.6 的核心验收：**前端只渲染、只上送，不判定**。
 * 所以所有断言都落在两件事上：
 *
 * 1. 界面亮不亮（由服务端的 `legal` 提示位 + `isMyTurn` + 连接状态决定）；
 * 2. 点下去之后**上送的那条 C2S 命令长什么样**（`handId` / `turnVersion` 必须带上，
 *    服务端靠它们拒绝过期动作）。
 *
 * 这里刻意不断言「点了跟注之后池变成多少」——那是规则引擎的事，
 * 在 `packages/shared` 里已经被测过；在 UI 层重复断言等于把前端变成第二套判定。
 *
 * 假 client 只提供快照和记录发送，不会自己算规则（见 `test/fakeClient.ts`）。
 */

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { C2S } from '@poker-room/shared';

import type { RoomSnapshot } from '../src/net/types';

import { FELT_COLORS } from '../src/assets/pokerTable';
import { LobbyPage } from '../src/lobby/LobbyPage';
import { FALLBACK_STAGE, layoutTable } from '../src/table/layout';
import { TablePage } from '../src/table/TablePage';
import {
  createFakeClient,
  FakeMatchMakeError,
  fakePlayer,
  fakeSnapshot,
  FULL_LEGAL,
  NO_LEGAL,
  type FakeClientHandle,
  type FakeRoomHandle,
} from './fakeClient';
import { renderWithProviders, resetWebState, seedProfile, TEST_PROFILE } from './harness';

const CODE = 'K7QM3D';

/** 我自己：0 号位、房主。和 `fakeSnapshot` 里的 myId / hostId = 'self' 对齐 */
const me = fakePlayer('self', TEST_PROFILE.nickname, true, { seatIndex: 0, isHost: true });
const other = fakePlayer('peer-2', '老王', false, { seatIndex: 1, chips: 1800 });

function renderTable(fake: FakeClientHandle): void {
  renderWithProviders(
    `/t/${CODE}`,
    <Routes>
      <Route path="/" element={<LobbyPage />} />
      <Route path="/t/:code" element={<TablePage />} />
    </Routes>,
    { client: fake.client },
  );
}

async function openTable(): Promise<FakeRoomHandle> {
  seedProfile();
  const fake = createFakeClient();
  renderTable(fake);
  await screen.findByRole('heading', { name: `牌桌 ${CODE}` });
  const room = fake.rooms.get(CODE);
  if (room === undefined) throw new Error(`假 client 里没有房间 ${CODE}`);
  // 自动进房后把我自己 + 一个对手放进 0/1 号位，下面所有测试都基于这套座位
  act(() => {
    room.pushPlayers([me, other]);
  });
  return room;
}

/** 轮到我、且服务端给了「什么都能做」的提示位 */
function myTurn(room: FakeRoomHandle, changes: Record<string, unknown> = {}): void {
  act(() => {
    room.patch({
      phase: 'PREFLOP',
      handId: 'h-1',
      handNo: 1,
      turnVersion: 3,
      mySeat: 0,
      currentTurn: 0,
      isMyTurn: true,
      currentBet: 20,
      potTotal: 30,
      players: [{ ...me, legal: FULL_LEGAL }, other],
      ...changes,
    });
  });
}

function sentCommands(room: FakeRoomHandle): readonly C2S[] {
  return room.sent;
}

/** 推一份新快照。假 client 是同步调订阅者的，所以必须包在 `act` 里 */
function patch(room: FakeRoomHandle, changes: Partial<RoomSnapshot>): void {
  act(() => {
    room.patch(changes);
  });
}

/** 某个名字的座位条目本体。用来把断言限定在这一格，避免「别处也有这个徽标」蒙混过关 */
function seatRow(nickname: string): HTMLElement {
  const name = screen.getByText(nickname);
  const row = name.closest('li');
  if (row === null) throw new Error(`${nickname} 不在任何座位条目里`);
  return row;
}

beforeEach(() => {
  resetWebState();
});

afterEach(() => {
  vi.useRealTimers();
  resetWebState();
});

describe('牌桌 · 进房与基本呈现', () => {
  it('直接打开牌桌链接就会自动进房，并显示座位和公共牌区域', async () => {
    const room = await openTable();
    expect(room.connection.code).toBe(CODE);
    expect(screen.getByText(TEST_PROFILE.nickname)).toBeInTheDocument();
    expect(screen.getByText('老王')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '公共牌' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '我的底牌' })).toBeInTheDocument();
  });

  it('没连上之前不渲染牌桌控件，只说「正在进入房间」', async () => {
    seedProfile();
    const fake = createFakeClient({ joinFailure: new Error('起不来') });
    renderTable(fake);
    expect(screen.queryByRole('button', { name: /弃牌/ })).not.toBeInTheDocument();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  /**
   * M4.1 的验收项：「服务端重启后前端显示"房间已失效"并引导回大厅，不白屏不卡死」。
   * 522 + `has been disposed.` 是探针实测到的服务端重启/房间解散形状（见 `net/client.ts` 的 `deadTokenReason`）。
   */
  it('这一桌确定没了时说「已失效」并给一条回大厅的路', async () => {
    seedProfile();
    const fake = createFakeClient({ joinFailure: new FakeMatchMakeError(522, 'room "K7QM3D" has been disposed.') });
    renderTable(fake);
    expect(await screen.findByRole('heading', { name: `牌桌 ${CODE} 已失效` })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '回大厅' })).toHaveAttribute('href', '/');
  });

  /**
   * 反向那条同样要紧：连不上服务端时那一桌**可能还在**，说「已失效」会把人赶去重开一桌。
   * 断言的是「没有那句话」，所以它不是上一句的复读——把 `roomIsGone` 判据去掉（任何错误都算失效）这句就红。
   */
  it('只是连不上服务端时不说失效，也不劝人回大厅重开', async () => {
    seedProfile();
    const fake = createFakeClient({ joinFailure: new TypeError('Failed to fetch') });
    renderTable(fake);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(/已失效/)).not.toBeInTheDocument();
  });

  it('空座位按 config.maxPlayers 补齐，房主能看见还差几个位子', async () => {
    await openTable();
    expect(screen.getAllByText('空座位')).toHaveLength(6);
  });
});

describe('牌桌 · 桌面几何上屏（M2.2）', () => {
  /**
   * 几何本身在 `tableLayout.test.ts` 里已经逐条算过了（无重叠、无溢出、顺时针…）。
   * 这一组只验另一件事：**组件把那份几何原样搬到了 DOM 上**，没有自己再偏移一次。
   * 所以断言的是「内联坐标 === `layoutTable()` 的输出」，而不是「看着没重叠」——
   * 后者在 jsdom 里根本量不出来（`getBoundingClientRect()` 全是 0），
   * 前者恰好证明这条链路没有第二套坐标。
   *
   * jsdom 量不到盒子时 `useStageSize()` 回退到 `FALLBACK_STAGE`，
   * 那一档尺寸也在几何用例里跑过同一套验算。
   */
  it('每个座位格的内联坐标逐格等于布局输出', async () => {
    await openTable();
    const layout = layoutTable({ ...FALLBACK_STAGE, capacity: 8 });
    const seats = screen.getAllByRole('listitem');
    expect(seats).toHaveLength(layout.seats.length);
    seats.forEach((seat, offset) => {
      const slot = layout.seats[offset];
      if (slot === undefined) throw new Error(`布局里没有 ${offset} 号格`);
      expect(seat.style.left).toBe(`${slot.x}px`);
      expect(seat.style.top).toBe(`${slot.y}px`);
      expect(seat.style.width).toBe(`${slot.w}px`);
      expect(seat.style.height).toBe(`${slot.h}px`);
    });
  });

  it('我坐在正下方那一格，空位仍然占着各自的格子', async () => {
    await openTable();
    const layout = layoutTable({ ...FALLBACK_STAGE, capacity: 8 });
    const seats = screen.getAllByRole('listitem');
    const mySlot = layout.seats[0];
    const selfSeat = seats[0];
    if (mySlot === undefined || selfSeat === undefined) throw new Error('座位环是空的');
    // 布局说「offset 0 在最下面」，界面说「这一格坐着我」——两条必须落在同一个 li 上
    expect(mySlot.y + mySlot.h).toBeCloseTo(Math.max(...layout.seats.map((slot) => slot.y + slot.h)), 6);
    expect(selfSeat).toHaveTextContent(TEST_PROFILE.nickname);
    expect(selfSeat.style.top).toBe(`${mySlot.y}px`);
  });

  it('桌面、五格公共牌与底池都在桌面上', async () => {
    await openTable();
    expect(screen.getByRole('img', { name: '牌桌桌面' })).toBeInTheDocument();
    expect(screen.getAllByLabelText('还没发到这一张')).toHaveLength(5);
    expect(screen.getByText('底池')).toBeInTheDocument();
  });

  it('桌面底色跟着服务端给的桌布走，前端不自选颜色', async () => {
    const room = await openTable();
    // 桌面是 `<img src="data:image/svg+xml,...">`，`encodeURIComponent` 会把 `#` 变成 `%23`，
    // 所以要 decode 回来才能按色值断言（见 `assets/pokerTable.ts` 的 `tableFeltDataUri`）。
    const feltSvg = () => {
      const src = screen.getByRole('img', { name: '牌桌桌面' }).getAttribute('src') ?? '';
      return decodeURIComponent(src);
    };
    expect(feltSvg()).toContain(FELT_COLORS.green);

    patch(room, { config: { ...fakeSnapshot(CODE).config, felt: 'blue' } });
    expect(feltSvg()).toContain(FELT_COLORS.blue);
    // 只换底色不够：渐变两端是按底色混出来的，一起变才说明整张桌子重画了
    expect(feltSvg()).not.toContain(FELT_COLORS.green);
  });
});

describe('牌桌 · 动作上送', () => {
  it('跟注上送 call，并带上当前 handId 与 turnVersion', async () => {
    const room = await openTable();
    myTurn(room);
    fireEvent.click(screen.getByRole('button', { name: /跟注/ }));
    expect(sentCommands(room)).toEqual([{ t: 'action', action: { type: 'call' }, handId: 'h-1', turnVersion: 3 }]);
  });

  it('弃牌 / 过牌 / 全下各自上送对应动作', async () => {
    const room = await openTable();
    // M2.4 起中间那颗按 `callAmount` 换文案：要跟就是「跟注 N」，不用跟才是「过牌」。
    // 所以想要过牌，fixture 必须真的把要跟的量降到 0，而不是只把 `canCheck` 打开。
    const checkable = { ...me, legal: { ...FULL_LEGAL, canCheck: true, callAmount: 0 } };
    // 第三颗同理：加得动注时它写的是「加注到 N」，只有短码（`canRaise` 关着）才整颗换成「全下」
    const shortStack = { ...me, legal: { ...checkable.legal, canRaise: false } };
    myTurn(room, { players: [checkable, other] });
    fireEvent.click(screen.getByRole('button', { name: '弃牌' }));
    // 每点一下把 turnVersion 推一格：上一步还悬着的时候第二个按钮本来就该被锁住
    //（那条规则单独有测试，见下面「同一步动作重复点只上送一次」）。
    myTurn(room, { turnVersion: 4, players: [checkable, other] });
    fireEvent.click(screen.getByRole('button', { name: '过牌' }));
    myTurn(room, { turnVersion: 5, players: [shortStack, other] });
    fireEvent.click(screen.getByRole('button', { name: '全下' }));
    expect(sentCommands(room).map((command) => command.t === 'action' && command.action.type)).toEqual([
      'fold',
      'check',
      'allIn',
    ]);
  });

  it('加注把输入框里的**总额**原样上送，不做增量换算', async () => {
    const room = await openTable();
    myTurn(room);
    fireEvent.change(screen.getByRole('spinbutton', { name: '加注到（总额）' }), { target: { value: '80' } });
    fireEvent.click(screen.getByRole('button', { name: '加注到 80' }));
    expect(sentCommands(room)).toEqual([
      { t: 'action', action: { type: 'raise', totalBet: 80 }, handId: 'h-1', turnVersion: 3 },
    ]);
  });

  /**
   * 这里和 M1.6 的行为**相反**，是有意的改动。
   *
   * 旧实现是「越界就不亮」，SPEC §4.4 要的是「标红提示，但仍允许发送」。
   * 差别不是手感而是责任：合法与否由服务端判，前端只负责把玩家按下的那个数原样送上去。
   * 界面自己拦一道，就多一处和服务端漂移的地方，而且漂移的方向恰好是「想下注却点不动」。
   * 标红与那句带范围的说明由 `actionPanel.test.tsx` 盯着，这里只锁上送的那条命令。
   */
  it('加注额低于服务端给的 minRaiseTotal 时界面标红，但照样把玩家要的那个数发出去', async () => {
    const room = await openTable();
    myTurn(room);
    fireEvent.change(screen.getByRole('spinbutton', { name: '加注到（总额）' }), { target: { value: '25' } });
    const raise = screen.getByRole('button', { name: '加注到 25' });
    expect(raise).toBeEnabled();
    fireEvent.click(raise);
    expect(sentCommands(room)).toEqual([
      { t: 'action', action: { type: 'raise', totalBet: 25 }, handId: 'h-1', turnVersion: 3 },
    ]);
  });

  /**
   * 加注框的「一步一清空」。
   *
   * 这一条锁的是行为，不是写法：草稿挂在 `handId:turnVersion` 上（渲染时按 key 解释），
   * 而不是在 `useEffect` 里 `setState` 清空——后者会先用旧值多渲染一轮，
   * 而 React 的新 lint 规则也禁止在 effect 里同步改状态。
   * 换成任何「记住上一次输入」的实现，这条都会红。
   */
  it('服务端推进到下一步后，加注框回到那一步的最低额，不留上一手敲的数字', async () => {
    const room = await openTable();
    myTurn(room);
    const input = screen.getByRole('spinbutton', { name: '加注到（总额）' });
    expect(input).toHaveValue(FULL_LEGAL.minRaiseTotal);
    fireEvent.change(input, { target: { value: '500' } });
    expect(input).toHaveValue(500);

    // 对手行动完，轮回到我：同一手里的下一个 turnVersion，服务端给了新的最低加注额
    myTurn(room, {
      turnVersion: 4,
      players: [{ ...me, legal: { ...FULL_LEGAL, minRaiseTotal: 80 } }, other],
    });
    expect(input).toHaveValue(80);
  });

  it('有下注额要跟时，中间那颗是「跟注」，读屏里根本不会有一颗「过牌」按钮', async () => {
    const room = await openTable();
    myTurn(room, { players: [{ ...me, legal: { ...FULL_LEGAL, canCheck: false } }, other] });
    // M2.4 把过牌与跟注合成同一颗（位置相同、按 `callAmount` 换文案），
    // 所以「不许过牌」的表现形式不再是「一颗灰钮」，而是「这颗写着跟注」。
    expect(screen.queryByRole('button', { name: '过牌' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /跟注/ })).toBeEnabled();
  });

  it('服务端提示位全空时（比如我已经弃完这一手）整排按钮都不亮', async () => {
    const room = await openTable();
    myTurn(room, { players: [{ ...me, legal: NO_LEGAL }, other] });
    // `NO_LEGAL` 里 `callAmount` 是 0、`canRaise` 是关着的，所以三颗分别落到
    // 「过牌 / 加注」这两套文案上；额度那一排整块不渲染（没有可加的范围就别摆一排刻度）。
    for (const name of ['弃牌', '过牌', '加注']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '弃牌' }));
    expect(sentCommands(room)).toHaveLength(0);
  });

  it('同一步动作重复点只上送一次（服务端还没确认前锁住）', async () => {
    const room = await openTable();
    myTurn(room);
    fireEvent.click(screen.getByRole('button', { name: '弃牌' }));
    expect(screen.getByRole('button', { name: '弃牌' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '弃牌' }));
    expect(sentCommands(room)).toHaveLength(1);
  });

  it('新状态把 turnVersion 推进后按钮重新可用', async () => {
    const room = await openTable();
    myTurn(room);
    fireEvent.click(screen.getByRole('button', { name: '弃牌' }));
    myTurn(room, { turnVersion: 4 });
    fireEvent.click(screen.getByRole('button', { name: '弃牌' }));
    expect(sentCommands(room).map((command) => command.t === 'action' && command.turnVersion)).toEqual([3, 4]);
  });

  it('没轮到我时整排动作按钮都不亮', async () => {
    const room = await openTable();
    myTurn(room, { isMyTurn: false, currentTurn: 1 });
    for (const name of ['弃牌', '跟注 20', '加注到 40']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
  });

  it('断线期间不发送任何动作，重连后才恢复可点', async () => {
    const room = await openTable();
    myTurn(room);
    act(() => {
      room.dropConnection();
    });
    const call = screen.getByRole('button', { name: /跟注/ });
    expect(call).toBeDisabled();
    fireEvent.click(call);
    expect(sentCommands(room)).toHaveLength(0);

    act(() => {
      room.restoreConnection();
    });
    fireEvent.click(screen.getByRole('button', { name: /跟注/ }));
    expect(sentCommands(room)).toHaveLength(1);
  });
});

describe('牌桌 · 底牌隐私', () => {
  it('只显示我自己的两张底牌', async () => {
    const room = await openTable();
    myTurn(room, { holeCards: [{ rank: 14, suit: 's' }, { rank: 12, suit: 'h' }] });
    const region = screen.getByRole('region', { name: '我的底牌' });
    expect(within(region).getByRole('img', { name: 'A♠' })).toBeInTheDocument();
    expect(within(region).getByRole('img', { name: 'Q♥' })).toBeInTheDocument();
  });

  it('没收到定向底牌消息时明说「还没发牌」，不显示占位假牌', async () => {
    const room = await openTable();
    myTurn(room);
    expect(within(screen.getByRole('region', { name: '我的底牌' })).getByText('还没拿到你的底牌')).toBeInTheDocument();
  });
});

/**
 * 我手上的筹码摆在底牌区，不摆在座位上（D-038）。
 *
 * 为什么要挪：竖屏满桌时座位框只有 104×56，「1,234,567」这种数字在那一格里是被
 * `overflow: hidden` 裁掉的；而我真正要盯的那一份数字，视线路径在底牌旁边。
 * 挪过来之后同一数额只出现一次——留在座位上会变成两处读数。
 */
describe('牌桌 · 我的筹码叠在底牌区', () => {
  it('按面额码成几枚，数字只在这一格出现', async () => {
    const room = await openTable();
    patch(room, { mySeat: 0, players: [{ ...me, chips: 1600 }, other] });
    const region = screen.getByRole('region', { name: '我的底牌' });
    const pile = region.querySelector('.chip-stack__pile');
    // 1,600 = 1000 + 500 + 100，三种面额各一枚
    expect(pile, '底牌区里该有一叠筹码').not.toBeNull();
    expect(pile?.querySelectorAll('img')).toHaveLength(3);
    // 数字是滚过去的（`ChipCount`），所以从 2,000 走到 1,600 要等它落位
    await waitFor(() => expect(within(region).getByText('1,600')).toBeInTheDocument());
    expect(seatRow(TEST_PROFILE.nickname).querySelector('.seat__chips')).toBeNull();
  });

  it('同一面额画不满时挂 ×N：省的是节点，不是「有多少」', async () => {
    const room = await openTable();
    patch(room, { mySeat: 0, players: [{ ...me, chips: 12000 }, other] });
    const region = screen.getByRole('region', { name: '我的底牌' });
    expect(region.querySelectorAll('.chip-stack__pile img')).toHaveLength(5);
    expect(region.querySelector('.chip-stack__more')?.textContent).toBe('×12');
  });

  it('零筹码时不摆空叠，但「0」还得看得见：那是被清空的余额，不是没有这回事', async () => {
    const room = await openTable();
    patch(room, { phase: 'HAND_END', mySeat: 0, players: [{ ...me, chips: 0 }, other] });
    const region = screen.getByRole('region', { name: '我的底牌' });
    expect(region.querySelector('.chip-stack')).not.toBeNull();
    expect(region.querySelector('.chip-stack__pile')).toBeNull();
    await waitFor(() => expect(within(region).getByText('0')).toBeInTheDocument());
  });

  it('还没入座时没有「我的筹码」这回事（旁观者看到的筹码归座位那一格）', async () => {
    const room = await openTable();
    patch(room, { mySeat: null, players: [{ ...me, seatIndex: null, chips: 1600 }, other] });
    const region = screen.getByRole('region', { name: '我的底牌' });
    expect(region.querySelector('.chip-stack')).toBeNull();
  });
});

describe('牌桌 · 座位与筹码', () => {
  it('旁观者点某号位的「入座」，上送带座位号的 sit', async () => {
    seedProfile();
    const fake = createFakeClient();
    renderTable(fake);
    await screen.findByRole('heading', { name: `牌桌 ${CODE}` });
    const room = fake.rooms.get(CODE);
    if (room === undefined) throw new Error('假 client 里没有房间');
    patch(room, {
      players: [{ ...me, seatIndex: null }, other],
      mySeat: null,
      isMyTurn: false,
    });
    fireEvent.click(screen.getByRole('button', { name: '入座 1 号座位' }));
    expect(sentCommands(room)).toEqual([{ t: 'sit', seatIndex: 0 }]);
  });

  it('已入座时显示离座，上送 stand', async () => {
    const room = await openTable();
    patch(room, { phase: 'IDLE' });
    fireEvent.click(screen.getByRole('button', { name: '离座' }));
    expect(sentCommands(room)).toEqual([{ t: 'stand' }]);
  });

  it('零筹码且本手结束后出现「重买」，上送 rebuy', async () => {
    const room = await openTable();
    patch(room, {
      phase: 'HAND_END',
      players: [{ ...me, chips: 0 }, other],
    });
    fireEvent.click(screen.getByRole('button', { name: '重买' }));
    expect(sentCommands(room)).toEqual([{ t: 'rebuy' }]);
  });
});

describe('牌桌 · 工具条与折叠', () => {
  /**
   * 工具条上那两颗展开钮。名字与面板自己的标题一字不差，读屏念出来就是
   * 「表情 已展开 / 已收起」，玩家不用先学一套新词。
   */
  function toggle(name: string): HTMLElement {
    return screen.getByRole('button', { name });
  }

  it('默认收起：表情和房主设置只剩两颗钮，信息行不跟着收', async () => {
    const room = await openTable();
    patch(room, { phase: 'IDLE' });
    expect(toggle('表情')).toHaveAttribute('aria-expanded', 'false');
    expect(toggle('房主设置')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: '大笑' })).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: '牌桌配置' })).not.toBeInTheDocument();
    // 他选的是「动作按钮收起来，信息留着」：局势那一行不在折叠范围里
    expect(screen.getByRole('heading', { name: `牌桌 ${CODE}` })).toBeInTheDocument();
    expect(screen.getByText('当前下注')).toBeInTheDocument();
  });

  it('点「表情」展开那一排，再点收回', async () => {
    await openTable();
    fireEvent.click(toggle('表情'));
    expect(toggle('表情')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: '大笑' })).toBeInTheDocument();
    fireEvent.click(toggle('表情'));
    expect(toggle('表情')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: '大笑' })).not.toBeInTheDocument();
  });

  it('点一个表情：上送之后托盘自己收起，不用回头再点一下', async () => {
    const room = await openTable();
    fireEvent.click(toggle('表情'));
    fireEvent.click(screen.getByRole('button', { name: '大笑' }));
    expect(sentCommands(room)).toEqual([{ t: 'emoji', emoji: 'laugh' }]);
    expect(toggle('表情')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: '大笑' })).not.toBeInTheDocument();
  });

  it('同屏只开一个：开「房主设置」会把表情托盘收回去', async () => {
    const room = await openTable();
    patch(room, { phase: 'IDLE' });
    fireEvent.click(toggle('表情'));
    fireEvent.click(toggle('房主设置'));
    expect(toggle('表情')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: '大笑' })).not.toBeInTheDocument();
    expect(toggle('房主设置')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('form', { name: '牌桌配置' })).toBeInTheDocument();
  });

  it('非房主看不到「房主设置」这颗钮，表情照旧', async () => {
    const room = await openTable();
    patch(room, { isHost: false, hostId: 'peer-2' });
    expect(screen.queryByRole('button', { name: '房主设置' })).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: '牌桌配置' })).not.toBeInTheDocument();
    expect(toggle('表情')).toBeInTheDocument();
  });

  it('开局那一刻面板自动收起：不是等人自己想起来关', async () => {
    const room = await openTable();
    patch(room, { phase: 'IDLE' });
    fireEvent.click(toggle('房主设置'));
    expect(screen.getByRole('button', { name: '开始牌局' })).toBeInTheDocument();
    // 服务端把阶段推走（这里直接推快照，等价于房主按了「开始牌局」之后的回流）
    myTurn(room);
    expect(screen.queryByRole('button', { name: '开始牌局' })).not.toBeInTheDocument();
    expect(toggle('房主设置')).toHaveAttribute('aria-expanded', 'false');
  });

  it('断线时不给人开一个全是灰按钮的面板，速度档和回等待室照旧', async () => {
    const room = await openTable();
    patch(room, { phase: 'IDLE' });
    act(() => {
      room.dropConnection();
    });
    expect(toggle('表情')).toBeDisabled();
    expect(toggle('房主设置')).toBeDisabled();
    // 灰钮点下去不该有托盘冒出来（原生 disabled 已经拦住了 click）
    fireEvent.click(toggle('表情'));
    expect(screen.queryByRole('button', { name: '大笑' })).not.toBeInTheDocument();
    // 加速是本地档、回等待室是路由，两件都不需要连接活着
    expect(screen.getByRole('button', { name: '加速' })).toBeEnabled();
    expect(screen.getByRole('link', { name: '回到等待室' })).toBeInTheDocument();
    expect(screen.getByText('连接没跟上，暂时不能操作。')).toBeInTheDocument();
  });
});

describe('牌桌 · 房主面板', () => {
  /** 面板整块收在工具条里（他要求的「主要界面只有牌桌 / 底牌 / 操作」），碰内容前先拉开 */
  function openHostPanel(): void {
    fireEvent.click(screen.getByRole('button', { name: '房主设置' }));
  }

  it('非房主看不到「开始牌局」和配置表单', async () => {
    const room = await openTable();
    patch(room, { isHost: false, hostId: 'peer-2' });
    expect(screen.queryByRole('button', { name: '开始牌局' })).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: '牌桌配置' })).not.toBeInTheDocument();
  });

  it('房主在 IDLE 阶段点开始牌局，上送 table:start', async () => {
    const room = await openTable();
    patch(room, { phase: 'IDLE' });
    openHostPanel();
    fireEvent.click(screen.getByRole('button', { name: '开始牌局' }));
    expect(sentCommands(room)).toEqual([{ t: 'table:start' }]);
  });

  it('开局之后开始按钮不亮（服务端会拒绝，界面先禁）', async () => {
    const room = await openTable();
    myTurn(room);
    openHostPanel();
    expect(screen.getByRole('button', { name: '开始牌局' })).toBeDisabled();
  });

  it('保存配置时上送合并后的大盲 = 2 × 小盲，以及当前桌布', async () => {
    const room = await openTable();
    patch(room, { phase: 'IDLE' });
    openHostPanel();
    fireEvent.change(screen.getByRole('spinbutton', { name: '小盲' }), { target: { value: '15' } });
    fireEvent.submit(screen.getByRole('form', { name: '牌桌配置' }));
    expect(sentCommands(room)).toEqual([
      {
        t: 'table:setConfig',
        // `felt` 也在表单里，所以未改动时照样原样上送（radio 有默认选中项）
        config: { smallBlind: 15, bigBlind: 30, startingChips: 2000, maxPlayers: 8, actionTimeoutSec: 30, felt: 'green' },
      },
    ]);
  });

  it('换桌布：只有被选中的那一档上送，绿呢蓝呢不会同时出现两个值', async () => {
    const room = await openTable();
    patch(room, { phase: 'IDLE' });
    openHostPanel();
    fireEvent.click(screen.getByRole('radio', { name: '蓝呢' }));
    fireEvent.submit(screen.getByRole('form', { name: '牌桌配置' }));
    const sent = sentCommands(room);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ t: 'table:setConfig', config: { felt: 'blue' } });
  });

  it('非 IDLE 阶段配置表单不亮', async () => {
    const room = await openTable();
    myTurn(room);
    openHostPanel();
    expect(screen.getByRole('button', { name: '保存配置' })).toBeDisabled();
  });
});

describe('牌桌 · 表情', () => {
  it('点「大笑」上送 emoji:laugh', async () => {
    const room = await openTable();
    fireEvent.click(screen.getByRole('button', { name: '表情' }));
    fireEvent.click(screen.getByRole('button', { name: '大笑' }));
    expect(sentCommands(room)).toEqual([{ t: 'emoji', emoji: 'laugh' }]);
  });
});

describe('牌桌 · 倒计时', () => {
  it('剩余秒数按服务端的 deadline 走，本地每秒重算而不是自己减', async () => {
    const room = await openTable();
    const now = 1_800_000_000_000;
    vi.useFakeTimers({ now, toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    myTurn(room, { deadline: now + 30_000 });
    expect(screen.getByRole('timer')).toHaveTextContent('30');
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByRole('timer')).toHaveTextContent('25');
    vi.useRealTimers();
  });

  it('用 clockOffsetMs 校正本地时钟，服务端那边还剩 10 秒就显示 10', async () => {
    const room = await openTable();
    const now = 1_800_000_000_000;
    vi.useFakeTimers({ now, toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    // 这台设备的本地时间比服务端慢 20 秒：deadline 是服务端时钟下的绝对时刻
    myTurn(room, { deadline: now + 30_000, clockOffsetMs: 20_000 });
    expect(screen.getByRole('timer')).toHaveTextContent('10');
    vi.useRealTimers();
  });

  it('下一手开始时显示倒计时而不是行动计时', async () => {
    const room = await openTable();
    const now = 1_800_000_000_000;
    vi.useFakeTimers({ now, toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    myTurn(room, { isMyTurn: false, currentTurn: 1, deadline: null, phase: 'HAND_END', nextHandAt: now + 8_000 });
    expect(screen.getByRole('timer')).toHaveTextContent('8');
    vi.useRealTimers();
  });
});

describe('牌桌 · 服务端反馈', () => {
  it('服务端拒绝这个动作时页面立刻说清楚，并带一个关掉按钮', async () => {
    const room = await openTable();
    act(() => {
      room.pushNotice('error', '这一步已经过期了，牌桌已经往前走了。');
    });
    const notice = await screen.findByRole('alert');
    expect(within(notice).getByText('这一步已经过期了，牌桌已经往前走了。')).toBeInTheDocument();
    fireEvent.click(within(notice).getByRole('button', { name: '关掉这条提示' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('info 类提示温和播报，不抢读屏（role=status 而不是 alert）', async () => {
    const room = await openTable();
    act(() => {
      room.pushNotice('info', '旧的重连凭证已经失效，我用新身份帮你重新入座了。');
    });
    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent('我用新身份帮你重新入座了');
  });
});

describe('牌桌 · 座位复用时的身份', () => {
  /**
   * 一手进行中可以有人离桌、另一个人坐进他刚空出来的位子（服务端会立刻回收座位）。
   * 这时 `players[座位]` 是新来的人，`handPlayers[座位]` 却是上一位的手牌记录 ——
   * 他的「已弃牌」不属于新住户，展示成他的会让刚坐下的人以为自己在弃牌。
   */
  it('中途坐进空位的玩家不会继承上一位在本手里的弃牌状态', async () => {
    const room = await openTable();
    const newcomer = fakePlayer('peer-3', '新来的', false, { seatIndex: 1, chips: 2000 });
    myTurn(room, {
      players: [me, newcomer],
      handPlayers: [
        {
          playerId: 'self',
          seatIndex: 0,
          nickname: TEST_PROFILE.nickname,
          avatarSeed: me.avatarSeed,
          folded: false,
          allIn: false,
          sittingOut: false,
          hasActed: true,
          committedThisStreet: 20,
          committedTotal: 20,
        },
        {
          // 老王本手弃牌后离桌，服务端把 1 号位回收给了新来的
          playerId: 'peer-2',
          seatIndex: 1,
          nickname: '老王',
          avatarSeed: other.avatarSeed,
          folded: true,
          allIn: false,
          sittingOut: false,
          hasActed: true,
          committedThisStreet: 0,
          committedTotal: 20,
        },
      ],
    });
    expect(screen.getByText('新来的')).toBeInTheDocument();
    expect(screen.queryByText('已弃牌')).not.toBeInTheDocument();

    // 反向那条腿：座位和身份都对得上时，本手状态照旧要显示。
    // 少了这一句，上面那句可以靠「永远不查 handPlayers」蒙过去。
    myTurn(room, { players: [me, other] });
    expect(within(seatRow('老王')).getByText('已弃牌')).toBeInTheDocument();
  });

  it('摊牌面板只按本手冻结身份点名，宁可写座位号也不把派彩记给现在的住户', async () => {
    const room = await openTable();
    const award = {
      potIndex: 0,
      winners: [1],
      amount: 200,
      handName: '三条',
      bestFive: [
        { rank: 11, suit: 's' as const },
        { rank: 11, suit: 'd' as const },
        { rank: 11, suit: 'h' as const },
        { rank: 2, suit: 'c' as const },
        { rank: 9, suit: 'd' as const },
      ],
    };
    // 冻结身份还在：点名点到人
    myTurn(room, {
      phase: 'HAND_END',
      isMyTurn: false,
      currentTurn: null,
      handPlayers: [{ ...other, playerId: 'peer-2' }],
      awards: [award],
    });
    expect(within(await screen.findByRole('region', { name: '摊牌与结算' })).getByText('老王')).toBeInTheDocument();

    // 冻结身份已经随本手清掉：只报座位，不报此刻坐在 1 号位的人
    const newcomer = fakePlayer('peer-3', '新来的', false, { seatIndex: 1, chips: 2000 });
    myTurn(room, { players: [me, newcomer], handPlayers: [], awards: [award] });
    const panel = screen.getByRole('region', { name: '摊牌与结算' });
    expect(within(panel).getByText('2 号座位')).toBeInTheDocument();
    expect(within(panel).queryByText('新来的')).not.toBeInTheDocument();
  });
});

describe('牌桌 · 摊牌与结算', () => {
  it('摊牌后显示别人亮出的底牌和每个池的赢家', async () => {
    const room = await openTable();
    myTurn(room, {
      phase: 'SHOWDOWN',
      isMyTurn: false,
      currentTurn: null,
      board: [
        { rank: 2, suit: 'c' },
        { rank: 9, suit: 'd' },
        { rank: 13, suit: 'h' },
        { rank: 11, suit: 'h' },
        { rank: 7, suit: 's' },
      ],
      handPlayers: [
        {
          playerId: 'self',
          seatIndex: 0,
          nickname: TEST_PROFILE.nickname,
          avatarSeed: me.avatarSeed,
          folded: false,
          allIn: false,
          sittingOut: false,
          hasActed: true,
          committedThisStreet: 20,
          committedTotal: 100,
        },
        {
          playerId: 'peer-2',
          seatIndex: 1,
          nickname: '老王',
          avatarSeed: other.avatarSeed,
          folded: false,
          allIn: false,
          sittingOut: false,
          hasActed: true,
          committedThisStreet: 20,
          committedTotal: 100,
        },
      ],
      reveals: [{ playerId: 'peer-2', seatIndex: 1, cards: [{ rank: 11, suit: 's' }, { rank: 11, suit: 'd' }] }],
      // 七张 = J♠ J♦（老王亮出的）+ 2♣ 9♦ K♥ J♥ 7♠（公共牌）。三条 J，带张 K 和 9
      awards: [
        {
          potIndex: 0,
          winners: [1],
          amount: 200,
          handName: '三条',
          bestFive: [
            { rank: 11, suit: 's' },
            { rank: 11, suit: 'd' },
            { rank: 11, suit: 'h' },
            { rank: 13, suit: 'h' },
            { rank: 9, suit: 'd' },
          ],
        },
      ],
    });
    const panel = await screen.findByRole('region', { name: '摊牌与结算' });
    // J♠ / J♦ 会出现两次：一次是老王亮出的底牌，一次是他那一排七张牌里的同一枚。
    // 这正是我们想要的（两处都得显示），所以这里断言「各两张」而不是「恰好一张」。
    // 七张里哪五张该描边归 `showdownBest.test.tsx` 管，这里只看面板摆出来了。
    // M2.3 起牌面是 SVG 图，名字走 `alt`，所以按角色查而不是按文字查。
    expect(within(panel).getAllByRole('img', { name: 'J♠' })).toHaveLength(2);
    expect(within(panel).getAllByRole('img', { name: 'J♦' })).toHaveLength(2);
    expect(within(panel).getByText(/三条/)).toBeInTheDocument();
    expect(within(panel).getByText('200')).toBeInTheDocument();
  });

  it('本手结束显示每人筹码变动，正负都有符号', async () => {
    const room = await openTable();
    myTurn(room, {
      phase: 'HAND_END',
      isMyTurn: false,
      currentTurn: null,
      results: [
        { playerId: 'peer-2', seatIndex: 1, chips: 2000, delta: 200, handName: '三条' },
        { playerId: 'self', seatIndex: 0, chips: 1800, delta: -200, handName: '两对' },
      ],
    });
    const panel = await screen.findByRole('region', { name: '摊牌与结算' });
    expect(within(panel).getByText('+200')).toBeInTheDocument();
    expect(within(panel).getByText('-200')).toBeInTheDocument();
  });
});
