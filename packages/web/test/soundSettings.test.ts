/**
 * 静音档的持久化（M4.2 验收：「静音开关状态存 localStorage，刷新后保持」）。
 *
 * 这一档**故意和身份分开**：身份是「我是谁」，走 sessionStorage / profile；
 * 静音是「这台设备今天要不要响」，要跨标签页、跨刷新、跨牌局一直跟着浏览器走，
 * 所以是 localStorage。开两个窗口自测时两边都响，也正是想要的效果。
 *
 * 默认值有一条裁定：「静音开关默认开启」这句话有两种读法，这里取**默认有声**。
 * 理由在 DECISIONS.md D-041；翻转它只需要改本文件里那一个默认值。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { loadMuted, saveMuted, SOUND_MUTED_KEY } from '../src/sound/settings';

/** 一个所有方法都抛 SecurityError 的 Storage：模拟 Safari 无痕 / 站点数据被禁 */
function storageThatThrows(): Storage {
  const boom = (): never => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  };
  return { length: 0, clear: boom, getItem: boom, key: boom, removeItem: boom, setItem: boom };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('静音档', () => {
  it('浏览器里什么都没存时是有声的（默认静音会让整个音效功能看起来没做）', () => {
    expect(loadMuted()).toBe(false);
  });

  it('存过就跟着存的那个值走 —— 这条就是「刷新后保持」', () => {
    saveMuted(true);
    expect(loadMuted()).toBe(true);
    saveMuted(false);
    expect(loadMuted()).toBe(false);
  });

  it('写在约定的键上，带版本号', () => {
    saveMuted(true);
    expect(window.localStorage.getItem(SOUND_MUTED_KEY)).not.toBeNull();
    expect(SOUND_MUTED_KEY).toBe('poker-room:sound-muted:v1');
  });

  it('只认写进去的那两个值：手改localStorage塞进别的内容一律按默认（有声）', () => {
    for (const junk of ['0', 'yes', '', '静音', 'true']) {
      window.localStorage.setItem(SOUND_MUTED_KEY, junk);
      expect(loadMuted()).toBe(false);
    }
    window.localStorage.setItem(SOUND_MUTED_KEY, 'muted');
    expect(loadMuted()).toBe(true);
  });

  it('读就抛（无痕模式）按默认有声处理，不白屏', () => {
    expect(loadMuted(storageThatThrows())).toBe(false);
  });

  it('写抛错只是存不下，不当场报错、也不影响这一局的开关', () => {
    const storage = storageThatThrows();
    expect(() => saveMuted(true, storage)).not.toThrow();
    expect(loadMuted(storage)).toBe(false);
  });
});
