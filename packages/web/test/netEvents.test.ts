/**
 * M3.1 · `event` 通道的入站校验。
 *
 * ## 为什么这一层必须是「整条丢掉」而不是「缺什么补默认值」
 *
 * 这些载荷是动画的输入。少一个字段还硬播，玩家看到的就是筹码飞到不存在的座位、
 * 或者牌型名字是空的——比不播更难解释。而「丢掉一条广播」的代价只是少一段动画，
 * 权威状态仍然由 schema patch 兜住（SPEC §1.3），画面不会错。
 *
 * `net/view.ts` 那层面对的是 Colyseus 的 schema 实例（形状由服务端类定义锁死，
 * 只有哨兵值需要还原），这一层面对的是 `this.broadcast('event', ...)` 发出去的
 * **裸 JSON**：它没有任何类型保证，所以每个字段都得判。
 *
 * ## 未知 `t` 一律丢
 *
 * 服务端先升级、客户端还是旧版时会来不认识的事件。丢掉 = 旧客户端少段动画；
 * 硬塞进类型 = 后面的映射层拿到一个它不认识的形状，然后在 `.cards.length` 上崩掉。
 */

import { describe, expect, it } from 'vitest';

import { readBroadcastEvent } from '../src/net/events';

/** 一条字段齐全的广播事件，测试用覆盖的方式改坏其中任意一项 */
function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    t: 'board:deal',
    phase: 'flop',
    cards: [
      { rank: 14, suit: 's' },
      { rank: 13, suit: 'h' },
      { rank: 2, suit: 'd' },
    ],
    ...overrides,
  };
}

describe('readBroadcastEvent · 认得的形状原样通过', () => {
  it('14 种广播事件每种都能读出来，字段一个不丢', () => {
    const cases: readonly Record<string, unknown>[] = [
      { t: 'hand:start', handId: 'h1', dealerSeat: 0, sbSeat: 1, bbSeat: 2 },
      { t: 'shuffle' },
      { t: 'deal:start', count: 2, startSeat: 1 },
      event(),
      { t: 'board:deal', phase: 'turn', cards: [{ rank: 9, suit: 'c' }] },
      { t: 'action:made', seatIndex: 3, action: { type: 'fold' }, chipsDelta: 0 },
      {
        t: 'action:made',
        seatIndex: 3,
        action: { type: 'raise', totalBet: 60 },
        chipsDelta: 40,
      },
      { t: 'turn:change', seatIndex: 3, deadline: 1_700_000_000_000 },
      { t: 'round:end', phase: 'TURN' },
      { t: 'showdown:start', pots: [{ amount: 200, eligible: [1, 2] }] },
      {
        t: 'pot:awarded',
        potIndex: 0,
        winners: [1],
        amount: 200,
        handName: '一对',
        bestFive: [{ rank: 14, suit: 's' }],
      },
      { t: 'hand:end', results: [{ playerId: 'p1', seatIndex: 1, chips: 2200, delta: 200 }] },
      { t: 'player:joined', seatIndex: 4, profile: { id: 'p4', nickname: '小明', avatarSeed: 's4' } },
      { t: 'player:left', seatIndex: 4 },
      { t: 'player:emoji', seatIndex: 4, emoji: '🔥' },
      { t: 'chips:rebuy', seatIndex: 4 },
    ];
    for (const raw of cases) {
      const read = readBroadcastEvent(raw);
      expect(read).not.toBeNull();
      expect(read?.t).toBe(raw['t']);
    }
  });

  it('牌型名可选：`hand:end` 的结果里没带 handName 也算合形状', () => {
    const read = readBroadcastEvent({
      t: 'hand:end',
      results: [{ playerId: 'p1', seatIndex: 1, chips: 0, delta: -2000 }],
    });
    expect(read).not.toBeNull();
  });

  it('`bestFive` / `cards` 里多余的未知键不影响读取，只按需要的字段取值', () => {
    const read = readBroadcastEvent({
      t: 'board:deal',
      phase: 'river',
      cards: [{ rank: 7, suit: 'c', extra: '将来服务端加的字段' }],
    });
    expect(read).not.toBeNull();
    // 顶层多余的键同理：服务端给 `shuffle` 加个统计字段不该让旧客户端把洗牌动画丢掉
    expect(readBroadcastEvent({ t: 'shuffle', extraUnknown: 1 })).not.toBeNull();
  });
});

describe('readBroadcastEvent · 不合形状就整条丢掉', () => {
  it('不是对象、不是记录、`t` 不是字符串 → 丢', () => {
    for (const raw of [null, undefined, 42, 'event', [], {}, { t: 1 }, { t: null }]) {
      expect(readBroadcastEvent(raw)).toBeNull();
    }
  });

  it('客户端不认识的事件名 → 丢，不是当成某个默认事件', () => {
    expect(readBroadcastEvent({ t: 'board:reveal', cards: [] })).toBeNull();
  });

  it('缺必填数字字段 → 丢', () => {
    expect(readBroadcastEvent(event({ cards: undefined }))).toBeNull();
    expect(
      readBroadcastEvent({ t: 'pot:awarded', potIndex: 0, winners: [1], handName: '一对', bestFive: [] }),
    ).toBeNull();
    expect(readBroadcastEvent({ t: 'deal:start', count: 2 })).toBeNull();
  });

  it('座位号必须是「非负安全整数」：负数、小数、NaN 都丢', () => {
    // 0 是合法座位（也是大盲/按钮常年在的位置），所以不能用「假值」判
    expect(readBroadcastEvent({ t: 'player:left', seatIndex: 0 })).not.toBeNull();
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '2', null, undefined]) {
      expect(readBroadcastEvent({ t: 'player:left', seatIndex: bad })).toBeNull();
    }
  });

  it('筹码字段必须是整数：浮点筹码是协议违规，直接丢', () => {
    // 「铁律：所有金额字段一律是整数筹码」（shared/types.ts 文件头）。
    // 来了小数说明服务端或协议版本出了问题，动画不该猜一个数继续播。
    expect(readBroadcastEvent({ t: 'showdown:start', pots: [{ amount: 100.5, eligible: [1] }] })).toBeNull();
    expect(
      readBroadcastEvent({
        t: 'pot:awarded',
        potIndex: 0,
        winners: [1],
        amount: 200.5,
        handName: '一对',
        bestFive: [],
      }),
    ).toBeNull();
    expect(readBroadcastEvent({ t: 'action:made', seatIndex: 1, action: { type: 'fold' }, chipsDelta: 0 })).not.toBeNull();
    expect(
      readBroadcastEvent({
        t: 'action:made',
        seatIndex: 1,
        action: { type: 'call' },
        chipsDelta: 12.5,
      }),
    ).toBeNull();
    expect(
      readBroadcastEvent({
        t: 'hand:end',
        results: [{ playerId: 'p1', seatIndex: 1, chips: 100.5, delta: 0 }],
      }),
    ).toBeNull();
  });

  it('牌面非法 → 整条丢，而不是「其余几张照样播」', () => {
    // 公共牌动画是一段一段数着牌飞的：少一张就意味着后面每一张都落在错的位子上。
    // 这和 `readCards`（读 schema 里的公共牌列表）相反——那里丢一张只是少显示一张。
    const badSuit = [
      { rank: 14, suit: 's' },
      { rank: 13, suit: 'x' },
      { rank: 2, suit: 'd' },
    ];
    expect(readBroadcastEvent(event({ cards: badSuit }))).toBeNull();
    const badRank = [
      { rank: 1, suit: 's' },
      { rank: 13, suit: 'h' },
      { rank: 2, suit: 'd' },
    ];
    expect(readBroadcastEvent(event({ cards: badRank }))).toBeNull();
    expect(readBroadcastEvent(event({ cards: 'not-an-array' }))).toBeNull();
    expect(readBroadcastEvent(event({ cards: [] }))).toBeNull();
  });

  it('`phase` 只认 flop/turn/river，别的都丢', () => {
    for (const phase of ['preflop', 'FLOP', 'showdown', '', undefined]) {
      expect(readBroadcastEvent(event({ phase }))).toBeNull();
    }
  });

  it('`action` 必须是五种动作之一，`raise` 还得带整数总额', () => {
    for (const action of [{ type: 'muck' }, { type: 1 }, 'fold', { type: 'raise' }, { type: 'raise', totalBet: 60.5 }, {}]) {
      expect(
        readBroadcastEvent({ t: 'action:made', seatIndex: 1, action, chipsDelta: 0 }),
      ).toBeNull();
    }
    expect(
      readBroadcastEvent({ t: 'action:made', seatIndex: 1, action: { type: 'check' }, chipsDelta: 0 }),
    ).not.toBeNull();
  });

  it('列表里任何一条不合形状就整条丢：`pots`、`results`、`winners`、`eligible`', () => {
    expect(readBroadcastEvent({ t: 'showdown:start', pots: [{ amount: 100 }] })).toBeNull();
    expect(
      readBroadcastEvent({ t: 'showdown:start', pots: [{ amount: 100, eligible: [1, -2] }] }),
    ).toBeNull();
    expect(
      readBroadcastEvent({
        t: 'hand:end',
        results: [{ playerId: 'p1', seatIndex: 1, chips: 100, delta: 0 }, { playerId: '', seatIndex: 2, chips: 1, delta: 0 }],
      }),
    ).toBeNull();
    expect(readBroadcastEvent({ t: 'hand:end', results: 'nope' })).toBeNull();
    expect(
      readBroadcastEvent({
        t: 'pot:awarded',
        potIndex: 0,
        winners: [1, 'x'],
        amount: 100,
        handName: '一对',
        bestFive: [],
      }),
    ).toBeNull();
  });

  it('空 `pots` 不丢（服务端在没人有筹码时会发空池列表），空 `results` 同理', () => {
    expect(readBroadcastEvent({ t: 'showdown:start', pots: [] })).not.toBeNull();
    expect(readBroadcastEvent({ t: 'hand:end', results: [] })).not.toBeNull();
  });

  it('`player:joined` 的身份三个字段都得在且非空：缺任何一个都丢', () => {
    // 引擎发的是完整 `PlayerProfile`（`id` / `nickname` / `avatarSeed`，见 shared 的
    // `table-regressions.test.ts:150`）。少 `nickname` 气泡上不知道写谁，
    // 少 `avatarSeed` 会和别的缺字段的人共用一个头像。
    expect(
      readBroadcastEvent({ t: 'player:joined', seatIndex: 4, profile: { id: 'p4', nickname: '小明' } }),
    ).toBeNull();
    expect(
      readBroadcastEvent({ t: 'player:joined', seatIndex: 4, profile: { nickname: '', avatarSeed: 's', id: 'p4' } }),
    ).toBeNull();
    expect(readBroadcastEvent({ t: 'player:joined', seatIndex: 4, profile: '不是对象' })).toBeNull();
    expect(
      readBroadcastEvent({
        t: 'player:joined',
        seatIndex: 4,
        profile: { id: 'p4', nickname: '小明', avatarSeed: 's4' },
      }),
    ).not.toBeNull();
  });

  it('`player:emoji` 的表情串不能是空的', () => {
    expect(readBroadcastEvent({ t: 'player:emoji', seatIndex: 1, emoji: '' })).toBeNull();
    expect(readBroadcastEvent({ t: 'player:emoji', seatIndex: 1, emoji: '🎉' })).not.toBeNull();
  });
});
