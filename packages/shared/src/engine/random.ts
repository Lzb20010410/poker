/**
 * 可注入随机源（RULES-SPEC §1.2）。
 *
 * 为什么要有这个文件：本包禁止直接调用 Math.random()（ESLint no-restricted-properties
 * 与 scripts/check-arch.mjs 双重强制）。理由不是洁癖，而是——
 *
 *   1. 洗牌必须可复现，否则任何一手牌的 bug 都无法稳定重跑；
 *   2. Math.random() 不是密码学安全的，服务端用它洗牌在理论上可被预测。
 *
 * 所以随机性一律作为**参数**传进来：生产用 cryptoRandom，测试用 mulberry32(seed)。
 * 同一个 seed 必须产生同一副牌序，这是所有回归测试的地基。
 */

/** 随机源：无参函数，返回值必须落在 [0, 1) */
export type RandomSource = () => number;

const UINT32_SPACE = 2 ** 32;

/**
 * 默认随机源，基于 Web Crypto。
 *
 * 用 globalThis.crypto 而不是 `import 'node:crypto'`：本包必须在浏览器和 Node
 * 两端原样运行、零平台依赖（AGENTS.md 分层铁律）。Node 20+（package.json engines
 * 已锁定）与所有现代浏览器都提供全局 crypto。
 *
 * 走 DataView 而不是读 Uint32Array[0]：后者在 noUncheckedIndexedAccess 下类型是
 * `number | undefined`，逼出一段永远走不到的防御代码。
 */
export function cryptoRandom(): number {
  const webcrypto = globalThis.crypto;
  if (webcrypto === undefined) {
    throw new Error('当前运行时没有 globalThis.crypto，无法获取安全随机数；请显式注入 RandomSource');
  }
  const buffer = new ArrayBuffer(4);
  webcrypto.getRandomValues(new Uint8Array(buffer));
  return new DataView(buffer).getUint32(0) / UINT32_SPACE;
}

/**
 * mulberry32 —— 32 位种子的伪随机数生成器，仅供测试与本地回放使用。
 *
 * 不用于生产：周期短、可预测。它存在的唯一目的是让测试可复现。
 */
export function mulberry32(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32_SPACE;
  };
}

/**
 * 取 [0, maxExclusive) 内的整数。Fisher-Yates 用它选下标。
 *
 * 对随机源做上下界校验并抛错，而不是 clamp：越界的随机源意味着调用方注入了
 * 错误的东西，静默 clamp 会把偏差藏进洗牌分布里，比直接崩掉难查得多。
 */
export function randomInt(rand: RandomSource, maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
    throw new Error(`randomInt 的上界必须是正整数，收到 ${String(maxExclusive)}`);
  }
  const value = rand();
  if (Number.isNaN(value) || value < 0 || value >= 1) {
    throw new Error(`随机源必须返回 [0, 1) 内的数字，收到 ${String(value)}`);
  }
  return Math.floor(value * maxExclusive);
}
