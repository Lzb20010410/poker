/**
 * 错误翻译层的测试。
 *
 * 这里的输入形状全部来自**实测**（见 `src/net/errors.ts` 顶部的表格），
 * 不是照着 SDK 的类型声明写的——声明说 `code: number`，实测服务端没起时
 * 拿到的是字符串 `"ECONNREFUSED"`。所以断言里刻意混用了 number / string /
 * 干脆没有 code 的三种情况。
 */

import { ErrorCode } from '@colyseus/sdk';
import { DEFAULT_TABLE_CONFIG } from '@poker-room/shared';
import { describe, expect, it } from 'vitest';

import { ConnectionTimeoutError, describeConnectionError } from '../src/net/errors';

/** 造一个 SDK 风格的 MatchMakeError。不用 `instanceof` 判定，所以普通对象就够 */
function matchMakeError(code: unknown, message: string): { name: string; code: unknown; message: string } {
  return { name: 'MatchMakeError', code, message };
}

describe('describeConnectionError · 配对码相关', () => {
  it('房间不存在 → room-not-found，并且不把服务端原文摊给玩家', () => {
    const failure = describeConnectionError(matchMakeError(ErrorCode.MATCHMAKE_INVALID_ROOM_ID, 'room "ZZZZZZ" not found'));
    expect(failure.kind).toBe('room-not-found');
    expect(failure.title).toBe('房间不存在或已解散');
    expect(failure.detail).toBe('');
    expect(failure.hint).toContain('配对码');
  });

  it('房间已满（同样 522，只能靠 is locked 区分）→ room-full', () => {
    const failure = describeConnectionError(matchMakeError(ErrorCode.MATCHMAKE_INVALID_ROOM_ID, 'room "5JXXJD" is locked'));
    expect(failure.kind).toBe('room-full');
    expect(failure.title).toBe('房间已经满了');
    expect(failure.detail).toBe('');
    expect(failure.hint).toContain(String(DEFAULT_TABLE_CONFIG.maxPlayers));
  });

  it('座位预留过期 → link-expired', () => {
    const failure = describeConnectionError(matchMakeError(ErrorCode.MATCHMAKE_EXPIRED, 'room creation expired'));
    expect(failure.kind).toBe('link-expired');
    expect(failure.detail).toBe('');
  });
});

describe('describeConnectionError · 连不上服务端', () => {
  it('Node 下 code 是字符串 ECONNREFUSED（类型声明骗人）', () => {
    const failure = describeConnectionError(matchMakeError('ECONNREFUSED', 'fetch failed'));
    expect(failure.kind).toBe('server-unreachable');
    expect(failure.detail).toBe('fetch failed');
  });

  it('浏览器下 fetch 失败是 TypeError，压根没有 code', () => {
    const failure = describeConnectionError(new TypeError('Failed to fetch'));
    expect(failure.kind).toBe('server-unreachable');
    expect(failure.hint).toContain('2567');
  });

  it('AbortError（请求被取消 / 浏览器超时）', () => {
    const failure = describeConnectionError({ name: 'AbortError', message: 'This operation was aborted' });
    expect(failure.kind).toBe('server-unreachable');
    expect(failure.detail).toBe('请求超时或被取消');
  });

  it('我们自己抛的 ConnectionTimeoutError 走同一条路，并且带上是哪个阶段超时', () => {
    const error = new ConnectionTimeoutError('等待房间初始状态', 10_000);
    expect(error.name).toBe('ConnectionTimeoutError');
    expect(error.phase).toBe('等待房间初始状态');
    expect(error.timeoutMs).toBe(10_000);
    expect(error.message).toContain('10000ms');

    const failure = describeConnectionError(error);
    expect(failure.kind).toBe('server-unreachable');
    expect(failure.detail).toBe(error.message);
  });

  it('WebSocket 异常关闭码（1006 = 断网 / 服务端被杀）', () => {
    const failure = describeConnectionError(matchMakeError(1006, ''));
    expect(failure.kind).toBe('server-unreachable');
    expect(failure.detail).toContain('1006');
  });
});

describe('describeConnectionError · 兜底', () => {
  it('普通 Error 落到 unknown，detail 保留原文供排查', () => {
    const failure = describeConnectionError(new Error('schema decode blew up'));
    expect(failure.kind).toBe('unknown');
    expect(failure.title).toBe('没能连上房间');
    expect(failure.detail).toBe('schema decode blew up');
  });

  it('数字 code 但不在已知集合里，也不像网络错误 → unknown', () => {
    const failure = describeConnectionError(matchMakeError(4000, 'something odd'));
    expect(failure.kind).toBe('unknown');
  });

  it('抛出来的根本不是对象（`throw "字符串"` 这种事真会发生）', () => {
    const failure = describeConnectionError('just a string');
    expect(failure.kind).toBe('unknown');
    expect(failure.detail).toBe('just a string');
  });

  it('没有 message 的对象，detail 退化成 String(error) 而不是空串', () => {
    const failure = describeConnectionError({});
    expect(failure.kind).toBe('unknown');
    expect(failure.detail).not.toBe('');
  });

  it('null 和 undefined 也不炸', () => {
    expect(describeConnectionError(null).kind).toBe('unknown');
    expect(describeConnectionError(undefined).kind).toBe('unknown');
  });
});
