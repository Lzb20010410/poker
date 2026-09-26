/**
 * 把 Colyseus / fetch 抛出来的东西翻译成**能直接显示给玩家的话**。
 *
 * 为什么需要这一层：SDK 抛的 `MatchMakeError` 消息是服务端原文
 * （`room "ABC123" not found`），既有英文又有内部术语，玩家看不懂，
 * 也不该看到。UI 只应该拿到「一句话说明 + 下一步怎么办」。
 *
 * ## 错误码是实测出来的，不是查文档猜的
 *
 * 用一个一次性探针打了真实的 HTTP，结果如下（Colyseus 0.18.16 / SDK 0.18.4）：
 *
 * | 情形 | HTTP status | body | SDK 抛出 |
 * |---|---|---|---|
 * | 码不存在 | `522` | `{"code":522,"error":"room \"ZZZZZZ\" not found"}` | `MatchMakeError`，`code === 522` |
 * | 房间已满 | `522` | `{"code":522,"error":"room \"5JXXJD\" is locked"}` | `MatchMakeError`，`code === 522` |
 * | 服务端没起 | —— | —— | `MatchMakeError`，`code === "ECONNREFUSED"`（**字符串**），`message === "fetch failed"` |
 *
 * 两个必须记住的结论：
 *
 * 1. **「房间不存在」和「房间已满」是同一个错误码 522。** Colyseus 在人满时会自动
 *    `lock()` 房间，而 `joinById` 一个 locked 房间抛的也是 `MATCHMAKE_INVALID_ROOM_ID`。
 *    只能靠 message 里的 `is locked` 区分——这条是版本相关的字符串匹配，
 *    万一将来匹配不上，会退化成「房间不存在」，提示虽然不够精确但不会误导成别的错误。
 * 2. **`MatchMakeError.code` 的类型声明是 `number`，运行时可能是字符串**
 *    （Node 下是 `ECONNREFUSED`，浏览器下 fetch 失败则压根没有 code，
 *    抛的是 `TypeError: Failed to fetch`）。所以下面所有判断都先过 `typeof`，
 *    绝不直接相信 SDK 的类型。
 */

import { ErrorCode } from '@colyseus/sdk';
import { DEFAULT_TABLE_CONFIG } from '@poker-room/shared/view';

/** 玩家会遇到的失败种类。UI 按这个分派文案，不做字符串匹配 */
export type ConnectionFailureKind =
  | 'room-not-found'
  | 'room-full'
  | 'link-expired'
  | 'server-unreachable'
  | 'unknown';

export interface ConnectionFailure {
  readonly kind: ConnectionFailureKind;
  /** 一句话说明发生了什么 */
  readonly title: string;
  /** 下一步怎么办。玩家看完应该知道该点什么 */
  readonly hint: string;
  /**
   * 原始错误信息，供开发者排查用，**UI 默认不展示**（只在 unknown 时折叠显示）。
   *
   * 已知的业务错误（房间不存在/已满/链接过期）这里恒为空：它们的 title 已经把话说清了，
   * 复述一遍服务端原文（`room "ABC123" is locked`）只会把内部细节摊到玩家面前。
   * unknown 与 server-unreachable 会带上原文，因为这两种情况没有它就等于瞎猜。
   */
  readonly detail: string;
}

/** Colyseus 满房时自动 lock，`joinById` 的报错消息里带这个片段（实测） */
const LOCKED_MARKER = 'is locked';

/**
 * 我们自己抛的超时错误。
 *
 * 需要它是因为 SDK 的连接流程里有两段**没有任何超时保护**的等待：
 * HTTP 配对请求、以及 join 成功后等第一个状态快照。服务端半死不活的时候
 * （进程还在但房间 tick 卡住）这两段能永久挂住，UI 就一直转圈。
 * 用自定义类而不是靠 message 字符串匹配来识别，是因为 message 是要给人看的，
 * 不该同时承担分类职责。
 */
export class ConnectionTimeoutError extends Error {
  readonly phase: string;
  readonly timeoutMs: number;

  constructor(phase: string, timeoutMs: number) {
    super(`${phase}超时（${timeoutMs}ms）`);
    this.name = 'ConnectionTimeoutError';
    this.phase = phase;
    this.timeoutMs = timeoutMs;
  }
}

/** WebSocket / 网络层的关闭码，出现这些就说明是连接问题而不是业务问题 */
const NETWORK_CLOSE_CODES: ReadonlySet<number> = new Set([
  1001, // going away
  1005, // no status received
  1006, // abnormal closure（断网、服务端被杀都是它）
  1011, // internal error
  1012, // service restart
  1013, // try again later
]);

/** fetch 失败在各环境下的措辞，全都要认得 */
const NETWORK_MESSAGE = /fetch failed|failed to fetch|networkerror|network request failed|econnrefused|enotfound|etimedout|ehostunreach|aborted|timeout/i;

export function describeConnectionError(error: unknown): ConnectionFailure {
  const { code, message, name } = inspect(error);

  if (name === 'AbortError') return unreachable('请求超时或被取消');
  if (name === 'ConnectionTimeoutError') return unreachable(message);

  if (typeof code === 'number') {
    if (code === ErrorCode.MATCHMAKE_INVALID_ROOM_ID) {
      return message.includes(LOCKED_MARKER) ? roomFull() : roomNotFound();
    }
    if (code === ErrorCode.MATCHMAKE_EXPIRED) return linkExpired();
    if (NETWORK_CLOSE_CODES.has(code)) return unreachable(`连接被关闭（${code}）`);
  }

  // code 不是数字：Node 下是 'ECONNREFUSED' 之类的字符串，浏览器下可能压根没有。
  // 两种情况都只看 message 就够了。
  if (NETWORK_MESSAGE.test(message)) return unreachable(message);

  return {
    kind: 'unknown',
    title: '没能连上房间',
    hint: '请稍后重试；如果一直失败，让房主确认服务端还在运行。',
    detail: message.length > 0 ? message : String(error),
  };
}

/**
 * 从任意 thrown value 里挖出我们关心的三个字段。
 *
 * 用结构化检查而不是 `instanceof MatchMakeError`：SDK 有可能被装了两份
 * （monorepo 里很常见），那样 `instanceof` 会静默失败，把已知的错误当成 unknown。
 */
function inspect(error: unknown): { code: unknown; message: string; name: string } {
  if (typeof error !== 'object' || error === null) {
    return { code: undefined, message: String(error), name: '' };
  }
  const bag = error as Record<string, unknown>;
  const message = typeof bag['message'] === 'string' ? bag['message'] : '';
  const name = typeof bag['name'] === 'string' ? bag['name'] : '';
  return { code: bag['code'], message, name };
}

function roomNotFound(): ConnectionFailure {
  return {
    kind: 'room-not-found',
    title: '房间不存在或已解散',
    hint: '核对一下配对码；如果房主已经关掉页面，房间会自动销毁，需要重新开一局。',
    detail: '',
  };
}

function roomFull(): ConnectionFailure {
  return {
    kind: 'room-full',
    title: '房间已经满了',
    hint: `这桌最多 ${DEFAULT_TABLE_CONFIG.maxPlayers} 人。让房主再开一桌，或者等有人离开。`,
    detail: '',
  };
}

function linkExpired(): ConnectionFailure {
  return {
    kind: 'link-expired',
    title: '进房链接已过期',
    hint: '座位预留只有 60 秒。回到大厅重新输入配对码即可。',
    detail: '',
  };
}

function unreachable(cause: string): ConnectionFailure {
  return {
    kind: 'server-unreachable',
    title: '连不上服务端',
    hint: '检查服务端是否在运行（默认端口 2567）；手机访问时还要确认和电脑在同一个局域网。',
    // cause 是给开发者看的，不是给玩家看的，所以放 detail 而不是 title
    detail: cause,
  };
}
