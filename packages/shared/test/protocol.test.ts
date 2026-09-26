import { expectTypeOf, it } from 'vitest';
import type {
  Action,
  Card,
  C2S,
  ErrorCode,
  Phase,
  PlayerProfile,
  PlayerResult,
  Pot,
  PrivateMessage,
  S2C_Broadcast,
  S2C_Private,
  TableConfig,
} from '../src';

it('C2S uses SPEC message names with mandatory stale-action protection and no client chips', () => {
  expectTypeOf<C2S>().toEqualTypeOf<
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
    | { readonly t: 'ping' }
  >();
});

it('private envelopes alone carry hole cards, with readonly tuples and exact error payload', () => {
  expectTypeOf<PrivateMessage>().toEqualTypeOf<{
    readonly playerId: string;
    readonly message: S2C_Private;
  }>();
  expectTypeOf<S2C_Private>().toEqualTypeOf<
    | {
        readonly t: 'deal:holeCards';
        readonly cards: readonly [Card, Card];
        readonly handId: string;
      }
    | {
        readonly t: 'showdown:reveal';
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
      }
  >();
});

it('broadcasts conform exactly to SPEC and never contain a private deal or solver object', () => {
  expectTypeOf<S2C_Broadcast>().toEqualTypeOf<
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
    | { readonly t: 'chips:rebuy'; readonly seatIndex: number }
  >();
  expectTypeOf<PlayerProfile>().toEqualTypeOf<{
    readonly id: string;
    readonly nickname: string;
    readonly avatarSeed: string;
  }>();
  expectTypeOf<PlayerResult>().toEqualTypeOf<{
    readonly playerId: string;
    readonly seatIndex: number;
    readonly chips: number;
    readonly delta: number;
    readonly handName?: string;
  }>();
});
