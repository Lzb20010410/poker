import { schema, t } from '@colyseus/schema';

/** 广播白名单：任何人的底牌、牌堆及烧牌都没有 schema 字段。 */
export const PublicCard = schema({ rank: t.number(), suit: t.string() }, 'PublicCard');
export const PublicConfig = schema({
  smallBlind: t.number(), bigBlind: t.number(), startingChips: t.number(),
  maxPlayers: t.number(), actionTimeoutSec: t.number(), minPlayersToStart: t.number(),
  // 桌布是这份配置里唯一的纯展示项：不进规则、只让「房主选的颜色」同步到每个人的界面。
  // 用 string 而不是枚举类型是因为 schema 侧只有标量基元；取值范围由引擎的 setTableConfig 把住。
  felt: t.string(),
}, 'PublicConfig');

/** 当前账户按认证 sessionId 索引，与本手冻结座位分开。 */
export const PlayerSlot = schema({
  id: t.string(), nickname: t.string(), avatarSeed: t.string(),
  seatIndex: t.number(), chips: t.number(), presence: t.string(),
  canFold: t.boolean(), canCheck: t.boolean(), callAmount: t.number(),
  canRaise: t.boolean(), minRaiseTotal: t.number(), maxRaiseTotal: t.number(), canAllIn: t.boolean(),
}, 'PlayerSlot');
export type PlayerSlot = InstanceType<typeof PlayerSlot>;

export const HandPlayer = schema({
  playerId: t.string(), seatIndex: t.number(), nickname: t.string(), avatarSeed: t.string(),
  folded: t.boolean(), allIn: t.boolean(), sittingOut: t.boolean(), hasActed: t.boolean(),
  committedThisStreet: t.number(), committedTotal: t.number(),
}, 'HandPlayer');
export const PublicPot = schema({ amount: t.number(), eligible: t.array('number') }, 'PublicPot');
export const PublicResult = schema({
  playerId: t.string(), seatIndex: t.number(), chips: t.number(), delta: t.number(), handName: t.string(),
}, 'PublicResult');

/** null 座位使用 -1，null 时间使用 0；筹码和毫秒均使用无损 number 编码。 */
export const PokerRoomState = schema({
  joinCode: t.string(), hostId: t.string(), phase: t.string(), handId: t.string(),
  handNo: t.number(), turnVersion: t.number(), serverTime: t.number(),
  dealerSeat: t.number(), sbSeat: t.number(), bbSeat: t.number(), currentTurn: t.number(),
  deadline: t.number(), nextHandAt: t.number(), currentBet: t.number(), lastRaiseSize: t.number(),
  runOutBoard: t.boolean(), potTotal: t.number(), introducedChips: t.number(), retainedChips: t.number(),
  config: t.ref(PublicConfig), players: t.map(PlayerSlot), handPlayers: t.map(HandPlayer),
  board: t.array(PublicCard), pots: t.array(PublicPot), results: t.array(PublicResult),
}, 'PokerRoomState');
export type PokerRoomState = InstanceType<typeof PokerRoomState>;
