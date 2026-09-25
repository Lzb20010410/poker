/**
 * 配对码（房间码）的生成与解析。
 *
 * 设计要点，都是踩过坑才写下来的：
 * - 字符集 32 个，剔除了 `I O 0 1`。玩家是在手机上照着语音念码的，
 *   `I/1/l`、`O/0` 分不清会直接把人挡在房间外。
 * - 大小写不敏感：`normalizePairingCode` 统一转大写，玩家不用管 Shift。
 * - 随机源注入（`RandomSource` 来自 shared），不用 `Math.random`。
 *   理由和 shared 一样：可复现、可测试。
 * - 碰撞重试由调用方传入 `isTaken` 判定，本模块不认识 Colyseus，
 *   这样才能纯单测，不用起服务端。
 *
 * 为什么码长是 6：32^6 ≈ 10.7 亿，朋友私局同时在线房间数是个位数，
 * 生日碰撞概率可以忽略。再长就要在手机上多敲字符，得不偿失。
 */

import { cryptoRandom, randomInt, type RandomSource } from './engine/random';

/** 可用字符集，32 个。已剔除易混淆的 I O 0 1 */
export const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' as const;

/** 配对码长度 */
export const PAIRING_CODE_LENGTH = 6;

/** 生成时最多尝试几次。5 次全撞车意味着码空间已被占满，应该报错而不是死循环 */
export const MAX_PAIRING_ATTEMPTS = 5;

/** 判定某个配对码是否已被占用。由调用方实现（服务端用 matchMaker 查） */
export type CodeTakenChecker = (code: string) => Promise<boolean>;

/** 配对码非法（格式不对，不是"房间不存在"）。玩家打错字属于这一类 */
export class InvalidPairingCodeError extends Error {
  readonly received: string;

  constructor(received: string) {
    super(`配对码格式非法：${JSON.stringify(received)}，应为 ${PAIRING_CODE_LENGTH} 位 ${PAIRING_ALPHABET} 中的字符`);
    this.name = 'InvalidPairingCodeError';
    this.received = received;
  }
}

/** 连续 MAX_PAIRING_ATTEMPTS 次生成的码都被占用 */
export class PairingCodesExhaustedError extends Error {
  readonly attempts: number;

  constructor(attempts: number) {
    super(`连续 ${attempts} 次生成的配对码都已被占用，码空间可能已耗尽`);
    this.name = 'PairingCodesExhaustedError';
    this.attempts = attempts;
  }
}

/** 生成一个配对码，不检查是否已被占用（那是 allocatePairingCode 的事） */
export function generatePairingCode(rand: RandomSource = cryptoRandom): string {
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i += 1) {
    // 非空断言安全：randomInt 返回 [0, PAIRING_ALPHABET.length)，索引必定命中。
    code += PAIRING_ALPHABET[randomInt(rand, PAIRING_ALPHABET.length)]!;
  }
  return code;
}

/**
 * 归一化玩家输入：转大写、去掉所有空白。
 *
 * 只去空白，不做别的"贴心纠正"（比如把 0 换成 O）：
 * O 和 0 都不在字符集里，换过去还是非法码，不如直接报错让玩家重打。
 */
export function normalizePairingCode(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

/** 归一化之后是否是合法配对码（长度对、字符全在字符集里） */
export function isValidPairingCode(code: string): boolean {
  if (code.length !== PAIRING_CODE_LENGTH) return false;
  for (const ch of code) {
    if (!PAIRING_ALPHABET.includes(ch)) return false;
  }
  return true;
}

/**
 * 解析玩家输入的配对码，非法则抛 InvalidPairingCodeError。
 *
 * 这里抛错是有意为之：客户端拿到明确的"码打错了"比拿到一个静默的
 * 空字符串好得多，能直接在 UI 上标红输入框。
 */
export function parsePairingCode(raw: unknown): string {
  const text = typeof raw === 'string' ? normalizePairingCode(raw) : '';
  if (!isValidPairingCode(text)) throw new InvalidPairingCodeError(text);
  return text;
}

/**
 * 生成一个**未被占用**的配对码。
 *
 * `isTaken` 是异步的（服务端要查 matchMaker），所以本函数也是异步的。
 * 撞车就重试，最多 `maxAttempts` 次；全部撞车抛 PairingCodesExhaustedError
 * ——宁可让创建房间失败，也不要发出一个会把两个房间混在一起的码。
 */
export async function allocatePairingCode(
  isTaken: CodeTakenChecker,
  options: { rand?: RandomSource; maxAttempts?: number } = {},
): Promise<string> {
  const rand = options.rand ?? cryptoRandom;
  const maxAttempts = options.maxAttempts ?? MAX_PAIRING_ATTEMPTS;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const code = generatePairingCode(rand);
    if (!(await isTaken(code))) return code;
  }
  throw new PairingCodesExhaustedError(maxAttempts);
}
