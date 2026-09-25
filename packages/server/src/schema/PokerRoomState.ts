/**
 * 房间同步状态（Colyseus schema）。
 *
 * M0.3 阶段只同步「谁在房间里」，这是最小可用骨架。
 * 后续里程碑会往这里加牌局状态，但有一条铁律不变：
 *
 * **对手的底牌永远不进 schema。** schema 是广播给房间里所有人的，
 * 底牌只能通过 `client.send('deal:holeCards', ...)` 定向发给该玩家本人。
 * 同样不进 schema 的还有烧掉的牌和牌堆剩余部分。
 *
 * 用 builder API（`schema()` + `t.*`）而不是 `@type` 装饰器：
 * Colyseus 0.18 / @colyseus/schema 5.x 的推荐写法，且不依赖
 * experimentalDecorators 的 emit 顺序，编译产物更可预测。
 *
 * ## 命名：为什么叫 PlayerSlot 而不是 PlayerView
 *
 * `@poker-room/shared` 里会有一个纯领域类型 `PlayerView`（见 SPEC.md §1.1）。
 * 那一个是「规则引擎眼里的玩家」，这一个是「网络上同步的座位槽」，
 * 两者由 `engine-bridge.ts` 互相映射。同名会让桥接文件里到处是 import 别名，
 * 所以这里刻意错开。
 */

import { schema, t } from '@colyseus/schema';

/** 单个座位的公开视图。座位号、筹码等字段在 M1.5 加 */
export const PlayerSlot = schema(
  {
    nickname: t.string(),
    /**
     * 头像 seed，不是头像本身。
     *
     * 同步 seed 而不是 SVG：一个 DiceBear 头像的 data URI 约 15 KB，
     * 8 个人就是 120 KB 塞进每次全量同步；seed 只有十几个字符，
     * 各端用同一个 seed 本地算出一模一样的图。**永远不要往 schema 里塞图片。**
     */
    avatarSeed: t.string(),
  },
  'PlayerSlot',
);
export type PlayerSlot = InstanceType<typeof PlayerSlot>;

/** 房间根状态 */
export const PokerRoomState = schema(
  {
    /** 配对码。和 roomId 相同（见 DECISIONS.md D-009），前端用它拼分享链接 */
    joinCode: t.string(),
    /** key 是 Colyseus 的 sessionId */
    players: t.map(PlayerSlot),
  },
  'PokerRoomState',
);
export type PokerRoomState = InstanceType<typeof PokerRoomState>;
