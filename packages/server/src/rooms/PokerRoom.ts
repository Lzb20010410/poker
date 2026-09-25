/**
 * PokerRoom —— 一张牌桌的房间。
 *
 * M0.3 阶段只是个空壳：玩家能进来、能看到彼此的昵称、离开时能被移除。
 * 真正的牌局状态机在 shared/engine，M1.4 才会接上。
 *
 * ## 配对码就是 roomId（DECISIONS.md D-009）
 *
 * 原方案是「LobbyRoom 维护 配对码 ↔ roomId 映射」，实测 Colyseus 0.18 允许在
 * `onCreate()` 里覆写 `this.roomId`（即使在 `await` 之后），所以改成：
 * 生成一个没被占用的配对码，直接把它设为 roomId。
 *
 * 好处是砍掉了一整个 LobbyRoom、一张映射表、一次额外的 WebSocket 跳转，
 * 以及一个 HTTP 解析端点。玩家进房只需要 `sdk.joinById(配对码)`。
 *
 * ## 服务端权威
 *
 * schema 里的每一个字段都会广播给房间内所有客户端。
 * 所以：**对手的底牌、烧掉的牌、牌堆剩余，永远不进 schema。**
 * 底牌只能走 `client.send('deal:holeCards', ...)` 定向发送。
 * 本文件目前没有任何牌面信息，但这条规矩从第一行代码就要立住。
 */

import { DEFAULT_TABLE_CONFIG, sanitizeNickname } from '@poker-room/shared';
import { matchMaker, Room, type Client } from 'colyseus';

import { allocatePairingCode } from '../pairing';
import { PlayerSlot, PokerRoomState } from '../schema/PokerRoomState';

/** 玩家进房时可以带的参数。值一律当作不可信输入处理 */
export interface PokerRoomOptions {
  readonly nickname?: unknown;
}

/** 座位预定时长（秒）。玩家拿到配对码后去点链接，60 秒足够 */
const SEAT_RESERVATION_TIMEOUT_SEC = 60;

/**
 * 查配对码是否已被占用。
 *
 * 必须查：实测 Colyseus **不会**拒绝重复的 roomId —— 用同一个码再 create
 * 一次会成功，然后把第一个房间的缓存条目顶掉，结果是两个房间共用一个码、
 * 后来的玩家被分到新房间、先进来的人成了孤儿。这个检查是唯一的防线。
 *
 * 写成模块级函数而不是 static 方法：它不碰 `this`，而当函数值传给别人时
 * static 方法会触发 unbound-method（脱离类之后 this 绑定可能丢失）。
 */
export async function isPairingCodeTaken(code: string): Promise<boolean> {
  const rooms = await matchMaker.findRoomsByIds([code]);
  return rooms.has(code);
}

/**
 * 生命周期方法都要写 `override`：`Room` 基类把 `onCreate` / `onJoin` / `onLeave`
 * 声明成了可选属性，tsconfig 开了 `noImplicitOverride`，漏写会直接编译失败。
 */
export class PokerRoom extends Room<{ state: PokerRoomState }> {
  override async onCreate(): Promise<void> {
    // maxClients 默认是 Infinity，必须显式设置，否则一张桌子能挤进无限人
    this.maxClients = DEFAULT_TABLE_CONFIG.maxPlayers;
    this.seatReservationTimeout = SEAT_RESERVATION_TIMEOUT_SEC;
    // 最后一个玩家走了就销毁房间，配对码随之释放
    this.autoDispose = true;

    this.setState(new PokerRoomState());

    const code = await allocatePairingCode(isPairingCodeTaken);
    // onCreate 内（含 await 之后）允许覆写 roomId，已实测验证
    this.roomId = code;
    this.state.joinCode = code;
  }

  override onJoin(client: Client, options?: PokerRoomOptions): void {
    this.state.players.set(
      client.sessionId,
      new PlayerSlot({
        // 服务端做最终裁剪，绝不直接把客户端传来的字符串写进 state。
        // 拿不到昵称时用 sessionId 后 4 位兜底，保证同一房间里昵称不重复。
        nickname: sanitizeNickname(options?.nickname, `玩家${client.sessionId.slice(-4)}`),
      }),
    );
  }

  override onLeave(client: Client): void {
    this.state.players.delete(client.sessionId);
  }
}
