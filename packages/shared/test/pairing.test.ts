import { describe, expect, it } from 'vitest';

import { mulberry32, type RandomSource } from '../src/engine/random';

import {
  allocatePairingCode,
  filterPairingInput,
  InvalidPairingCodeError,
  isValidPairingCode,
  MAX_PAIRING_ATTEMPTS,
  normalizePairingCode,
  PAIRING_ALPHABET,
  PAIRING_CODE_LENGTH,
  PairingCodesExhaustedError,
  generatePairingCode,
  parsePairingCode,
  type CodeTakenChecker,
} from '../src/pairing';

/** 测试用种子。固定下来，出问题才能复现 */
const SEED = 20260925;

/** 易混淆字符：语音报码时 I/1/l、O/0 分不清，会把人挡在房间外 */
const CONFUSABLE = ['I', 'O', '0', '1'];

/**
 * 造一个随机源，让它依次吐出指定的配对码（每个码消耗 6 次调用）。
 *
 * `(索引 + 0.5) / 32` 精确落在 randomInt 的第 index 个桶中央，
 * 不受浮点边界影响。超出给定码表后重复最后一个，避免越界。
 */
function stubRandForCodes(codes: readonly string[]): RandomSource {
  let call = 0;
  return () => {
    // 两处非空断言：Math.min 把索引夹在 [0, codes.length-1]（调用方保证 codes 非空），
    // `call % PAIRING_CODE_LENGTH` 必定落在码内（调用方给的每个码都是 6 位）。
    const code = codes[Math.min(Math.floor(call / PAIRING_CODE_LENGTH), codes.length - 1)]!;
    const ch = code[call % PAIRING_CODE_LENGTH]!;
    call += 1;
    return (PAIRING_ALPHABET.indexOf(ch) + 0.5) / PAIRING_ALPHABET.length;
  };
}

describe('PAIRING_ALPHABET', () => {
  it('正好 32 个字符，无重复', () => {
    expect(PAIRING_ALPHABET).toHaveLength(32);
    expect(new Set(PAIRING_ALPHABET).size).toBe(32);
  });

  it('剔除了 I O 0 1', () => {
    for (const ch of CONFUSABLE) {
      expect(PAIRING_ALPHABET).not.toContain(ch);
    }
  });

  it('由 24 个大写字母 + 8 个数字组成', () => {
    expect(PAIRING_ALPHABET).toMatch(/^[A-Z2-9]+$/);
    expect([...PAIRING_ALPHABET].filter((c) => c >= 'A' && c <= 'Z')).toHaveLength(24);
    expect([...PAIRING_ALPHABET].filter((c) => c >= '0' && c <= '9')).toHaveLength(8);
  });

  it('码空间 32^6 ≈ 10.7 亿，够朋友私局用', () => {
    expect(PAIRING_ALPHABET.length ** PAIRING_CODE_LENGTH).toBeGreaterThan(1_000_000_000);
  });
});

describe('generatePairingCode', () => {
  it('生成 10000 次：全部长度 6、字符全在字符集内、不含 I O 0 1', () => {
    const rand = mulberry32(SEED);
    for (let i = 0; i < 10_000; i += 1) {
      const code = generatePairingCode(rand);
      expect(code).toHaveLength(PAIRING_CODE_LENGTH);
      for (const ch of code) {
        expect(PAIRING_ALPHABET.includes(ch)).toBe(true);
        expect(CONFUSABLE).not.toContain(ch);
      }
    }
  });

  it('同一 seed 可复现（随机源注入的意义所在）', () => {
    expect(generatePairingCode(mulberry32(SEED))).toBe(generatePairingCode(mulberry32(SEED)));
  });

  it('不同 seed 产生不同的码', () => {
    expect(generatePairingCode(mulberry32(1))).not.toBe(generatePairingCode(mulberry32(2)));
  });

  it('10000 次里出现的字符种类覆盖整个字符集（没有偏移或截断）', () => {
    const rand = mulberry32(SEED);
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) {
      for (const ch of generatePairingCode(rand)) seen.add(ch);
    }
    expect(seen.size).toBe(PAIRING_ALPHABET.length);
  });

  it('不传随机源时用 cryptoRandom，仍然合法', () => {
    const code = generatePairingCode();
    expect(isValidPairingCode(code)).toBe(true);
  });
});

describe('normalizePairingCode', () => {
  it('转大写', () => {
    expect(normalizePairingCode('abc234')).toBe('ABC234');
    expect(normalizePairingCode('aBcDeF')).toBe('ABCDEF');
  });

  it('去掉所有空白（玩家常会把码分成两截念）', () => {
    expect(normalizePairingCode('  ABC 234  ')).toBe('ABC234');
    expect(normalizePairingCode('ABC\t234')).toBe('ABC234');
    expect(normalizePairingCode('A B C 2 3 4')).toBe('ABC234');
  });

  it('不做"贴心纠正"：0 和 1 保持原样，交给校验去拒绝', () => {
    expect(normalizePairingCode('ab01cd')).toBe('AB01CD');
  });
});

describe('isValidPairingCode', () => {
  it('合法码通过', () => {
    expect(isValidPairingCode('ABC234')).toBe(true);
    expect(isValidPairingCode('AAAAAA')).toBe(true);
    expect(isValidPairingCode('999999')).toBe(true);
  });

  it('长度不对直接拒', () => {
    expect(isValidPairingCode('')).toBe(false);
    expect(isValidPairingCode('ABC23')).toBe(false);
    expect(isValidPairingCode('ABC2345')).toBe(false);
  });

  it('易混淆字符不在字符集里，拒', () => {
    for (const ch of CONFUSABLE) {
      expect(isValidPairingCode(`ABC23${ch}`)).toBe(false);
    }
  });

  it('小写不算合法（必须先 normalize）', () => {
    expect(isValidPairingCode('abc234')).toBe(false);
  });

  it('其它符号拒', () => {
    expect(isValidPairingCode('ABC-23')).toBe(false);
    expect(isValidPairingCode('ABC 23')).toBe(false);
    expect(isValidPairingCode('德克萨斯州')).toBe(false);
  });
});

describe('parsePairingCode', () => {
  it('小写带空白也能解析成规范形式', () => {
    expect(parsePairingCode('  abc 234 ')).toBe('ABC234');
  });

  it('非法码抛 InvalidPairingCodeError，并带上归一化后的输入', () => {
    expect(() => parsePairingCode('abc')).toThrow(InvalidPairingCodeError);
    try {
      parsePairingCode(' abc123 ');
      expect.unreachable('应该抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidPairingCodeError);
      expect((error as InvalidPairingCodeError).received).toBe('ABC123');
      expect((error as Error).message).toMatch(/配对码格式非法/);
    }
  });

  it('非字符串输入一律当作非法（服务端永远不能信任客户端）', () => {
    for (const bad of [undefined, null, 123456, { code: 'ABC234' }, ['ABC234'], true]) {
      expect(() => parsePairingCode(bad)).toThrow(InvalidPairingCodeError);
      expect(() => parsePairingCode(bad)).toThrow(/配对码格式非法/);
    }
  });
});

describe('allocatePairingCode', () => {
  it('第一个码没被占用就直接返回', async () => {
    const queried: string[] = [];
    const code = await allocatePairingCode(
      async (c) => {
        queried.push(c);
        return false;
      },
      { rand: stubRandForCodes(['ABC234', 'DEF567']) },
    );
    expect(code).toBe('ABC234');
    expect(queried).toEqual(['ABC234']);
  });

  it('碰撞时重试并返回一个不同的码', async () => {
    const queried: string[] = [];
    const code = await allocatePairingCode(
      async (c) => {
        queried.push(c);
        return c === 'ABC234';
      },
      { rand: stubRandForCodes(['ABC234', 'DEF567']) },
    );
    expect(code).toBe('DEF567');
    expect(code).not.toBe('ABC234');
    expect(queried).toEqual(['ABC234', 'DEF567']);
  });

  it('连续碰撞多次后仍能在最后一次成功', async () => {
    const taken = new Set(['AAAAAA', 'BBBBBB', 'CCCCCC', 'DDDDDD']);
    const code = await allocatePairingCode(async (c) => taken.has(c), {
      rand: stubRandForCodes(['AAAAAA', 'BBBBBB', 'CCCCCC', 'DDDDDD', 'EEEEEE']),
    });
    expect(code).toBe('EEEEEE');
  });

  it('默认最多试 MAX_PAIRING_ATTEMPTS 次，全撞车就抛 PairingCodesExhaustedError', async () => {
    let calls = 0;
    await expect(
      allocatePairingCode(
        async () => {
          calls += 1;
          return true;
        },
        { rand: mulberry32(SEED) },
      ),
    ).rejects.toBeInstanceOf(PairingCodesExhaustedError);
    expect(calls).toBe(MAX_PAIRING_ATTEMPTS);
  });

  it('错误对象带上尝试次数和可读消息', async () => {
    try {
      await allocatePairingCode(async () => true, { rand: mulberry32(SEED), maxAttempts: 2 });
      expect.unreachable('应该抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(PairingCodesExhaustedError);
      expect((error as PairingCodesExhaustedError).attempts).toBe(2);
      expect((error as Error).message).toMatch(/连续 2 次/);
    }
  });

  it('maxAttempts 可覆盖，且 1 次就撞车时不会重试', async () => {
    let calls = 0;
    await expect(
      allocatePairingCode(
        async () => {
          calls += 1;
          return true;
        },
        { rand: mulberry32(SEED), maxAttempts: 1 },
      ),
    ).rejects.toThrow(/连续 1 次/);
    expect(calls).toBe(1);
  });

  it('不传随机源时用 cryptoRandom，返回的码合法', async () => {
    const code = await allocatePairingCode(async () => false);
    expect(isValidPairingCode(code)).toBe(true);
  });

  it('100 次分配出来的码互不相同（碰撞概率可忽略，这是回归网）', async () => {
    const rand = mulberry32(SEED);
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      seen.add(await allocatePairingCode(async () => false, { rand }));
    }
    expect(seen.size).toBe(100);
  });
});

/**
 * 预留钩子（reservation）。
 *
 * 这一组测的是「查重 + 占位」的原子性。`isTaken` 是异步的，所以两个房间各自查同一个码时
 * 都会看到"没人用"——服务端 `onCreate` 里 `allocatePairingCode` 一 await，另一个 create
 * 就挤进来了。预留要求在 `await` **之前**同步把码占住，第二个分配器才会换码。
 */
describe('allocatePairingCode 的预留（reservation）', () => {
  /** 用 Set 当成本进程的预留表，顺便记录调用顺序，便于断言"占位发生在查重之前" */
  function makeReservation(seed: Iterable<string> = []) {
    const held = new Set(seed);
    const calls: string[] = [];
    return {
      calls,
      held,
      reserve: (code: string): boolean => {
        calls.push(`reserve:${code}`);
        if (held.has(code)) return false;
        held.add(code);
        return true;
      },
      release: (code: string): void => {
        calls.push(`release:${code}`);
        held.delete(code);
      },
    };
  }

  it('占位在异步查重之前完成，不是查完才登记', async () => {
    const reservation = makeReservation();
    const code = await allocatePairingCode(
      async (c) => {
        reservation.calls.push(`isTaken:${c}`);
        return false;
      },
      { rand: stubRandForCodes(['ABC234']), reservation },
    );
    expect(code).toBe('ABC234');
    expect(reservation.calls).toEqual(['reserve:ABC234', 'isTaken:ABC234']);
  });

  it('两个分配器同时跑也不会拿到同一个码（这就是原来的 TOCTOU 竞态）', async () => {
    const reservation = makeReservation();
    // 两边各自的随机源都先吐 ABC234，制造"同时选中同一码"的场面。
    const gate = (() => {
      let releaseGate: () => void = () => undefined;
      const waiting = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      return { waiting, releaseGate };
    })();
    let inFlight = 0;
    let bothInside = 0;
    const slowTaken: CodeTakenChecker = async () => {
      inFlight += 1;
      // 第二个分配器必须在第一个还没拿到查重结果时就挤进来，否则这个测试没在测并发。
      if (inFlight === 2) bothInside += 1;
      await gate.waiting;
      inFlight -= 1;
      return false;
    };
    const first = allocatePairingCode(slowTaken, {
      rand: stubRandForCodes(['ABC234', 'DEF567']),
      reservation,
    });
    const second = allocatePairingCode(slowTaken, {
      rand: stubRandForCodes(['ABC234', 'DEF567']),
      reservation,
    });
    gate.releaseGate();
    const [a, b] = await Promise.all([first, second]);
    expect(bothInside).toBe(1);
    expect([a, b].sort()).toEqual(['ABC234', 'DEF567']);
    expect(a).not.toBe(b);
  });

  it('查重说"已被占用"时归还预留，好让后来的分配器能复用这个码', async () => {
    const reservation = makeReservation();
    const code = await allocatePairingCode(
      async (c) => c === 'ABC234',
      { rand: stubRandForCodes(['ABC234', 'DEF567']), reservation },
    );
    expect(code).toBe('DEF567');
    expect(reservation.calls).toEqual([
      'reserve:ABC234', 'release:ABC234', 'reserve:DEF567',
    ]);
    expect(reservation.held.has('ABC234')).toBe(false);
  });

  it('本地已经占着的码根本不去查(matchMaker)，直接换下一个码', async () => {
    const reservation = makeReservation(['ABC234']);
    const queried: string[] = [];
    const code = await allocatePairingCode(
      async (c) => {
        queried.push(c);
        return false;
      },
      { rand: stubRandForCodes(['ABC234', 'DEF567']), reservation },
    );
    expect(code).toBe('DEF567');
    expect(queried).toEqual(['DEF567']);
    expect(reservation.calls).toEqual(['reserve:ABC234', 'reserve:DEF567']);
  });

  it('查重抛错时同样归还预留，不留占着又没人用的死码', async () => {
    const reservation = makeReservation();
    await expect(
      allocatePairingCode(async () => {
        throw new Error('匹配驱动挂了');
      }, { rand: stubRandForCodes(['ABC234']), reservation }),
    ).rejects.toThrow(/匹配驱动挂了/);
    expect(reservation.calls).toEqual(['reserve:ABC234', 'release:ABC234']);
    expect(reservation.held.size).toBe(0);
  });

  it('不传 reservation 时行为跟以前一致：只按 isTaken 决定', async () => {
    const queried: string[] = [];
    const code = await allocatePairingCode(
      async (c) => {
        queried.push(c);
        return c === 'ABC234';
      },
      { rand: stubRandForCodes(['ABC234', 'DEF567']) },
    );
    expect(code).toBe('DEF567');
    expect(queried).toEqual(['ABC234', 'DEF567']);
  });
});

describe('filterPairingInput（输入框实时收敛）', () => {
  it('小写自动转大写', () => {
    expect(filterPairingInput('abc234')).toBe('ABC234');
  });

  it('所有空白都被去掉，包括夹在中间的', () => {
    expect(filterPairingInput(' AB 3\t4\n5 ')).toBe('AB345');
  });

  it('易混淆字符 I O 0 1 被直接过滤掉', () => {
    expect(filterPairingInput('IO01')).toBe('');
    expect(filterPairingInput('A1B2O3')).toBe('AB23');
  });

  it('字符集以外的东西（中文、标点、emoji）全被过滤', () => {
    expect(filterPairingInput('德州-ABC!@#')).toBe('ABC');
  });

  it('空输入得到空串，不抛错（允许中间态）', () => {
    expect(filterPairingInput('')).toBe('');
    expect(filterPairingInput('   ')).toBe('');
  });

  it('超过 6 位被截断，粘贴一整段也只留前 6 个合法字符', () => {
    expect(filterPairingInput('ABCDEFGH')).toBe('ABCDEF');
    expect(filterPairingInput('配对码是 ABCDEFGHIJ 快进来')).toBe('ABCDEF');
  });

  /**
   * 顺序断言，也是最容易写错的一条：**必须先过滤再截断**。
   * 反过来的话 `'IIIIIIABC'` 会先被截成 `'IIIIII'`、再过滤成 `''`，
   * 玩家明明敲对了码却什么都看不见。
   */
  it('先过滤后截断：前面一堆非法字符不会把后面的合法字符挤掉', () => {
    expect(filterPairingInput('IIIIIIABC')).toBe('ABC');
    expect(filterPairingInput('0000000000ABCDEF')).toBe('ABCDEF');
  });

  it('幂等：对结果再过滤一次不会变', () => {
    for (const raw of ['abc234', '  A B  ', 'IO01XYZ', '德州ABC', '']) {
      const once = filterPairingInput(raw);
      expect(filterPairingInput(once)).toBe(once);
    }
  });

  /**
   * 性质测试：不管喂什么进去，出来的一定是「合法配对码的前缀」。
   * 这条比逐个举例更有价值——输入框会把它直接塞进受控组件的 value，
   * 一旦漏出非法字符，UI 上就会显示一个玩家敲不出来的码。
   */
  it('输出永远是合法配对码的前缀', () => {
    const nasty = [
      '',
      'a',
      'abcdef',
      'ABCDEFGHIJKLMN',
      '0123456789',
      'ioIO',
      '  \t\n  ',
      '德州扑克',
      '\u0000\u001b[31mABC',
      '\u202EABC\u202C',
      '😀🃏ABC',
      'AbC-dEf_GhI',
    ];
    for (const raw of nasty) {
      const out = filterPairingInput(raw);
      expect([...out].length).toBeLessThanOrEqual(PAIRING_CODE_LENGTH);
      for (const ch of out) {
        expect(PAIRING_ALPHABET).toContain(ch);
      }
      // 长度刚好 6 时就该是一个合法码（可以直接提交）
      if ([...out].length === PAIRING_CODE_LENGTH) {
        expect(isValidPairingCode(out)).toBe(true);
      }
    }
  });

  it('合法码经过它之后原样不变', () => {
    const code = generatePairingCode(mulberry32(SEED));
    expect(filterPairingInput(code)).toBe(code);
  });
});
