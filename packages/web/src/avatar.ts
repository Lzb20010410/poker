/**
 * DiceBear 头像生成（DECISIONS.md D-011）。
 *
 * 网络上只传 seed，图在各端本地算。理由：一个 data URI 实测约 14.7 KB，
 * 8 个人就是 ~118 KB 进 Colyseus 的全量同步与 diff 基线，而房间状态里
 * 99% 的变化跟头像毫无关系；seed 只有十几个字符，且 DiceBear 是纯函数，
 * 各端算出来的 SVG 逐字节相同。
 *
 * ## 两个必须知道的点
 *
 * - `import * as notionists`：这个包**没有** `notionists` 具名导出，
 *   运行时只有 `{ create, meta, schema }`，而 `createAvatar` 要的正好是
 *   一个 `Style` 对象（`{ meta?, schema?, create }`），所以整个命名空间直接传进去。
 * - 不开 `randomizeIds`：我们用 `<img src={dataUri}>` 渲染，每张图是独立文档，
 *   不会有 SVG id 冲突；开了反而破坏「同 seed → 同结果」，缓存就失效了。
 *
 * ## 许可证
 *
 * 代码 MIT，设计「Notionists by Zoish」CC0 1.0。`createAvatar` 会把风格包的
 * 出处与许可证写进每张 SVG 的 `<metadata>` RDF 块（`dc:creator` / `dcterms:license`），
 * 等于自带署名——即便有人只截走了 SVG 也还带着出处。
 * 换风格时只从 MIT 风格包里挑，禁用名单见 D-011。
 */

import { createAvatar } from '@dicebear/core';
import * as notionists from '@dicebear/notionists';

/** 默认边长（px）。列表里会传更小的值 */
export const DEFAULT_AVATAR_SIZE = 128;

/** 圆角百分比，配合 `clip` 让头像贴合成圆形 */
const AVATAR_RADIUS_PERCENT = 50;

/**
 * seed + size → data URI 的缓存。
 *
 * 必须缓存：一次生成要跑完整个 Notionists 组件树（~14.7 KB SVG），
 * 而 React 每次重渲染都会调 `avatarDataUri`。8 个人的等待室每来一个补丁
 * 就重算 8 次，手机上会有明显掉帧。
 *
 * key 里带 size 是因为不同尺寸的结果不同，不能共用。
 */
const cache = new Map<string, string>();

export function avatarDataUri(seed: string, size: number = DEFAULT_AVATAR_SIZE): string {
  const key = `${size}:${seed}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const uri = createAvatar(notionists, {
    seed,
    size,
    radius: AVATAR_RADIUS_PERCENT,
    clip: true,
  }).toDataUri();

  cache.set(key, uri);
  return uri;
}

/** 清空缓存。测试之间必须调，否则「第二次命中缓存」这类断言会互相污染 */
export function clearAvatarCache(): void {
  cache.clear();
}

/** 当前缓存条目数。只给测试用，用来断言缓存真的生效了 */
export function avatarCacheSize(): number {
  return cache.size;
}
