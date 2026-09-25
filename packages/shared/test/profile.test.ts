import { describe, expect, it } from 'vitest';

import { MAX_NICKNAME_LENGTH, sanitizeNickname, truncateByCodePoint } from '../src/profile';

describe('sanitizeNickname', () => {
  it('普通昵称原样通过', () => {
    expect(sanitizeNickname('林之博', 'X')).toBe('林之博');
    expect(sanitizeNickname('Alice', 'X')).toBe('Alice');
    expect(sanitizeNickname('player_01', 'X')).toBe('player_01');
  });

  it('首尾空白去掉，中间连续空白压成一个空格', () => {
    expect(sanitizeNickname('  Alice  ', 'X')).toBe('Alice');
    expect(sanitizeNickname('A\t\tB', 'X')).toBe('A B');
    expect(sanitizeNickname('A \n\r B', 'X')).toBe('A B');
  });

  it('剥掉控制字符（否则能塞终端转义序列污染服务端日志）', () => {
    expect(sanitizeNickname('Ali\u0000ce', 'X')).toBe('Alice');
    expect(sanitizeNickname('\u001B[31mRed\u001B[0m', 'X')).toBe('[31mRed[0m');
    expect(sanitizeNickname('a\u007Fb', 'X')).toBe('ab');
    expect(sanitizeNickname('a\u009Fb', 'X')).toBe('ab');
  });

  it('剥掉零宽字符与 BOM（否则两个看起来一样的昵称其实不同）', () => {
    expect(sanitizeNickname('Al\u200Bice', 'X')).toBe('Alice');
    expect(sanitizeNickname('\uFEFFAlice', 'X')).toBe('Alice');
    expect(sanitizeNickname('Al\u2060ice', 'X')).toBe('Alice');
  });

  it('剥掉 bidi 控制符（RTL override 是经典的昵称伪装手法）', () => {
    // U+202E 之后 "admin.evil" 会被渲染成 "live.nimda"
    expect(sanitizeNickname('\u202Eadmin.evil', 'X')).toBe('admin.evil');
    expect(sanitizeNickname('a\u202Ab', 'X')).toBe('ab');
    expect(sanitizeNickname('a\u2066b\u2069c', 'X')).toBe('abc');
  });

  it('保留 ZWJ：emoji 组合序列不被拆散', () => {
    const family = '👨‍👩‍👧';
    expect(sanitizeNickname(family, 'X')).toBe(family);
    expect(sanitizeNickname(`阿${family}博`, 'X')).toBe(`阿${family}博`);
  });

  it('超过 16 码点按码点截断', () => {
    expect(sanitizeNickname('A'.repeat(40), 'X')).toBe('A'.repeat(MAX_NICKNAME_LENGTH));
    expect(sanitizeNickname('德'.repeat(20), 'X')).toBe('德'.repeat(MAX_NICKNAME_LENGTH));
  });

  it('截断不会把代理对劈开', () => {
    const emoji = '😀'.repeat(20); // 每个 emoji 是 1 码点 / 2 个 UTF-16 单元
    const result = sanitizeNickname(emoji, 'X');
    expect([...result]).toHaveLength(MAX_NICKNAME_LENGTH);
    expect(result).toBe('😀'.repeat(MAX_NICKNAME_LENGTH));
    expect(result.endsWith('\uD83D')).toBe(false); // 不以孤立高位代理结尾
  });

  it('清洗后为空时用 fallback', () => {
    expect(sanitizeNickname('', '玩家A1B2')).toBe('玩家A1B2');
    expect(sanitizeNickname('   ', '玩家A1B2')).toBe('玩家A1B2');
    expect(sanitizeNickname('\u200B\u202E', '玩家A1B2')).toBe('玩家A1B2');
  });

  it('非字符串输入（服务端永远不能信任客户端）', () => {
    expect(sanitizeNickname(undefined, '玩家A1B2')).toBe('玩家A1B2');
    expect(sanitizeNickname(null, '玩家A1B2')).toBe('玩家A1B2');
    expect(sanitizeNickname({ evil: true }, '玩家A1B2')).toBe('玩家A1B2');
    expect(sanitizeNickname(['a'], '玩家A1B2')).toBe('玩家A1B2');
    expect(sanitizeNickname(true, '玩家A1B2')).toBe('玩家A1B2');
  });

  it('数字昵称被接受并转成字符串', () => {
    expect(sanitizeNickname(2026, 'X')).toBe('2026');
    expect(sanitizeNickname(0, 'X')).toBe('0');
  });

  it('fallback 本身也会被清洗和截断', () => {
    expect(sanitizeNickname('', '  玩家 A1B2  ')).toBe('玩家 A1B2');
    expect(sanitizeNickname('', 'Z'.repeat(40))).toBe('Z'.repeat(MAX_NICKNAME_LENGTH));
  });

  it('fallback 也清洗不干净时兜底为「玩家」，永不返回空串', () => {
    expect(sanitizeNickname('', '')).toBe('玩家');
    expect(sanitizeNickname(null, '\u200B')).toBe('玩家');
    expect(sanitizeNickname('\u202E', '   ')).toBe('玩家');
  });
});

describe('truncateByCodePoint', () => {
  it('不超过上限时原样返回（同一个字符串引用）', () => {
    const text = 'abc';
    expect(truncateByCodePoint(text, 5)).toBe(text);
    expect(truncateByCodePoint(text, 3)).toBe(text);
  });

  it('超过上限按码点截断', () => {
    expect(truncateByCodePoint('abcdef', 2)).toBe('ab');
    expect(truncateByCodePoint('😀😀😀', 2)).toBe('😀😀');
  });

  it('上限 <= 0 返回空串', () => {
    expect(truncateByCodePoint('abc', 0)).toBe('');
    expect(truncateByCodePoint('abc', -1)).toBe('');
  });

  it('空串安全', () => {
    expect(truncateByCodePoint('', 5)).toBe('');
  });
});
