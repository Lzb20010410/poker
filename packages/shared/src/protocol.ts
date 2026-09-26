import type { Action, Card, Phase, Pot, TableConfig } from './types';
import type { ErrorCode } from './engine/errors';

export interface PlayerProfile {
  readonly id: string;
  readonly nickname: string;
  readonly avatarSeed: string;
}

export interface PlayerResult {
  readonly playerId: string;
  readonly seatIndex: number;
  readonly chips: number;
  readonly delta: number;
  readonly handName?: string;
}

export type C2S =
  | { readonly t: 'table:setConfig'; readonly config: Partial<TableConfig> }
  | { readonly t: 'table:start' }
  | {
      readonly t: 'action';
      readonly action: Action;
      readonly handId: string;
      readonly turnVersion: number;
    }
  | { readonly t: 'rebuy' }
  | { readonly t: 'sit'; readonly seatIndex: number }
  | { readonly t: 'stand' }
  | { readonly t: 'emoji'; readonly emoji: 'fold-face' | 'laugh' | 'angry' | 'wave' }
  | { readonly t: 'ping' };

export type S2C_Private =
  | { readonly t: 'deal:holeCards'; readonly cards: readonly [Card, Card]; readonly handId: string }
  | {
      readonly t: 'showdown:reveal';
      /**
       * 亮牌也必须带手号，和 `deal:holeCards` 同一道门：客户端在换到下一手的 patch 里清空过
       * `reveals`，但一条迟到的上一手亮牌会在清空**之后**又被收下，而它的身份是拿新一手的
       * `handPlayers` 解析的 —— 座位没变、人换了，就会把 A 的牌型算到 B 头上（D-014 同源）。
       */
      readonly handId: string;
      readonly seatIndex: number;
      readonly cards: readonly [Card, Card];
    }
  | { readonly t: 'timeoutWarning'; readonly remainingSec: number }
  | {
      readonly t: 'error';
      readonly code: ErrorCode;
      readonly message: string;
      readonly ref?: unknown;
    };

export interface PrivateMessage {
  readonly playerId: string;
  readonly message: S2C_Private;
}

export type S2C_Broadcast =
  | {
      readonly t: 'hand:start';
      readonly handId: string;
      readonly dealerSeat: number;
      readonly sbSeat: number;
      readonly bbSeat: number;
    }
  | { readonly t: 'shuffle' }
  | { readonly t: 'deal:start'; readonly count: number; readonly startSeat: number }
  | {
      readonly t: 'board:deal';
      readonly phase: 'flop' | 'turn' | 'river';
      readonly cards: readonly Card[];
    }
  | {
      readonly t: 'action:made';
      readonly seatIndex: number;
      readonly action: Action;
      readonly chipsDelta: number;
    }
  | { readonly t: 'turn:change'; readonly seatIndex: number; readonly deadline: number }
  | { readonly t: 'round:end'; readonly phase: Phase }
  | { readonly t: 'showdown:start'; readonly pots: readonly Pot[] }
  | {
      readonly t: 'pot:awarded';
      readonly potIndex: number;
      readonly winners: readonly number[];
      readonly amount: number;
      readonly handName: string;
      readonly bestFive: readonly Card[];
    }
  | { readonly t: 'hand:end'; readonly results: readonly PlayerResult[] }
  | { readonly t: 'player:joined'; readonly seatIndex: number; readonly profile: PlayerProfile }
  | { readonly t: 'player:left'; readonly seatIndex: number }
  | { readonly t: 'player:emoji'; readonly seatIndex: number; readonly emoji: string }
  | { readonly t: 'chips:rebuy'; readonly seatIndex: number };
