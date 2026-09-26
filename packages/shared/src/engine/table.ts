/** 服务端权威入口。TableState 含秘密牌堆，不能直接同步或序列化给客户端。 */
export { createTable } from './table-state';
export type {
  InitialTablePlayer,
  TableAccount,
  TableContext,
  TableParticipant,
  TableState,
  TableUpdate,
} from './table-state';
export {
  startHand,
  applyAction,
  applyPlayerAction,
  getTableLegalActions,
  tickTable,
  getTimeoutWarning,
} from './table-flow';
export { getPrivateMessages } from './table-settlement';
export {
  addTablePlayer,
  sitPlayer,
  standPlayer,
  setPlayerPresence,
  rebuyPlayer,
  setTableConfig,
  startTable,
} from './table-lifecycle';
