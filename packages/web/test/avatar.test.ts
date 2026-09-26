/**
 * 头像生成（D-011 定方案，D-020 改成懒加载）。
 *
 * 要盯住的四件事：
 * 1. **首屏不装头像库** —— DiceBear + Notionists 实测占首屏 gzip 的 45%。
 *    所以它只能走动态 import：加载完成前 `peek` 是空的，组件先画占位。
 * 2. **确定性** —— 同一个 seed 在任何一台设备上都必须生成同一张脸，
 *    否则「网络上只传 seed」这个方案从根上就不成立。
 * 3. **缓存真的生效** —— 一次生成要跑完整棵 Notionists 组件树，
 *    等待室里每个补丁都会重渲染 8 个头像，没缓存手机上会掉帧。
 * 4. **署名自带** —— DiceBear 会把许可证信息内嵌成 SVG 里的 `<metadata>` RDF 块
 *    （`dc:creator` / `dcterms:license`），这样即便有人只截走了 SVG 也还带着出处。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  avatarCacheSize,
  clearAvatarCache,
  DEFAULT_AVATAR_SIZE,
  loadAvatarDataUri,
  peekAvatarDataUri,
  PRESET_AVATAR_SEEDS,
} from '../src/avatar';
import { sanitizeAvatarSeed } from '@poker-room/shared/view';

// 类型能静态借、值不能：`freshAvatarModule` 必须等 resetModules 之后再动态 import，
// 上面那份静态绑定早就求值过了。这里只取它的类型，编译后不留导入语句。
import type * as avatarModule from '../src/avatar';

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

describe('PRESET_AVATAR_SEEDS', () => {
  it('正好 8 个、互不重复，且每个都能原样通过 sanitizeAvatarSeed', () => {
    expect(PRESET_AVATAR_SEEDS).toHaveLength(8);
    expect(new Set(PRESET_AVATAR_SEEDS).size).toBe(8);
    for (const seed of PRESET_AVATAR_SEEDS) {
      // 洗一遍就变样 = 服务端回来的 seed 和本地的不是同一个 seed = 各端脸不一样
      expect(sanitizeAvatarSeed(seed, seed)).toBe(seed);
    }
  });

  it('8 个 seed 画出 8 张不同的脸（撞脸的预置不如没有）', async () => {
    const uris = await Promise.all(PRESET_AVATAR_SEEDS.map((seed) => loadAvatarDataUri(seed)));
    expect(new Set(uris).size).toBe(8);
  });
});

describe('懒加载', () => {
  it('缓存清空后 peek 是空的：头像库不静态进首屏包', () => {
    expect(peekAvatarDataUri('Seed123')).toBeUndefined();
    expect(avatarCacheSize()).toBe(0);
  });

  it('loadAvatarDataUri 之后 peek 直接命中，不再等 promise', async () => {
    const uri = await loadAvatarDataUri('Seed123');
    expect(peekAvatarDataUri('Seed123')).toBe(uri);
  });

  it('同一 seed 并发只生成一张（不会各跑一遍组件树）', async () => {
    const [a, b] = await Promise.all([loadAvatarDataUri('Seed123'), loadAvatarDataUri('Seed123')]);
    expect(a).toBe(b);
    expect(avatarCacheSize()).toBe(1);
  });
});

describe('loadAvatarDataUri', () => {
  it('返回可以直接塞进 <img src> 的 data URI', async () => {
    const uri = await loadAvatarDataUri('Seed123');
    expect(uri.startsWith('data:image/svg+xml')).toBe(true);
    expect(decodeSvg(uri)).toContain('<svg');
  });

  it('同一个 seed 两次调用逐字节相同（确定性）', async () => {
    clearAvatarCache();
    const a = await loadAvatarDataUri('Seed123');
    clearAvatarCache();
    const b = await loadAvatarDataUri('Seed123');
    expect(b).toBe(a);
  });

  it('不同 seed 结果不同', async () => {
    expect(await loadAvatarDataUri('Seed123')).not.toBe(await loadAvatarDataUri('Seed124'));
  });

  it('尺寸参与结果：默认 128，显式传 48 时是另一张图', async () => {
    expect(DEFAULT_AVATAR_SIZE).toBe(128);
    const small = await loadAvatarDataUri('Seed123', 48);
    expect(small).not.toBe(await loadAvatarDataUri('Seed123', 128));
    expect(decodeSvg(small)).toContain('width="48"');
  });

  it('SVG 里自带出处与许可证（Notionists by Zoish / CC0 1.0）', async () => {
    const svg = decodeSvg(await loadAvatarDataUri('Seed123'));
    expect(svg).toContain('<dc:creator>Zoish</dc:creator>');
    expect(svg).toContain('dcterms:license');
    expect(svg).toContain('publicdomain/zero/1.0');
  });
});

describe('缓存', () => {
  it('第二次调用不再新增缓存条目', async () => {
    await loadAvatarDataUri('Seed123');
    expect(avatarCacheSize()).toBe(1);
    await loadAvatarDataUri('Seed123');
    await loadAvatarDataUri('Seed123');
    expect(avatarCacheSize()).toBe(1);
  });

  it('key 里带尺寸，所以 (seed, 48) 和 (seed, 128) 是两条', async () => {
    await loadAvatarDataUri('Seed123', 48);
    await loadAvatarDataUri('Seed123', 128);
    expect(avatarCacheSize()).toBe(2);
  });

  it('clearAvatarCache 清空', async () => {
    await loadAvatarDataUri('Seed123');
    clearAvatarCache();
    expect(avatarCacheSize()).toBe(0);
  });

  it('清空之后仍然生成同样的图（缓存只是加速，不是语义的一部分）', async () => {
    const before = await loadAvatarDataUri('Seed123');
    clearAvatarCache();
    expect(await loadAvatarDataUri('Seed123')).toBe(before);
  });
});

/**
 * 懒加载引入的新失败模式：chunk 本身要过一次网络。
 *
 * 手机在电梯里第一下没拉到 `@dicebear/core` 那个 chunk，是真会发生的事，
 * 而它和"同步版本偶尔慢一点"不一样 —— 如果加载 Promise 被记忆化成"永久失败"，
 * 那这一整个会话的头像就全成占位块了，而头像是装饰内容，没人会去刷新页面。
 * 所以失败必须可重试：记忆化只留给成功。
 *
 * 放文件最后是约定，不是机制：mock 在 `afterEach` 里注销了，每个用例又各拿一份
 * 全新的 `avatar.ts`，所以污染跑不出去。但它确实是全文件唯一一处换掉真依赖的
 * 地方 —— 摆在前面会让后面那批静态导入的用例先得被读一遍才敢信。
 */
describe('头像库加载失败后可以重试', () => {
  afterEach(() => {
    vi.doUnmock('@dicebear/core');
    vi.resetModules();
  });

  /**
   * 拿一个**全新**的 `avatar.ts`。
   *
   * 光 `vi.doMock` 不够：文件顶部静态导入的 `avatar.ts` 早就是"加载成功"的实例了，
   * 它内部的 `renderer` 已有值，直接在它上面测重试会拿到真图。
   *
   * 必须成立的只有两条：`avatar.ts` 要在 `resetModules()` **之后**才被求值（拿到
   * `renderer === null` 的新实例），且 mock 要在它真正去 `import('@dicebear/core')`
   * 之前注册好。`doMock` 写在 `resetModules` 前面是有效的 —— reset 清的是模块图，
   * mock 注册表要 `doUnmock` 才清。两处都有断言兜着：新实例若没拿到，前一个用例的
   * `imports === 1` 和后一个用例的"第一次调用必须 reject"都会立刻失败。
   */
  async function freshAvatarModule(): Promise<typeof avatarModule> {
    vi.resetModules();
    return await import('../src/avatar');
  }

  it('并发请求共享同一次加载，也共享同一次失败', async () => {
    let imports = 0;
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.doMock('@dicebear/core', async () => {
      imports += 1;
      await gate;
      throw new Error('共享同一次失败');
    });

    const { loadAvatarDataUri } = await freshAvatarModule();
    const first = loadAvatarDataUri('TwinSeedA');
    const second = loadAvatarDataUri('TwinSeedB');
    release();
    // 断言的是"两个请求同生共死 + 只问了一次模块"。具体错误文本被 vitest 的
    // mock 工厂包装过，不是我们要盯的东西。
    await expect(first).rejects.toThrow();
    await expect(second).rejects.toThrow();
    expect(imports).toBe(1);
  });

  it('第一次 import 失败不会把后续请求永久钉死在失败态', async () => {
    let chunkMissing = true;
    vi.doMock('@dicebear/core', () => {
      if (chunkMissing) throw new Error('Failed to fetch chunk');
      return { createAvatar: () => ({ toDataUri: () => 'data:image/svg+xml;utf8,<svg/>' }) };
    });

    const { avatarCacheSize, loadAvatarDataUri, peekAvatarDataUri } = await freshAvatarModule();
    await expect(loadAvatarDataUri('RetrySeed')).rejects.toThrow();
    expect(peekAvatarDataUri('RetrySeed')).toBeUndefined();

    chunkMissing = false;
    await expect(loadAvatarDataUri('RetrySeed')).resolves.toContain('data:image/svg+xml');
    expect(avatarCacheSize()).toBe(1);
  });
});
