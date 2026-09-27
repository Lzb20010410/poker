/**
 * 回放脚本的**记账**检查（M3.2）。
 *
 * ## 为什么这里几乎全是算术而不是画面
 *
 * 三个场景的每一个数字都是手填的：谁下多少、谁赢哪个池、分多少。手填一定会填错，
 * 而填错了不会有任何报错——只会播出一幕「桌上凭空多了一枚筹码」的动画，
 * 然后被当成动画的 bug 查半天。所以这里钉的是几条恒等式，它们不是规则、不需要引擎就能判：
 *
 * - **钱不多不少**：每一帧 `retainedChips + potTotal === 买入总额`。
 * - **池里的钱 = 各家已投之和**（只在还没开始派彩的街上成立，派彩那一刻两边会同时缩）。
 * - **公共牌张数对得上阶段**：翻牌 3 张、转牌 4 张、河牌 5 张。
 * - **一副牌里只有一张 J♠**：底牌与公共牌不许撞。
 *
 * ## 顺带钉住的那条红线
 *
 * AGENTS.md：别人的底牌绝不进公共状态。回放器把「服务端推来的快照」换成自己造的快照，
 * 于是这条红线在这里也**能被直接测**：任何一帧，只要还没有人摊牌，
 * 别人的底牌就不许出现在快照的任何角落（整份 `JSON.stringify` 扫一遍）。
 * 摊牌之后它们只能以 `reveals` 的形式出现，而且每张都必须属于亮牌的那个人——
 * 「老张的正面贴在老王身上」这种错就是这么抓的。
 *
 * ## 这里刻意**不**测的东西
 *
 * 不测「这个加注合法吗」「边池该怎么分层」——那是 `shared/engine` 的事，已经有各自的单测。
 * 在这里重算一遍就是第二处定义规则，正好是铁律要避免的那种分裂。
 */

import { describe, expect, it } from 'vitest';

import type { Card, Rank, S2C_Broadcast, Suit } from '@poker-room/shared/view';

import { planEvent, type AnimEnv } from '../src/anim/plan';
import { ANIM_BACKLOG_LIMIT } from '../src/anim/queue';
import {
  compileScenario,
  stampClock,
  type ReplayScenario,
  type ScriptFrame,
  type ScriptOp,
  type ScriptScenario,
} from '../src/dev/replayScript';
import { REPLAY_SCENARIOS } from '../src/dev/replayScenarios';

function c(rank: Rank, suit: Suit): Card {
  return { rank, suit };
}

/** 牌的同一性：同一张牌不管从哪个字段读出来都认得出来 */
function cardKey(card: Card): string {
  return `${String(card.rank)}${card.suit}`;
}

function scriptById(id: string): ScriptScenario {
  const found = REPLAY_SCENARIOS.find((scenario) => scenario.id === id);
  if (found === undefined) throw new Error(`没有 id 为 ${id} 的回放场景`);
  return found;
}

/** 这一帧（含）之前所有 `deal` 落下来的底牌，用来核对「亮的是不是他自己的牌」 */
function holesAt(script: ScriptScenario, frameIndex: number): (readonly [Card, Card] | null)[] {
  const holes: (readonly [Card, Card] | null)[] = script.seats.map(() => null);
  for (const frame of script.frames.slice(0, frameIndex + 1)) {
    for (const op of frame.ops) {
      if (op.t === 'deal') op.holes.forEach((hole, seat) => (holes[seat] = hole));
    }
  }
  return holes;
}

/** 一条事件里点到名的所有座位。查「座位号存不存在」用 */
function seatsInEvent(event: S2C_Broadcast): readonly number[] {
  switch (event.t) {
    case 'turn:change':
    case 'action:made':
    case 'player:emoji':
    case 'player:joined':
    case 'player:left':
    case 'chips:rebuy':
      return [event.seatIndex];
    case 'deal:start':
      return [event.startSeat];
    case 'pot:awarded':
      return event.winners;
    case 'hand:start':
      return [event.dealerSeat, event.sbSeat, event.bbSeat];
    case 'hand:end':
      return event.results.map((result) => result.seatIndex);
    case 'shuffle':
    case 'board:deal':
    case 'round:end':
    case 'showdown:start':
      return [];
  }
}

describe('回放脚本的记账恒等式', () => {
  for (const script of REPLAY_SCENARIOS) {
    describe(script.id, () => {
      const scenario: ReplayScenario = compileScenario(script, 0);
      const introduced = script.seats.reduce((sum, seat) => sum + seat.chips, 0);

      it('每一帧钱都不多不少：口袋 + 池 = 买入总额', () => {
        for (const frame of scenario.frames) {
          expect(frame.snapshot.retainedChips + frame.snapshot.potTotal, frame.label).toBe(introduced);
        }
      });

      it('还没派彩的那些帧：池里的钱正好等于各家已投之和', () => {
        for (const frame of scenario.frames) {
          if (frame.snapshot.awards.length > 0) continue;
          const committed = frame.snapshot.handPlayers.reduce((sum, row) => sum + row.committedTotal, 0);
          expect(committed, frame.label).toBe(frame.snapshot.potTotal);
        }
      });

      it('公共牌张数对得上阶段', () => {
        for (const frame of scenario.frames) {
          const { phase, board } = frame.snapshot;
          const expected = phase === 'FLOP' ? 3 : phase === 'TURN' ? 4 : phase === 'RIVER' ? 5 : null;
          if (expected === null) {
            // 其余阶段只要求落在牌面真实存在过的长度上：0（还没发）或 3/4/5（发完了）
            expect([0, 3, 4, 5], frame.label).toContain(board.length);
          } else {
            expect(board.length, frame.label).toBe(expected);
          }
        }
      });

      it('底牌与公共牌互不重复（一副牌里只有一张 J♠）', () => {
        const flat: string[] = [];
        for (const frame of script.frames) {
          for (const op of frame.ops) {
            if (op.t === 'deal') {
              for (const hole of op.holes) if (hole !== null) flat.push(cardKey(hole[0]), cardKey(hole[1]));
            }
            if (op.t === 'street') flat.push(...op.cards.map(cardKey));
            if (op.t === 'runout') for (const cards of op.streets) flat.push(...cards.map(cardKey));
          }
        }
        expect(flat.length).toBeGreaterThan(0);
        expect(new Set(flat).size).toBe(flat.length);
      });

      it('事件点到的座位都存在；deal:start 的张数与实际发出的底牌一致', () => {
        const maxPlayers = script.seats.length;
        script.frames.forEach((frame, index) => {
          const compiled = scenario.frames[index];
          if (compiled === undefined) throw new Error(`第 ${String(index)} 帧没编译出来`);
          const dealt = frame.ops.reduce(
            (count, op) => count + (op.t === 'deal' ? op.holes.filter((hole) => hole !== null).length : 0),
            0,
          );
          for (const event of compiled.events) {
            for (const seat of seatsInEvent(event)) {
              expect(seat, event.t).toBeGreaterThanOrEqual(0);
              expect(seat, event.t).toBeLessThan(maxPlayers);
            }
            if (event.t === 'deal:start') expect(event.count, frame.label).toBe(dealt);
            if (event.t === 'action:made') expect(event.chipsDelta, frame.label).toBeLessThanOrEqual(0);
          }
        });
      });

      it('别人的底牌只在摊牌之后、以他自己的那份出现在画面上', () => {
        scenario.frames.forEach((frame, index) => {
          const { snapshot } = frame;
          const holes = holesAt(script, index);

          // 我的底牌：永远等于脚本里给我的那一份
          expect(snapshot.holeCards, frame.label).toEqual(holes[0]);

          for (const row of snapshot.reveals) {
            const hole = holes[row.seatIndex];
            // 编译层本来就会拦住这件事（`reveal` 对着 `null` 手牌直接抛），这里再断一次：
            // 快照里亮着的正面必须逐字等于脚本发给那一格的手牌。
            if (hole === undefined || hole === null) throw new Error(`${frame.label}：亮了没发过的手牌`);
            expect(row.cards, frame.label).toEqual(hole);
          }

          // 还没人摊牌的那些帧：任何一张别人的底牌都不许出现在快照的任何角落
          if (snapshot.reveals.length === 0) {
            const surface = JSON.stringify(snapshot);
            for (let seat = 1; seat < holes.length; seat += 1) {
              const hole = holes[seat];
              if (hole === undefined || hole === null) continue;
              for (const card of hole) {
                expect(surface.includes(cardKey(card)), `${frame.label} 漏了 ${String(seat)} 号`).toBe(false);
              }
            }
          }
        });
      });

      it('legal 提示只落在「我」这一格，且不说「最多能下的比要跟的还少」', () => {
        const empty = {
          canFold: false,
          canCheck: false,
          callAmount: 0,
          canRaise: false,
          minRaiseTotal: 0,
          maxRaiseTotal: 0,
          canAllIn: false,
        };
        for (const frame of scenario.frames) {
          for (const player of frame.snapshot.players) {
            if (player.isSelf) continue;
            expect(player.legal, `${frame.label} / ${player.nickname}`).toEqual(empty);
          }
          const mine = frame.snapshot.players.find((player) => player.isSelf);
          if (mine === undefined) continue;
          expect(mine.legal.maxRaiseTotal, frame.label).toBeGreaterThanOrEqual(mine.legal.callAmount);
        }
      });
    });
  }
});

describe('池的分层与派彩（脚本自己得说得圆）', () => {
  it('边池场景：三个池都收得完，赢家必须在够得着这个池的人里', () => {
    const scenario = compileScenario(scriptById('side-pots'));
    const frame = scenario.frames.find((row) => row.snapshot.pots.length === 3);
    if (frame === undefined) throw new Error('边池场景没有切出三个池');

    const eligibleByPot = new Map(frame.snapshot.pots.map((pot, index) => [index, new Set(pot.eligible)]));
    for (const award of scenario.frames.flatMap((row) => row.snapshot.awards)) {
      const eligible = eligibleByPot.get(award.potIndex);
      if (eligible === undefined) throw new Error(`派彩指向了不存在的池 ${String(award.potIndex)}`);
      for (const winner of award.winners) expect(eligible.has(winner), award.handName).toBe(true);
    }

    const total = frame.snapshot.pots.reduce((sum, pot) => sum + pot.amount, 0);
    expect(total).toBe(frame.snapshot.introducedChips);
    // 越高的层人越少：主池 4 人、第一边池 3 人、第二边池 2 人
    expect(frame.snapshot.pots.map((pot) => pot.eligible.length)).toEqual([4, 3, 2]);
    // 每一层都是上一层的子集，否则「谁有资格拿这个池」在画面上就说不通了
    const layers = frame.snapshot.pots.map((pot) => pot.eligible);
    expect(layers[1]!.every((seat) => layers[0]!.includes(seat))).toBe(true);
    expect(layers[2]!.every((seat) => layers[1]!.includes(seat))).toBe(true);
  });

  it('平分底池：一个池两个赢家、两份一模一样，且 bestFive 全是公共牌', () => {
    const scenario = compileScenario(scriptById('eight-max-chop'));
    const award = scenario.frames.flatMap((frame) => frame.snapshot.awards).at(-1);
    if (award === undefined) throw new Error('8 人场景没有派彩');
    expect(award.winners).toEqual([0, 2]);
    expect(award.amount).toBe(2070);
    expect(award.bestFive).toHaveLength(5);
    const last = scenario.frames.at(-1);
    if (last === undefined) throw new Error('8 人场景一帧都没有');
    const board = new Set(last.snapshot.board.map(cardKey));
    for (const card of award.bestFive) expect(board.has(cardKey(card))).toBe(true);
  });

  it('无人跟注的派彩：不评估牌型、不翻任何人的牌、未跟到的那 300 退回原主', () => {
    const scenario = compileScenario(scriptById('heads-up-walk'));
    const frame = scenario.frames.find((row) => row.snapshot.awards.length > 0);
    if (frame === undefined) throw new Error('单挑场景没有派彩');
    const award = frame.snapshot.awards[0];
    if (award === undefined) throw new Error('单挑场景的派彩是空的');
    expect(award.bestFive).toEqual([]);
    expect(award.handName).toBe('其他玩家弃牌');
    expect(frame.snapshot.reveals).toEqual([]);
    expect(frame.snapshot.runOutBoard).toBe(false);
    // 未跟到的 300 从未进池，所以派彩只有 660 而不是 960
    expect(award.amount).toBe(660);
    expect(frame.events.some((event) => event.t === 'showdown:start')).toBe(false);
  });

  it('三个场景 = TASKS.md M3.2 要的三条：8 人正常一手、多人 all-in 边池、heads-up', () => {
    expect(REPLAY_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      'eight-max-chop',
      'side-pots',
      'heads-up-walk',
    ]);
    expect(scriptById('eight-max-chop').seats).toHaveLength(8);
    expect(scriptById('side-pots').seats).toHaveLength(4);
    expect(scriptById('heads-up-walk').seats).toHaveLength(2);
    for (const script of REPLAY_SCENARIOS) {
      const labels = script.frames.map((frame) => frame.label);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  it('三个场景的最终筹码（手填的账，最后由这几行钉死）', () => {
    const expected: Record<string, readonly number[]> = {
      'eight-max-chop': [1035, 1000, 1035, 1000, 1000, 1000, 990, 940],
      'side-pots': [400, 400, 600, 0],
      'heads-up-walk': [1330, 670],
    };
    for (const [id, chips] of Object.entries(expected)) {
      const last = compileScenario(scriptById(id)).frames.at(-1);
      if (last === undefined) throw new Error(`${id} 一帧都没有`);
      expect(last.snapshot.players.map((player) => player.chips), id).toEqual(chips);
    }
  });
});

/**
 * 编译层的错误路径与 run-out。
 *
 * run-out 值得单独验一次：线上「翻牌前全推 → 剩下三街一口气发完」是**一份 patch**
 *（`advanceHand()` 的 while 循环），一条 `round:end` 带三张 `board:deal`。
 * 回放器要是把它摊成三份，积压深度就和线上不是同一个东西了
 * ——那正是 `replayScript.ts` 头顶那节反复强调「一帧 = 一次 patch」的原因。
 */
describe('编译层', () => {
  const base: ScriptScenario = {
    id: 'broken',
    title: '坏脚本',
    summary: '用来验编译层会当场报错',
    smallBlind: 10,
    bigBlind: 20,
    seats: [
      { nickname: '甲', chips: 100 },
      { nickname: '乙', chips: 100 },
    ],
    frames: [],
  };

  const afterStart = (ops: readonly ScriptOp[]): ScriptScenario => ({
    ...base,
    frames: [{ label: 'a', ops: [{ t: 'start', dealer: 0, sb: 0, bb: 1 }, ...ops] }],
  });

  const twoFrames = (ops: readonly ScriptOp[]): ScriptScenario => ({
    ...base,
    frames: [
      { label: 'a', ops: [{ t: 'start', dealer: 0, sb: 0, bb: 1 }] },
      { label: 'b', ops },
    ],
  });

  it('掏不出这么多：当场报错', () => {
    expect(() => compileScenario(afterStart([{ t: 'act', seat: 0, action: { type: 'raise', totalBet: 500 } }]))).toThrow(
      /掏不出/,
    );
  });

  it('引用不存在的座位：当场报错', () => {
    expect(() => compileScenario(afterStart([{ t: 'act', seat: 7, action: { type: 'fold' } }]))).toThrow(/不存在的座位/);
  });

  it('亮没发过的牌：当场报错', () => {
    expect(() => compileScenario(afterStart([{ t: 'reveal', seats: [1] }]))).toThrow(/没发过的手牌/);
  });

  it('派彩派超了：当场报错', () => {
    expect(() =>
      compileScenario(
        twoFrames([
          { t: 'award', potIndex: 0, winners: [0], payouts: [[0, 9_999]], handName: '高牌', bestFive: [] },
        ]),
      ),
    ).toThrow(/超过/);
  });

  it('退还不许超过池：当场报错', () => {
    expect(() => compileScenario(twoFrames([{ t: 'refund', seat: 0, amount: 9_999 }]))).toThrow(/超过/);
  });

  it('run-out 发到第 6 张牌：当场报错', () => {
    expect(() =>
      compileScenario(
        twoFrames([
          {
            t: 'runout',
            streets: [
              [c(2, 's'), c(3, 's'), c(4, 's')],
              [c(5, 's')],
              [c(6, 's')],
              [c(7, 's')],
            ],
          },
        ]),
      ),
    ).toThrow(/落不到合法的一街/);
  });

  it('run-out：一份 patch 里一条 round:end 带三张 board:deal，牌面一次到齐', () => {
    const scenario = compileScenario(
      twoFrames([
        {
          t: 'runout',
          streets: [
            [c(2, 's'), c(3, 's'), c(4, 's')],
            [c(5, 's')],
            [c(6, 's')],
          ],
        },
      ]),
    );
    const frame = scenario.frames[1];
    if (frame === undefined) throw new Error('run-out 那一帧没编译出来');
    expect(frame.events.map((event) => event.t)).toEqual(['round:end', 'board:deal', 'board:deal', 'board:deal']);
    expect(frame.snapshot.board).toHaveLength(5);
    expect(frame.snapshot.phase).toBe('RIVER');
    expect(frame.snapshot.runOutBoard).toBe(true);
    // 跑完牌就没人该行动了：呼吸环和倒计时都不该挂着
    expect(frame.snapshot.currentTurn).toBeNull();
    expect(frame.deadlineMs).toBeNull();
  });

  it('时钟在应用的那一刻才落地：同一帧隔十分钟应用，倒计时仍是脚本写的那 12 秒', () => {
    const compiled = compileScenario(scriptById('heads-up-walk'));
    const withClock = compiled.frames.find((frame) => frame.deadlineMs !== null);
    if (withClock === undefined) throw new Error('场景里没有带行动时限的帧');
    const now = 1_000;
    const muchLater = now + 10 * 60 * 1_000;
    expect((stampClock(withClock, now).deadline ?? 0) - now).toBe(withClock.deadlineMs);
    expect((stampClock(withClock, muchLater).deadline ?? 0) - muchLater).toBe(withClock.deadlineMs);
  });
});

/**
 * 积压上限那笔账（SPEC §3.1「积压超过 12 段直接作废、直接渲染终态」）。
 *
 * `DevReplayPage` 文件头那句「哪几帧最重，`test/devReplay.test.ts` 把它逐帧钉成了一份清单」
 * 指的就是这一段。为什么钉在**计划**这一层、不在页面上看：jsdom 量不到真实盒子，
 * 找不到落点的那段动画会同步落终态、当场出队，于是页面上「队列 N 段」的峰值比浏览器里少一段。
 * 在页面上断言超线，测的是 jsdom 而不是玩家的屏幕。计划段数是纯函数，两边同一个数。
 */
describe('每一帧排几段动画（积压上限的账）', () => {
  const env: AnimEnv = { narrow: false };

  /**
   * 这一帧会排进队列的段数 = 广播流里排得上号的 + 「亮牌」那一段。
   *
   * 亮牌不产广播事件（D-002 / D-013 走定向消息），是页面从快照 `reveals` 的新行长出来的
   * （`anim/revealDelta.ts`），所以这一条要按脚本里的 `reveal` op 数，而不是按事件数。
   */
  function segmentsAt(scenario: ScriptScenario, frameIndex: number): number {
    const compiled = compileScenario(scenario);
    const frame = compiled.frames[frameIndex];
    if (frame === undefined) throw new Error(`场景 ${scenario.id} 没有第 ${String(frameIndex + 1)} 帧`);
    const scriptFrame = scenario.frames[frameIndex];
    if (scriptFrame === undefined) throw new Error(`脚本 ${scenario.id} 没有第 ${String(frameIndex + 1)} 帧`);
    const fromEvents = frame.events.filter((event) => planEvent(event, env) !== null).length;
    const revealsAsOne = scriptFrame.ops.some((op) => op.t === 'reveal' && op.seats.length > 0) ? 1 : 0;
    return fromEvents + revealsAsOne;
  }

  /** 一个场景的逐帧清单 */
  function table(scenario: ScriptScenario): string[] {
    return scenario.frames.map(
      (frame: ScriptFrame, index: number) =>
        `${String(index + 1).padStart(2, '0')} ${frame.label}：${String(segmentsAt(scenario, index))} 段`,
    );
  }

  /** 三个场景的清单。断言挂了就把它打在失败信息里（改脚本时能立刻看见哪一帧变重了） */
  function listing(): string {
    return REPLAY_SCENARIOS.map((scenario) => `${scenario.id}\n${table(scenario).join('\n')}`).join('\n\n');
  }

  it('三个场景的峰值：最重的一帧 6 段，留在上限之内', () => {
    const peaks: Record<string, number> = {};
    const over: string[] = [];
    for (const scenario of REPLAY_SCENARIOS) {
      const counts = scenario.frames.map((_frame, index) => segmentsAt(scenario, index));
      const peak = Math.max(...counts);
      if (peak === -Infinity) throw new Error(`场景 ${scenario.id} 一帧都没有`);
      peaks[scenario.id] = peak;
      scenario.frames.forEach((_frame, index) => {
        const count = segmentsAt(scenario, index);
        if (count > ANIM_BACKLOG_LIMIT) {
          const label = scenario.frames[index]?.label ?? '';
          over.push(`${scenario.id} 第 ${String(index + 1)} 帧「${label}」= ${String(count)} 段`);
        }
      });
    }
    /*
     * 8 人那一桌最重的一帧是「3 号全进 → 摊牌 → 平分」：行动 + 亮牌 + 派彩 + 本手结束 = 4 段。
     * 单挑最重的那帧带 `walk`（1 段派彩）+ 行动 + 本手结束 = 3 段——单人派彩路径不亮牌，
     * 所以那一帧没有亮牌那一段。
     */
    expect(peaks, listing()).toEqual({ 'eight-max-chop': 4, 'side-pots': 6, 'heads-up-walk': 3 });
    /*
     * 最重的一帧是边池场景最后一帧：三个池 = 三份派彩动画，6 段。
     * 它在旧上限 5 之下会被整队作废（三池不演派彩），D-036 把上限抬到 12 之后落在额度内。
     * 所以这条断言的真实作用是**反向守卫**：谁把 `ANIM_BACKLOG_LIMIT` 调回 5，这里立刻变红。
     */
    expect(over, listing()).toEqual([]);
  });
});
