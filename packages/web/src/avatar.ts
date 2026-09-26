/**
 * DiceBear 头像生成（DECISIONS.md D-011 定方案，D-020 改懒加载）。
 *
 * 网络上只传 seed，图在各端本地算。理由：一个 data URI 实测约 14.7 KB，
 * 8 个人就是 ~118 KB 进 Colyseus 的全量同步与 diff 基线，而房间状态里
 * 99% 的变化跟头像毫无关系；seed 只有十几个字符，且 DiceBear 是纯函数，
 * 各端算出来的 SVG 逐字节相同。
 *
 * ## 为什么是 `loadAvatarDataUri` 而不是同步的 `avatarDataUri`
 *
 * `@dicebear/core` + `@dicebear/notionists` 实测占首屏 gzip 的 45%（约 118 KB），
 * 而头像是装饰性内容：玩家进大厅第一眼要看的是配对码和昵称，不是一张脸。
 * 所以这里只在**第一次真要画图时**才 `import()` 那两个包，加载期间组件画占位块。
 * 代价是头像会晚一两帧出现，换来首屏少一半体积。
 *
 * ## 两个必须知道的点
 *
 * - `await import('@dicebear/notionists')` 拿到的是整个命名空间对象：这个包**没有**
 *   `notionists` 具名导出，运行时只有 `{ create, meta, schema }`，而 `createAvatar`
 *   要的正好是一个 `Style` 对象（`{ meta?, schema?, create }`），所以直接把命名空间传进去。
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

/** 默认边长（px）。列表里会传更小的值 */
export const DEFAULT_AVATAR_SIZE = 128;

/**
 * 8 个预置 seed，给 `/dev/assets` 平铺展示用（M2.1 验收项「8 预置 seed」）。
 *
 * 必须只用 `[A-Za-z0-9]`：seed 要经过去处和回处（shared 的 `sanitizeAvatarSeed`
 * 会把别的字符全删掉），带 `-` 或空格的 seed 在服务端洗一遍之后会变成**另一个 seed**，
 * 于是各端画出来的脸不一样。`avatar.test.ts` 里钉了这一点。
 */
export const PRESET_AVATAR_SEEDS: readonly string[] = [
  'PokerFace',
  'ChipStack',
  'RiverBoat',
  'AllInCall',
  'HoleCard',
  'FlopTurn',
  'SidePot',
  'BadBeat',
];

/** 圆角百分比，配合 `clip` 让头像贴合成圆形 */
const AVATAR_RADIUS_PERCENT = 50;

/** 生成一张图：seed + size → data URI。只由 `getRenderer()` 解析出来的实现填充 */
type AvatarRenderer = (seed: string, size: number) => string;

/**
 * seed + size → data URI 的缓存。
 *
 * 必须缓存：一次生成要跑完整个 Notionists 组件树（~14.7 KB SVG），
 * 而 React 每次重渲染都会调 `peekAvatarDataUri`。8 个人的等待室每来一个补丁
 * 就重算 8 次，手机上会有明显掉帧。
 *
 * key 里带 size 是因为不同尺寸的结果不同，不能共用。
 */
const cache = new Map<string, string>();

/**
 * 头像库的加载 Promise，只记忆化**成功**那一次。
 *
 * 存 Promise 而不是存结果：并发的两个 `loadAvatarDataUri` 会等同一次加载，
 * 不会出现「两个人各自 import 一遍」。
 *
 * 失败时槽位要清空（见 `getRenderer`），否则记忆化的就是一次永久失败。
 */
let renderer: Promise<AvatarRenderer> | null = null;

function importAvatarLibrary(): Promise<AvatarRenderer> {
  return (async (): Promise<AvatarRenderer> => {
    const { createAvatar } = await import('@dicebear/core');
    const notionists = await import('@dicebear/notionists');
    return (seed, size) => createAvatar(notionists, {
      seed,
      size,
      radius: AVATAR_RADIUS_PERCENT,
      clip: true,
    }).toDataUri();
  })();
}

function getRenderer(): Promise<AvatarRenderer> {
  if (renderer !== null) return renderer;
  const loading = importAvatarLibrary();
  renderer = loading;
  // 只记忆化成功：手机在电梯里第一下没拉到 chunk 是真会发生的，而这一次改成
  // 懒加载之后，"拉不到"是头像唯一真正的失败模式。把失败也记下来，整个会话的
  // 头像就全是占位块，而头像是装饰内容——没人会为了它去刷新页面。
  // 清掉槽位让下一个请求重试；`loading` 本身照样 reject，同批并发的请求共享同一次失败。
  loading.catch(() => {
    if (renderer === loading) renderer = null;
  });
  return loading;
}

/** 缓存里有就给你，没有就 `undefined`。渲染路径上唯一允许同步调用的入口 */
export function peekAvatarDataUri(seed: string, size: number = DEFAULT_AVATAR_SIZE): string | undefined {
  return cache.get(`${size}:${seed}`);
}

/**
 * 要一张头像的 data URI；头像库还没加载完时会等它。
 *
 * 命中缓存时同步语义（`Promise` 立刻 resolve），所以列表滚动不会每帧都走一遍异步。
 * 失败只在调用方（组件）那里被消化成"继续显示占位"——头像加载失败不该打断牌局。
 */
export async function loadAvatarDataUri(seed: string, size: number = DEFAULT_AVATAR_SIZE): Promise<string> {
  const key = `${size}:${seed}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const render = await getRenderer();
  const uri = render(seed, size);
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
