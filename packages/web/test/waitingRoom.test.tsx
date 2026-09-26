/**
 * 房间等待室（`/r/:code`）的行为测试。
 *
 * 重点是那条**关键路径**：朋友在微信里点开分享链接，没有任何前置操作，
 * 页面自己就得把人送进房间。这条路径也是 React 19 StrictMode 下
 * effect 会被打两遍的那条，所以防重复连接的守卫必须在这里被测到。
 */

import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LobbyPage } from '../src/lobby/LobbyPage';
import { WaitingRoomPage } from '../src/lobby/WaitingRoomPage';
import {
  createFakeClient,
  fakePlayer,
  FakeMatchMakeError,
  type FakeClientHandle,
  type FakeRoomHandle,
} from './fakeClient';
import { renderWithProviders, resetWebState, seedProfile, TEST_PROFILE } from './harness';

const CODE = 'K7QM3D';

beforeEach(() => {
  resetWebState();
});

afterEach(() => {
  resetWebState();
});

function renderWaitingRoom(path: string, fake: FakeClientHandle, strict = false): void {
  renderWithProviders(
    path,
    <Routes>
      <Route path="/" element={<LobbyPage />} />
      <Route path="/r/:code" element={<WaitingRoomPage />} />
    </Routes>,
    { client: fake.client, strict },
  );
}

function roomOf(fake: FakeClientHandle, code: string): FakeRoomHandle {
  const room = fake.rooms.get(code);
  // 非空断言安全：这几个测试都先确认过连接建立成功，房间必然已经在假 client 里。
  if (room === undefined) throw new Error(`假 client 里没有房间 ${code}`);
  return room;
}

describe('等待室 · 自动进房', () => {
  it('直接打开分享链接就能进房，不需要先经过大厅', async () => {
    seedProfile();
    const fake = createFakeClient();
    renderWaitingRoom(`/r/${CODE}`, fake);

    expect(await screen.findByRole('link', { name: '进入牌桌' })).toHaveAttribute('href', `/t/${CODE}`);
    expect(screen.getByText(CODE, { selector: '.join-code' })).toBeInTheDocument();
    expect(fake.joined).toEqual([{ code: CODE, profile: { ...TEST_PROFILE } }]);
    // 自己要在列表里，并且带「你」的标记
    expect(screen.getByText(TEST_PROFILE.nickname)).toBeInTheDocument();
    expect(screen.getByText('你')).toBeInTheDocument();
    expect(screen.getByText('1/8')).toBeInTheDocument();
  });

  it('URL 里是小写也能进（配对码大小写不敏感）', async () => {
    seedProfile();
    const fake = createFakeClient();
    renderWaitingRoom(`/r/${CODE.toLowerCase()}`, fake);

    await screen.findByRole('link', { name: '进入牌桌' });
    expect(fake.joined).toEqual([{ code: CODE, profile: { ...TEST_PROFILE } }]);
    expect(screen.getByText(CODE, { selector: '.join-code' })).toBeInTheDocument();
  });

  it('StrictMode 把 effect 打两遍，也只连一次', async () => {
    seedProfile();
    const fake = createFakeClient();
    renderWaitingRoom(`/r/${CODE}`, fake, true);

    await screen.findByRole('link', { name: '进入牌桌' });
    // 多等一会儿：如果守卫失效，第二次 join 是异步的，不会立刻暴露
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.joinCallsFor(CODE)).toBe(1);
  });

  it('从大厅导航过来时不重连（连接归 Provider 管，切路由不该抖动座位）', async () => {
    seedProfile();
    const fake = createFakeClient({ createCodes: [CODE] });
    renderWaitingRoom('/', fake);

    fireEvent.click(screen.getByRole('button', { name: /创建房间|正在创建/ }));
    await screen.findByRole('link', { name: '进入牌桌' });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(fake.createCalls()).toBe(1);
    expect(fake.joinCallsFor(CODE)).toBe(0);
  });
});

describe('等待室 · 非法配对码', () => {
  it('码格式不对时说明原因，并且根本不去连服务端', () => {
    seedProfile();
    const fake = createFakeClient();
    renderWaitingRoom('/r/abc', fake);

    expect(screen.getByRole('heading', { name: '这个链接里的配对码不对' })).toBeInTheDocument();
    expect(screen.getByText(/配对码是 6 位/)).toBeInTheDocument();
    expect(fake.joined).toHaveLength(0);
    expect(screen.getByRole('link', { name: '回大厅重新输入' })).toHaveAttribute('href', '/');
  });

  it('把收到的原文回显出来，玩家才知道是链接坏了还是自己抄错了', () => {
    seedProfile();
    renderWaitingRoom('/r/ABC', createFakeClient());
    expect(screen.getByText(/「ABC」/)).toBeInTheDocument();
  });

  it('含 I O 0 1 的码不合法：宁可让玩家重打，也不去猜他想输入什么', () => {
    seedProfile();
    const fake = createFakeClient();
    renderWaitingRoom('/r/ABC123', fake);
    expect(screen.getByRole('heading', { name: '这个链接里的配对码不对' })).toBeInTheDocument();
    expect(fake.joined).toHaveLength(0);
  });
});

describe('等待室 · 连接失败', () => {
  it('房间已满时横幅说明上限', async () => {
    seedProfile();
    const fake = createFakeClient({
      joinFailures: new Map([[CODE, new FakeMatchMakeError(522, `room "${CODE}" is locked`)]]),
    });
    renderWaitingRoom(`/r/${CODE}`, fake);

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('房间已经满了');
    // 没连上，所以「进入牌桌」是 disabled 的 button 而不是一个点了没反应的链接
    expect(screen.getByRole('button', { name: '进入牌桌' })).toBeDisabled();
    expect(screen.queryByRole('link', { name: '进入牌桌' })).not.toBeInTheDocument();
  });

  it('服务端没起时页面结构照旧，不白屏', async () => {
    seedProfile();
    const fake = createFakeClient({ joinFailure: new TypeError('Failed to fetch') });
    renderWaitingRoom(`/r/${CODE}`, fake);

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('连不上服务端');
    // 配对码本身还是显示出来的——玩家至少能把码抄下来重试
    expect(screen.getByText(CODE, { selector: '.join-code' })).toBeInTheDocument();
    expect(screen.getByText(/还没连上这一桌/)).toBeInTheDocument();
  });
});

describe('等待室 · 玩家进出', () => {
  it('服务端推来新玩家，列表立刻跟上', async () => {
    seedProfile();
    const fake = createFakeClient();
    renderWaitingRoom(`/r/${CODE}`, fake);
    await screen.findByRole('link', { name: '进入牌桌' });

    const room = roomOf(fake, CODE);
    act(() => {
      room.pushPlayers([
        { ...fakePlayer('session-1', TEST_PROFILE.nickname), avatarSeed: TEST_PROFILE.avatarSeed, isSelf: true },
        fakePlayer('session-2', '老王'),
      ]);
    });

    expect(await screen.findByText('老王')).toBeInTheDocument();
    expect(screen.getByText('2/8')).toBeInTheDocument();
  });

  it('空座位也画出来（8 人桌），让房主看得出还差几个', async () => {
    seedProfile();
    const fake = createFakeClient();
    renderWaitingRoom(`/r/${CODE}`, fake);
    await screen.findByRole('link', { name: '进入牌桌' });

    expect(screen.getAllByText('空座位')).toHaveLength(7);
  });

  /**
   * 下面三条测的是 SDK 自动重连的**时序**，不是笼统的「断了要有提示」。
   *
   * 真 SDK 掉线时先发 `onDrop`，然后自己指数退避重试 15 次（约 56 秒），
   * 全部失败才发 `onLeave`。所以「连接已断开」这条横幅在真实场景里
   * 要等将近一分钟才该出现，在那之前应当显示「正在重连」。
   *
   * 上一版这里只有一个测试：调一次 `dropUnexpected()` 就断言「连接已断开」。
   * 假 client 把掉线直接映射成了 `onLeave`，于是测试全绿，而真浏览器里
   * 那 56 秒是一片安静——玩家看到的是一张再也不更新的正常牌桌。
   * 教训是：假实现必须照着真 SDK 的信号分工来建模，
   * 否则它保护的只是一个不存在的行为。
   */
  it('掉线的第一时间说「正在重连」，并把「这段时间不能操作」讲清楚', async () => {
    seedProfile();
    const fake = createFakeClient();
    renderWaitingRoom(`/r/${CODE}`, fake);
    await screen.findByRole('link', { name: '进入牌桌' });

    act(() => {
      roomOf(fake, CODE).dropConnection();
    });

    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent('正在重连');
    // 这句话在 M1.6 换过一次。原来写的是「别刷新页面——刷新会把重连凭证丢掉」，
    // 而现在凭证存在**这个标签页的 sessionStorage** 里，刷新恰恰能续上座位，
    // 留着那句只会把玩家真正有效的自救手段挡掉。
    // 断线期间真正的坑是「按钮还亮着、动作却发不出去」，所以说的是这件事。
    expect(banner).toHaveTextContent('按钮我们也先禁用了');
    // 温和播报，不打断朗读：掉线不是需要玩家立刻动手的错误
    expect(banner).not.toHaveAttribute('role', 'alert');
    // 重连窗口里旧快照照旧摆着，玩家至少还能看见刚才那一桌人
    expect(screen.getByText('1/8')).toBeInTheDocument();
  });

  it('等重连的那段时间里「进入牌桌」不亮：那是一份过期快照', async () => {
    seedProfile();
    const fake = createFakeClient();
    renderWaitingRoom(`/r/${CODE}`, fake);
    await screen.findByRole('link', { name: '进入牌桌' });

    act(() => {
      roomOf(fake, CODE).dropConnection();
    });

    // 链接换成 disabled 的按钮，理由和连不上服务端时一样：
    // 一个「点了什么都不会发生」的链接比一个不亮的按钮坏得多。
    const enter = screen.getByRole('button', { name: '进入牌桌' });
    expect(enter).toBeDisabled();
    expect(screen.queryByRole('link', { name: '进入牌桌' })).not.toBeInTheDocument();
  });

  it('重连成功后横幅消失，牌桌回到正常样子', async () => {
    seedProfile();
    const fake = createFakeClient();
    renderWaitingRoom(`/r/${CODE}`, fake);
    await screen.findByRole('link', { name: '进入牌桌' });

    act(() => {
      roomOf(fake, CODE).dropConnection();
    });
    await screen.findByText('连接不稳定，正在重连…');

    act(() => {
      roomOf(fake, CODE).restoreConnection();
    });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '进入牌桌' })).toBeInTheDocument();
  });

  it('重连彻底失败之后才改口说「连接已断开」', async () => {
    seedProfile();
    const fake = createFakeClient();
    renderWaitingRoom(`/r/${CODE}`, fake);
    await screen.findByRole('link', { name: '进入牌桌' });

    act(() => {
      roomOf(fake, CODE).dropConnection();
    });
    await screen.findByText('连接不稳定，正在重连…');

    act(() => {
      roomOf(fake, CODE).failReconnection();
    });

    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent('连接已断开');
    expect(banner).not.toHaveTextContent('正在重连');
    expect(banner).not.toHaveAttribute('role', 'alert');
  });
});

describe('等待室 · 分享与离开', () => {
  it('分享链接是绝对地址，朋友点开就能直接进这一桌', async () => {
    seedProfile();
    const fake = createFakeClient();
    renderWaitingRoom(`/r/${CODE}`, fake);
    await screen.findByRole('link', { name: '进入牌桌' });

    const share = screen.getByDisplayValue<HTMLInputElement>(new RegExp(`/r/${CODE}`));
    expect(share.value).toBe(`${window.location.origin}/r/${CODE}`);
    expect(share).toHaveAttribute('readonly');
  });

  it('没有 clipboard API 时退化成选中输入框（局域网 http 下 clipboard 是 undefined）', async () => {
    seedProfile();
    const fake = createFakeClient();
    renderWaitingRoom(`/r/${CODE}`, fake);
    await screen.findByRole('link', { name: '进入牌桌' });

    const select = vi.spyOn(HTMLInputElement.prototype, 'select').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: '复制' }));

    await waitFor(() => {
      expect(select).toHaveBeenCalledTimes(1);
    });
    select.mockRestore();
    // 没复制成功就不该谎称「已复制」
    expect(screen.getByRole('button', { name: '复制' })).toBeInTheDocument();
  });

  it('有 clipboard API 时走复制，按钮变成「已复制」并且过一会儿变回去', async () => {
    seedProfile();
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    try {
      const fake = createFakeClient();
      renderWaitingRoom(`/r/${CODE}`, fake);

      // 假定时器下用 act 冲刷微任务，而不是 waitFor：
      // waitFor 在假定时器里要靠「嗅探当前是不是 jest 的 mock 时钟」来自我推进，
      // 换成 vitest 之后这件事不值得赌。
      await act(async () => {});
      fireEvent.click(screen.getByRole('button', { name: '复制' }));
      await act(async () => {});

      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/r/${CODE}`);
      expect(screen.getByRole('button', { name: '已复制' })).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(screen.getByRole('button', { name: '复制' })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    }
  });

  it('离开房间会通知服务端（consented），然后回到大厅', async () => {
    seedProfile();
    const fake = createFakeClient();
    renderWaitingRoom(`/r/${CODE}`, fake);
    await screen.findByRole('link', { name: '进入牌桌' });

    fireEvent.click(screen.getByRole('button', { name: '离开房间' }));

    expect(await screen.findByRole('button', { name: '加入房间' })).toBeInTheDocument();
    expect(roomOf(fake, CODE).leaveCount()).toBe(1);
  });
});
