/**
 * 头像生成（D-011）。
 *
 * 要盯住的三件事：
 * 1. **确定性** —— 同一个 seed 在任何一台设备上都必须生成同一张脸，
 *    否则「网络上只传 seed」这个方案从根上就不成立。
 * 2. **缓存真的生效** —— 一次生成要跑完整棵 Notionists 组件树，
 *    等待室里每个补丁都会重渲染 8 个头像，没缓存手机上会掉帧。
 * 3. **署名自带** —— DiceBear 会把许可证信息内嵌成 SVG 里的 `<metadata>` RDF 块
 *    （`dc:creator` / `dcterms:license`），这样即便有人只截走了 SVG 也还带着出处。
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { avatarCacheSize, avatarDataUri, clearAvatarCache, DEFAULT_AVATAR_SIZE } from '../src/avatar';

beforeEach(() => {
  clearAvatarCache();
});

/**
 * `toDataUri()` 出来的是 `data:image/svg+xml;utf8,<URL 编码后的 SVG>`。
 * 断言之前先解码，否则测试里全是 `%3C` 这种没法读的东西。
 */
function decodeSvg(uri: string): string {
  const comma = uri.indexOf(',');
  return decodeURIComponent(uri.slice(comma + 1));
}

describe('avatarDataUri', () => {
  it('返回可以直接塞进 <img src> 的 data URI', () => {
    const uri = avatarDataUri('Seed123');
    expect(uri.startsWith('data:image/svg+xml')).toBe(true);
    expect(decodeSvg(uri)).toContain('<svg');
  });

  it('同一个 seed 两次调用逐字节相同（确定性）', () => {
    expect(avatarDataUri('Seed123')).toBe(avatarDataUri('Seed123'));
  });

  it('不同 seed 结果不同', () => {
    expect(avatarDataUri('Seed123')).not.toBe(avatarDataUri('Seed124'));
  });

  it('尺寸参与结果：默认 128，显式传 48 时是另一张图', () => {
    expect(DEFAULT_AVATAR_SIZE).toBe(128);
    expect(avatarDataUri('Seed123', 48)).not.toBe(avatarDataUri('Seed123', 128));
    expect(decodeSvg(avatarDataUri('Seed123', 48))).toContain('width="48"');
  });

  it('SVG 里自带出处与许可证（Notionists by Zoish / CC0 1.0）', () => {
    const svg = decodeSvg(avatarDataUri('Seed123'));
    expect(svg).toContain('<dc:creator>Zoish</dc:creator>');
    expect(svg).toContain('dcterms:license');
    expect(svg).toContain('publicdomain/zero/1.0');
  });
});

describe('缓存', () => {
  it('第二次调用不再新增缓存条目', () => {
    avatarDataUri('Seed123');
    expect(avatarCacheSize()).toBe(1);
    avatarDataUri('Seed123');
    avatarDataUri('Seed123');
    expect(avatarCacheSize()).toBe(1);
  });

  it('key 里带尺寸，所以 (seed, 48) 和 (seed, 128) 是两条', () => {
    avatarDataUri('Seed123', 48);
    avatarDataUri('Seed123', 128);
    expect(avatarCacheSize()).toBe(2);
  });

  it('clearAvatarCache 清空', () => {
    avatarDataUri('Seed123');
    clearAvatarCache();
    expect(avatarCacheSize()).toBe(0);
  });

  it('清空之后仍然生成同样的图（缓存只是加速，不是语义的一部分）', () => {
    const before = avatarDataUri('Seed123');
    clearAvatarCache();
    expect(avatarDataUri('Seed123')).toBe(before);
  });
});
