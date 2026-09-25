/**
 * 本地身份的存取测试。
 *
 * 重点不是「能存能读」，而是两条会让人白屏的边界：
 * 1. localStorage **读**也会抛（Safari 无痕、站点数据被禁用）；
 * 2. 存档可能是人手改过的脏数据（超长、非 JSON、字段类型不对）。
 */

import { mulberry32, PAIRING_ALPHABET } from '@poker-room/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  AVATAR_SEED_LENGTH,
  createDefaultProfile,
  defaultNickname,
  loadProfile,
  PROFILE_STORAGE_KEY,
  randomAvatarSeed,
  saveProfile,
} from '../src/state/profile';

/** 一个所有方法都抛 SecurityError 的 Storage，用来模拟无痕模式 */
function storageThatThrows(): Storage {
  const boom = (): never => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  };
  return { length: 0, clear: boom, getItem: boom, key: boom, removeItem: boom, setItem: boom };
}

function writeRaw(value: string): void {
  window.localStorage.setItem(PROFILE_STORAGE_KEY, value);
}

/** 默认昵称的前缀。shared 那边没导出常量，这里跟着写死，改了会红 */
const NICKNAME_PREFIX = '玩家';

beforeEach(() => {
  window.localStorage.clear();
});

describe('randomAvatarSeed', () => {
  it('同一种子同长度，结果确定（DiceBear 要靠这个保证各端同一张脸）', () => {
    expect(randomAvatarSeed(mulberry32(42))).toBe(randomAvatarSeed(mulberry32(42)));
  });

  it('不同种子结果不同', () => {
    expect(randomAvatarSeed(mulberry32(1))).not.toBe(randomAvatarSeed(mulberry32(2)));
  });

  it('默认 12 位，且只用 [A-Za-z0-9]', () => {
    const seed = randomAvatarSeed(mulberry32(7));
    expect(seed).toHaveLength(AVATAR_SEED_LENGTH);
    expect(seed).toMatch(/^[A-Za-z0-9]+$/);
  });

  it('字符集刻意与 sanitizeAvatarSeed 保留的字符一致，否则存进服务端会换脸', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(randomAvatarSeed(mulberry32(i))).toMatch(/^[A-Za-z0-9]+$/);
    }
  });

  it('长度可以指定', () => {
    expect(randomAvatarSeed(mulberry32(9), 4)).toHaveLength(4);
  });
});

describe('defaultNickname', () => {
  it('形如「玩家K7QM」，后缀只用配对码字符集（不含 I O 0 1）', () => {
    const name = defaultNickname(mulberry32(3));
    const suffix = name.slice(NICKNAME_PREFIX.length);
    expect(name.startsWith(NICKNAME_PREFIX)).toBe(true);
    expect(suffix).toHaveLength(4);
    for (const ch of suffix) expect(PAIRING_ALPHABET).toContain(ch);
    // 手机上要照着念给别人听，所以字符集里不能有会听岔的那几个
    expect(PAIRING_ALPHABET).not.toContain('I');
    expect(PAIRING_ALPHABET).not.toContain('O');
    expect(PAIRING_ALPHABET).not.toContain('0');
    expect(PAIRING_ALPHABET).not.toContain('1');
  });

  it('同一种子结果确定', () => {
    expect(defaultNickname(mulberry32(11))).toBe(defaultNickname(mulberry32(11)));
  });
});

describe('createDefaultProfile', () => {
  it('两个字段都非空，可以直接进房', () => {
    const profile = createDefaultProfile(mulberry32(5));
    expect(profile.nickname.length).toBeGreaterThan(0);
    expect(profile.avatarSeed.length).toBeGreaterThan(0);
  });
});

describe('loadProfile', () => {
  it('没有存档时返回 null（调用方据此生成默认值）', () => {
    expect(loadProfile()).toBeNull();
  });

  it('正常存档能读回来', () => {
    saveProfile({ nickname: '阿博', avatarSeed: 'Seed123' });
    expect(loadProfile()).toEqual({ nickname: '阿博', avatarSeed: 'Seed123' });
  });

  it('存进去的会被再洗一遍：手改 localStorage 塞不进控制字符', () => {
    // BEL(U+0007) 会被 C0 过滤掉，RLO(U+202E) 是经典的昵称伪装手法，也必须掉
    writeRaw(JSON.stringify({ nickname: 'a\u0007b\u202ec', avatarSeed: 'ok seed!!' }));
    const loaded = loadProfile();
    expect(loaded).not.toBeNull();
    expect(loaded?.nickname).toBe('abc');
    expect(loaded?.avatarSeed).toBe('okseed');
  });

  it('非 JSON / 数组 / 字符串 / 数字，一律当成没有存档', () => {
    for (const raw of ['{不是 json', '[1,2,3]', '"hello"', '42', 'null']) {
      writeRaw(raw);
      expect(loadProfile(), `raw=${raw}`).toBeNull();
    }
  });

  it('字段缺失或类型不对 → null', () => {
    writeRaw(JSON.stringify({ nickname: '阿博' }));
    expect(loadProfile()).toBeNull();
    writeRaw(JSON.stringify({ nickname: '阿博', avatarSeed: 7 }));
    expect(loadProfile()).toBeNull();
  });

  it('字段是空白串 → null（宁可用默认值也不要一个看不见名字的玩家）', () => {
    writeRaw(JSON.stringify({ nickname: '   ', avatarSeed: 'Seed1' }));
    expect(loadProfile()).toBeNull();
    writeRaw(JSON.stringify({ nickname: '阿博', avatarSeed: '' }));
    expect(loadProfile()).toBeNull();
  });

  it('localStorage 读就抛时返回 null，不白屏', () => {
    expect(loadProfile(storageThatThrows())).toBeNull();
  });
});

describe('saveProfile', () => {
  it('写入的是 PROFILE_STORAGE_KEY 下的 JSON', () => {
    saveProfile({ nickname: '阿博', avatarSeed: 'Seed123' });
    expect(window.localStorage.getItem(PROFILE_STORAGE_KEY)).toBe(
      JSON.stringify({ nickname: '阿博', avatarSeed: 'Seed123' }),
    );
  });

  it('写失败时静默返回（无痕模式 / 配额满不该中断这一局）', () => {
    expect(() => {
      saveProfile({ nickname: '阿博', avatarSeed: 'Seed123' }, storageThatThrows());
    }).not.toThrow();
  });
});
