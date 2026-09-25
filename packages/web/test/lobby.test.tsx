/**
 * 大厅页的行为测试。
 *
 * 用假的 `GameClient` 驱动，不起服务端：M0.4 的验收项里有好几条讲的是
 * **连接失败时要怎样**（服务端没起、房间不存在），那些路径用真服务端
 * 要么造不出来，要么时序很脆。
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LobbyPage } from '../src/lobby/LobbyPage';
import { WaitingRoomPage } from '../src/lobby/WaitingRoomPage';
import { PROFILE_STORAGE_KEY } from '../src/state/profile';
import { createFakeClient, FakeMatchMakeError, type FakeClientHandle } from './fakeClient';
import { renderWithProviders, resetWebState, seedProfile, TEST_PROFILE } from './harness';

const CREATED_CODE = 'K7QM3D';

beforeEach(() => {
  resetWebState();
});

afterEach(() => {
  resetWebState();
});

/** 大厅 + 等待室两条路由都要在，否则导航之后什么都渲染不出来 */
function renderLobby(fake: FakeClientHandle): void {
  renderWithProviders(
    '/',
    <Routes>
      <Route path="/" element={<LobbyPage />} />
      <Route path="/r/:code" element={<WaitingRoomPage />} />
    </Routes>,
    { client: fake.client },
  );
}

function nicknameInput(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>('昵称');
}

function codeInput(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>('配对码');
}

function createButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /创建房间|正在创建/ });
}

function joinButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: '加入房间' });
}

/**
 * 断言「已经跳到等待室了」。
 *
 * 不用 `findByText(配对码)`：大厅那张「你已经在一桌里了」卡片里也有同一个码，
 * 而它是**导航前的过渡态**——`waitFor` 会在旧节点还挂着的瞬间就命中它，
 * 等新节点渲染完，那个节点已经从 document 上摘下来了，
 * 于是断言以「element could not be found in the document」这种莫名其妙的形式失败。
 * 「进入牌桌」这个链接只有等待室有，而且 href 里带着码，拿它当标志最稳。
 */
async function expectArrivedAtWaitingRoom(code: string): Promise<void> {
  const link = await screen.findByRole('link', { name: '进入牌桌' });
  expect(link).toHaveAttribute('href', `/t/${code}`);
  expect(screen.getByRole('heading', { name: '配对码' })).toBeInTheDocument();
}

describe('大厅 · 身份', () => {
  it('首次访问就有一套默认身份（分享链接要能直接进房，不能被表单拦住）', () => {
    renderLobby(createFakeClient());
    expect(nicknameInput().value).toMatch(/^玩家[A-Z2-9]{4}$/);
    expect(screen.getByAltText('你的头像').getAttribute('src')?.startsWith('data:image/svg+xml')).toBe(true);
  });

  it('读回本地存档里的身份', () => {
    seedProfile();
    renderLobby(createFakeClient());
    expect(nicknameInput().value).toBe(TEST_PROFILE.nickname);
  });

  it('改昵称会写回 localStorage（换设备就是另一个人，但同设备要记得住）', () => {
    seedProfile();
    renderLobby(createFakeClient());
    fireEvent.change(nicknameInput(), { target: { value: '小林' } });
    expect(nicknameInput().value).toBe('小林');
    expect(window.localStorage.getItem(PROFILE_STORAGE_KEY)).toContain('"nickname":"小林"');
  });

  it('昵称按码点截断到 16，计数器与截断口径一致', () => {
    seedProfile();
    renderLobby(createFakeClient());
    fireEvent.change(nicknameInput(), { target: { value: '一二三四五六七八九十一二三四五六七八九十' } });
    expect([...nicknameInput().value]).toHaveLength(16);
    expect(screen.getByText('16/16')).toBeInTheDocument();
  });

  it('刻意不给昵称框设 maxLength（会把 ZWJ emoji 从中间劈开）', () => {
    seedProfile();
    renderLobby(createFakeClient());
    expect(nicknameInput()).not.toHaveAttribute('maxlength');
  });

  it('「换一个」换头像，并且换完是稳定的（同 seed 必定同图）', () => {
    seedProfile();
    renderLobby(createFakeClient());
    const avatar = screen.getByAltText('你的头像');
    const before = avatar.getAttribute('src');
    fireEvent.click(screen.getByRole('button', { name: '换一个' }));
    const after = avatar.getAttribute('src');
    expect(after).not.toBe(before);
    expect(after?.startsWith('data:image/svg+xml')).toBe(true);
  });

  it('昵称为空时两个按钮都点不动，并说明原因', () => {
    seedProfile();
    renderLobby(createFakeClient());
    fireEvent.change(nicknameInput(), { target: { value: '   ' } });
    expect(screen.getByText('先给自己起个名字')).toBeInTheDocument();
    expect(createButton()).toBeDisabled();
    expect(joinButton()).toBeDisabled();
  });
});

describe('大厅 · 创建房间', () => {
  it('成功后跳到等待室，配对码就是 roomId（D-009）', async () => {
    seedProfile();
    const fake = createFakeClient({ createCodes: [CREATED_CODE] });
    renderLobby(fake);

    fireEvent.click(createButton());

    await expectArrivedAtWaitingRoom(CREATED_CODE);
    expect(screen.getByText(CREATED_CODE, { selector: '.join-code' })).toBeInTheDocument();
    expect(fake.createCalls()).toBe(1);
    // 上送的是清洗过的身份，服务端拿到什么由服务端再洗一遍
    expect(fake.created).toEqual([{ nickname: TEST_PROFILE.nickname, avatarSeed: TEST_PROFILE.avatarSeed }]);
  });

  it('服务端没起时不白屏：页面结构照旧，多一条红色横幅说明怎么办', async () => {
    seedProfile();
    const fake = createFakeClient({ createFailure: new TypeError('Failed to fetch') });
    renderLobby(fake);

    fireEvent.click(createButton());

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('连不上服务端');
    expect(banner).toHaveTextContent('2567');
    // 关键：没有跳转，大厅还在，按钮恢复可点，玩家可以原地重试
    expect(joinButton()).toBeInTheDocument();
    expect(nicknameInput()).toBeInTheDocument();
    await waitFor(() => {
      expect(createButton()).toBeEnabled();
    });
  });

  it('点「知道了」可以关掉横幅', async () => {
    seedProfile();
    const fake = createFakeClient({ createFailure: new TypeError('Failed to fetch') });
    renderLobby(fake);

    fireEvent.click(createButton());
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: '知道了' }));

    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });
});

describe('大厅 · 加入房间', () => {
  it('配对码不满 6 位时「加入房间」点不动', () => {
    seedProfile();
    renderLobby(createFakeClient());
    fireEvent.change(codeInput(), { target: { value: 'K7Q' } });
    expect(joinButton()).toBeDisabled();
  });

  it('非法字符根本打不进去（验收项：自动转大写 + 过滤）', () => {
    seedProfile();
    renderLobby(createFakeClient());
    fireEvent.change(codeInput(), { target: { value: 'i o 0 1' } });
    expect(codeInput().value).toBe('');
    fireEvent.change(codeInput(), { target: { value: 'k7qm3d' } });
    expect(codeInput().value).toBe('K7QM3D');
    expect(joinButton()).toBeEnabled();
  });

  it('成功后跳到等待室，并把自己上送给服务端', async () => {
    seedProfile();
    const fake = createFakeClient();
    renderLobby(fake);

    fireEvent.change(codeInput(), { target: { value: CREATED_CODE } });
    fireEvent.click(joinButton());

    await expectArrivedAtWaitingRoom(CREATED_CODE);
    expect(fake.joined).toEqual([{ code: CREATED_CODE, profile: { ...TEST_PROFILE } }]);
  });

  it('码不存在时给出「房间不存在或已解散」，不复述服务端原文', async () => {
    seedProfile();
    const fake = createFakeClient({
      joinFailures: new Map([['ZZZZZZ', new FakeMatchMakeError(522, 'room "ZZZZZZ" not found')]]),
    });
    renderLobby(fake);

    fireEvent.change(codeInput(), { target: { value: 'ZZZZZZ' } });
    fireEvent.click(joinButton());

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('房间不存在或已解散');
    expect(banner).not.toHaveTextContent('not found');
    // 还留在大厅
    expect(nicknameInput()).toBeInTheDocument();
  });

  it('房间已满时说明上限是几人', async () => {
    seedProfile();
    const fake = createFakeClient({
      joinFailures: new Map([['FULLRM', new FakeMatchMakeError(522, 'room "FULLRM" is locked')]]),
    });
    renderLobby(fake);

    fireEvent.change(codeInput(), { target: { value: 'FULLRM' } });
    fireEvent.click(joinButton());

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('房间已经满了');
    expect(banner).toHaveTextContent('8');
  });

  it('在配对码框里敲回车等价于点「加入房间」', async () => {
    seedProfile();
    const fake = createFakeClient();
    renderLobby(fake);

    fireEvent.change(codeInput(), { target: { value: CREATED_CODE } });
    fireEvent.keyDown(codeInput(), { key: 'Enter' });

    await expectArrivedAtWaitingRoom(CREATED_CODE);
    expect(fake.joined).toHaveLength(1);
  });
});
