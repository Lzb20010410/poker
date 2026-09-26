/**
 * 52 张牌面 SVG 的取用入口（M2.1，DECISIONS.md D-023）。
 *
 * ## 素材
 *
 * `./cards/` 下 52 个文件里，**40 张数字牌（2~10 与 A）**来自 GitHub
 * `hayeah/playing-cards-assets`（357★，MIT；上游 `vector-playing-cards` 项目自述 public
 * domain），保持精雕原图。**12 张人头牌（J/Q/K）是自绘**（`test/cardCourtFaces.test.ts`
 * 盯着它的构造）：上游精雕花牌单张 425KB~1.13MB、整副 gzip 3.6MB，超 M2.1 预算 12 倍；
 * 退而用同仓库 `svg-cards/simple/` 后目视判"看不出是什么、也没有特色"，于是照数字牌的
 * 骨架自己画了上下镜像的双人格。出处、两次换代的实测数字都记在 DECISIONS.md D-023。
 *
 * 自绘那 12 张复用上游的量：同一张白色圆角外框 path、同一套角标（`font-size:32`、
 * 基线 `(8.7754, 28.0133)`、Arial）、同一份花色符号 `d`。梅花符号上游不是围绕原点画的
 * （起点 `m 50.291466,22.698228`），这里把起点平移回几何中心，形状未动。
 *
 * ## 为什么给 `<img>` 用 data URI，而不是把 SVG 内联进 DOM
 *
 * 这副牌是 Inkscape 导出的，每张内部都带 `id`（`<clipPath>`、`<path>`、`<tspan>` 全有），
 * 数字牌里还有 30 张用 `xlink:href` 引本文档内的 `<linearGradient>`。一张牌一个 `<svg>`
 * 塞进同一份文档时，
 * 重复 id 会让 `url(#...)` 解析到**先出现的那个**——表现就是第 20 张牌裁到了第 3 张牌的
 * 遮罩上，而且只在特定发牌顺序下复现。`<img src="data:...">` 让每张图是独立文档，
 * id 天然不冲突。`avatar.ts` 的头像用的是同一个办法。
 *
 * ## 为什么在这里 `throw`
 *
 * 牌面是**按名字查表**的，名字由 `rank`/`suit` 两个词表拼出来。写错一个词不是"少一张图"
 * 这种温和的故障，而是"黑桃 K 渲染成黑桃 Q"这种会毁掉整局可信度的故障，所以查不到必须
 * 当场炸响，而不是返回 `undefined` 让调用方各自决定怎么兜。
 */

import { RANKS, SUITS, type Card, type Rank, type Suit } from '@poker-room/shared/view';

/** 上游文件名里的点数写法（`11` 是 jack，`14` 是 ace） */
const RANK_WORD: Record<Rank, string> = {
  2: '2',
  3: '3',
  4: '4',
  5: '5',
  6: '6',
  7: '7',
  8: '8',
  9: '9',
  10: '10',
  11: 'jack',
  12: 'queen',
  13: 'king',
  14: 'ace',
};

const SUIT_WORD: Record<Suit, string> = {
  s: 'spades',
  h: 'hearts',
  d: 'diamonds',
  c: 'clubs',
};

/**
 * 构建期内联全部牌面。`eager` + `?raw` = 牌面直接进 JS chunk 而不是发一次网络请求：
 * 52 张合计 gzip 51KB，比分包省下的那点首屏还小，换来的是翻牌那一帧绝不会有空窗。
 */
const SOURCES = import.meta.glob<string>('./cards/*.svg', {
  eager: true,
  query: '?raw',
  import: 'default',
});

/** 键是裸文件名，因为 glob 的键带 `./cards/` 前缀，而前缀不属于我们要断言的部分 */
const svgByFile = new Map<string, string>(
  Object.entries(SOURCES).map(([path, svg]) => [path.slice(path.lastIndexOf('/') + 1), svg]),
);

/** 缓存 data URI。渲染路径每帧都会取牌，每次重新编码一条几十 KB 的字符串会直接打爆 GC。 */
const uriByFile = new Map<string, string>();

function fileName(card: Card): string {
  return `${RANK_WORD[card.rank]}_of_${SUIT_WORD[card.suit]}.svg`;
}

/** 全部 52 个牌面文件名。资产页与"资产目录是否完整"的断言用它 */
export const CARD_FACE_FILES: readonly string[] = RANKS.flatMap((rank) =>
  SUITS.map((suit) => fileName({ rank, suit })),
);

/** 牌面 SVG 源码原文，未经任何改写 */
export function cardFaceSvg(card: Card): string {
  const name = fileName(card);
  const svg = svgByFile.get(name);
  if (svg === undefined) throw new Error(`牌面资产缺失：${name}`);
  return svg;
}

/** 牌面的 data URI，给 `<img src>` 用；同一张牌每次返回的是同一个字符串 */
export function cardFaceDataUri(card: Card): string {
  const name = fileName(card);
  const cached = uriByFile.get(name);
  if (cached !== undefined) return cached;
  // encodeURIComponent 会把 `#` 和 `%` 都编掉——这两个字符留在 data URI 里
  // 会分别造成"从 # 处截断"和"后续转义错位"。
  const uri = `data:image/svg+xml,${encodeURIComponent(cardFaceSvg(card))}`;
  uriByFile.set(name, uri);
  return uri;
}
