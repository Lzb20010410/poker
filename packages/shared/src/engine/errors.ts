/** SPEC §2.2 的完整协议错误码；房间级错误由后续服务端使用。 */
export type ErrorCode =
  | 'NOT_YOUR_TURN'
  | 'INVALID_ACTION'
  | 'RAISE_TOO_SMALL'
  | 'INSUFFICIENT_CHIPS'
  | 'ALREADY_FOLDED'
  | 'ALREADY_ALLIN'
  | 'HAND_NOT_STARTED'
  | 'NOT_SEATED'
  | 'NOT_HOST'
  | 'ROOM_FULL'
  | 'CONFIG_LOCKED';

export class RuleError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'RuleError';
    this.code = code;
  }
}
