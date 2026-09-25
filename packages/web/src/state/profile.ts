/**
 * 玩家本地身份（昵称 + 头像 seed）的持久化。
 *
 * 项目没有账号系统（DECISIONS.md D-000），身份只存在浏览器 localStorage 里。
 * 这意味着：换浏览器、换设备、开无痕窗口，就是另一个人——这是**预期行为**，
 * 也是「开两个窗口自测联机」能成立的原因。
 *
 * ## 所有存储访问都包 try/catch
 *
 * Safari 无痕模式、以及用户把站点数据设成「阻止」时，**读** localStorage 也会抛
 * `SecurityError`（不只是写会抛 `QuotaExceededError`）。不接住就是白屏，
 * 而白屏是这个项目最不能接受的失败方式（TASKS.md M0.4 验收项之一）。
 * 存不下就不存，玩家每局重填一次昵称，功能不受影响。
 */

import {
  cryptoRandom,
  PAIRING_ALPHABET,
  randomInt,
  sanitizeAvatarSeed,
  sanitizeNickname,
  type RandomSource,
} from '@poker-room/shared';

/**
 * 存储键带版本号。
 *
 * 将来字段变了（比如 M2 加座位偏好）就换 `v2`，老数据自然读不出来、走默认值，
 * 比写迁移代码便宜得多——这里存的东西丢了完全无所谓。
 */
export const PROFILE_STORAGE_KEY = 'poker-room:profile:v1';

/** 头像 seed 长度。12 位 [A-Za-z0-9] 有 62^12 ≈ 3.2e21 种，撞不出两个一样的脸 */
export const AVATAR_SEED_LENGTH = 12;

/** 默认昵称的后缀长度。和 server 端 `玩家${sessionId.slice(-4)}` 的观感保持一致 */
const DEFAULT_NICKNAME_SUFFIX_LENGTH = 4;

const DEFAULT_NICKNAME_PREFIX = '玩家';

const SEED_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export interface StoredProfile {
  readonly nickname: string;
  readonly avatarSeed: string;
}

/**
 * 生成一个随机头像 seed。
 *
 * 字符集只用 `[A-Za-z0-9]`，因为 shared 的 `sanitizeAvatarSeed` 会把别的字符全删掉——
 * 这里要是生成一个带 `-` 的 seed，存到本地和发到服务端之后就会变成两个不同的值，
 * 头像会莫名其妙换脸。
 */
export function randomAvatarSeed(rand: RandomSource = cryptoRandom, length: number = AVATAR_SEED_LENGTH): string {
  let seed = '';
  for (let i = 0; i < length; i += 1) {
    // 非空断言安全：randomInt 返回 [0, SEED_ALPHABET.length)，索引必定命中。
    seed += SEED_ALPHABET[randomInt(rand, SEED_ALPHABET.length)]!;
  }
  return seed;
}

/**
 * 生成一个默认昵称，形如 `玩家K7QM`。
 *
 * 后缀用配对码字符集（已剔除 `I O 0 1`）而不是纯数字：手机上照着念给别人听时
 * 不会听岔。随机源同样可注入，测试里能固定下来。
 */
export function defaultNickname(rand: RandomSource = cryptoRandom): string {
  let suffix = '';
  for (let i = 0; i < DEFAULT_NICKNAME_SUFFIX_LENGTH; i += 1) {
    // 非空断言安全：同上，索引必定落在字符集内。
    suffix += PAIRING_ALPHABET[randomInt(rand, PAIRING_ALPHABET.length)]!;
  }
  return `${DEFAULT_NICKNAME_PREFIX}${suffix}`;
}

/** 全新的默认身份：随机昵称 + 随机头像。首次访问时用 */
export function createDefaultProfile(rand: RandomSource = cryptoRandom): StoredProfile {
  return { nickname: defaultNickname(rand), avatarSeed: randomAvatarSeed(rand) };
}

/**
 * 读取本地身份。返回 `null` 表示「没有可用的存档」，调用方应该生成默认值。
 *
 * 读出来还要再洗一遍，防的是手改 localStorage：存一段 4000 字符或带控制字符的
 * 昵称，服务端那边也会洗，但**本地 UI 会先被撑破**。洗不干净（比如整段都是
 * 零宽字符）就退化成 null 语义上的默认值——`sanitize*` 的兜底保证了非空。
 */
export function loadProfile(storage: Storage = window.localStorage): StoredProfile | null {
  const parsed = readStoredJson(storage);
  if (parsed === null) return null;

  const nickname = parsed['nickname'];
  const avatarSeed = parsed['avatarSeed'];
  if (typeof nickname !== 'string' || typeof avatarSeed !== 'string') return null;
  if (nickname.trim() === '' || avatarSeed.trim() === '') return null;

  return {
    nickname: sanitizeNickname(nickname, nickname),
    avatarSeed: sanitizeAvatarSeed(avatarSeed, avatarSeed),
  };
}

/** 写入本地身份。写失败静默忽略——存不下不影响这一局能玩 */
export function saveProfile(profile: StoredProfile, storage: Storage = window.localStorage): void {
  try {
    storage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // 无痕模式 / 配额满 / 存储被禁用。这一局照样能玩，只是下次要重填。
  }
}

/** 解析存储里的 JSON。任何一步失败都返回 null（键不存在、被手改成非 JSON、存储不可读） */
function readStoredJson(storage: Storage): Record<string, unknown> | null {
  let raw: string | null;
  try {
    raw = storage.getItem(PROFILE_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}
