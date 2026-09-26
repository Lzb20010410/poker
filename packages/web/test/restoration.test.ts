import { afterEach, expect, it, vi } from 'vitest';
import { createGameClient } from '../src/net/client';
import { FakeMatchMakeError } from './fakeClient';
import { memoryStorage, sdkRoom } from './sdkFixture';
const boundary = vi.hoisted(() => ({ create: vi.fn(), joinById: vi.fn(), reconnect: vi.fn() }));
// 展开原模块只是为了留下 `Client` 之外的真实导出，所以类型写 Record 就够：
// 被测代码里 import 的 `Client` 仍然按真类型检查，mock 只在运行时生效。
vi.mock('@colyseus/sdk', async (original) => {
  const actual = await original<Record<string, unknown>>();
  return { ...actual, Client: vi.fn(function () { return boundary; }) };
});
const profile = { nickname: 'A', avatarSeed: 'A' };
afterEach(() => { vi.clearAllMocks(); });
async function saved() {
  const storage = memoryStorage(); const room = sdkRoom();
  boundary.create.mockResolvedValue(room.room);
  const client = createGameClient('http://server:2591', { storage });
  const pending = client.createRoom(profile); await Promise.resolve(); room.patch();
  return { storage, connection: await pending, room, client };
}
it('以 URL + code 隔离 token，刷新重连同身份，新创建不能偷用旧 token', async () => {
  const f = await saved();
  expect([...f.storage.data.values()]).toEqual(['K7QM3D:old-secret']);
  const second = sdkRoom(); boundary.reconnect.mockResolvedValue(second.room);
  boundary.joinById.mockResolvedValue(second.room);
  const reload = createGameClient('http://server:2591', { storage: f.storage });
  const pending = reload.joinRoom('K7QM3D', profile); await Promise.resolve(); second.patch();
  const restored = await pending;
  expect(boundary.reconnect).toHaveBeenCalledWith('K7QM3D:old-secret');
  expect(boundary.joinById).not.toHaveBeenCalled();
  expect(restored.mySessionId).toBe(f.connection.mySessionId);
  boundary.create.mockResolvedValue(second.room);
  const created = await reload.createRoom(profile);
  expect(boundary.create).toHaveBeenCalledTimes(2);
  expect(boundary.reconnect).toHaveBeenCalledTimes(1);
  const otherServer = createGameClient('http://other:2591', { storage: f.storage });
  await otherServer.joinRoom('K7QM3D', profile);
  expect(boundary.joinById).toHaveBeenCalledTimes(1);
  await created.leave();
});
it('暂时网络故障保留凭证且不 join 新身份', async () => {
  const f = await saved();
  boundary.reconnect.mockRejectedValue(new TypeError('Failed to fetch'));
  const fresh = sdkRoom();
  boundary.joinById.mockImplementation(async () => { setTimeout(() => fresh.patch(), 0); return fresh.room; });
  await expect(f.client.joinRoom('K7QM3D', profile)).rejects.toThrow('Failed to fetch');
  expect(boundary.joinById).not.toHaveBeenCalled();
  expect(f.storage.data.size).toBe(1);
  await f.connection.leave();
});
it('明确过期清凭证，重新加入成功后保留可关闭的中文身份提醒', async () => {
  const f = await saved();
  boundary.reconnect.mockRejectedValue(new FakeMatchMakeError(524, 'reconnection token invalid or expired.'));
  const fresh = sdkRoom(); fresh.room.sessionId = 'new-session';
  boundary.joinById.mockImplementation(async () => { setTimeout(() => fresh.patch(), 0); return fresh.room; });
  const connection = await f.client.joinRoom('K7QM3D', profile);
  const notices: unknown[] = []; connection.onNotice((n) => notices.push(n));
  expect(notices).toContainEqual(expect.objectContaining({ kind: 'info', message: expect.stringMatching(/过期.*新身份/) }));
  expect(boundary.joinById).toHaveBeenCalledTimes(1);
  await connection.leave(); expect(f.storage.data.size).toBe(0);
});
it('sessionStorage 拒绝读取或写入不会让游戏崩溃', async () => {
  const room = sdkRoom(); boundary.joinById.mockResolvedValue(room.room);
  const denied = () => { throw new Error('SecurityError'); };
  const pending = createGameClient('http://server:2591', {
    storage: { getItem: denied, setItem: denied, removeItem: denied },
  }).joinRoom('K7QM3D', profile);
  await Promise.resolve(); room.patch();
  const connection = await pending;
  expect(connection.snapshot().code).toBe('K7QM3D');
  expect(connection.send({ t: 'ping' })).toBe(true);
  await expect(connection.leave()).resolves.toBeUndefined();
});
