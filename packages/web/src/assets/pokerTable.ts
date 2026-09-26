/**
 * 牌桌桌面（`SPEC.md` §4.5：椭圆 + 径向渐变 + `feTurbulence` 噪点模拟绒布 + 描金边 + 中央 logo）。
 *
 * ## 为什么 id 必须带前缀
 *
 * 桌面的渐变和噪点滤镜是靠 `url(#id)` 引的。`/dev/assets` 页要同时摆绿呢和蓝呢
 * 两张桌子（M2.5 的「房主可选配色」就是这么验收的），如果 id 写死，后一张会引用
 * 到前一张的定义——表现是"蓝呢桌子看着偏绿"，而单看一张永远发现不了。所以
 * `idPrefix` 是必填参数，不是可选项。
 *
 * ## 为什么渐变/噪点/描金的色值都是算出来的或抄 SPEC 的
 *
 * 只有 `FELT_COLORS` 两档底色是 SPEC §4.6 的原文，渐变的亮端与暗端由底色向白/向黑
 * 线性插值得到——这样换第三档桌布（如果哪天要）只要加一行底色，不用手挑四个色。
 * 描金用 §4.6 的「桌面边框 `#8B6B3D`」；**强调金 `#E3B341` 不在这里用**，那张力
 * 留给当前行动者与赢家，桌面抢了就等于哪儿都不显眼。
 *
 * ## 零位图
 *
 * 绒布质感用 `feTurbulence` 而不是噪点贴图，所以整张桌子是纯描述——缩放不糊，
 * 也不占资产体积（M2.1 的 300KB gzip 预算里它几乎为零）。
 */

import type { FeltColor } from '@poker-room/shared/view';

/**
 * 房主可选的两档桌布，色值逐字来自 `SPEC.md` §4.6。
 *
 * 键类型用的是 `@poker-room/shared` 的 `FeltColor`（也就是 `FELT_VALUES`），不是在
 * 这里再列一遍名单：合法取值由引擎 `setTableConfig` 判定，这里只是给每档配一个色。
 * 自己另列一份的话，服务端加了第三档而这里没加，`FELT_COLORS[options.felt]` 就会
 * 取到 `undefined`，拼出来的 SVG 里 `stop-color` 变成空字符串——桌面直接变成黑的。
 * 写成 `Record<FeltColor, string>` 之后，漏一档是编译期错误。
 */
export const FELT_COLORS: Record<FeltColor, string> = {
  green: '#1A6B4A',
  blue: '#1F4E79',
};

export type { FeltColor };

/**
 * 两档桌布的中文名。放在色值旁边而不是组件里，是因为「有哪几档、各档叫什么、长什么样」
 * 是同一个展示概念的三件事：房主面板（选项）、`/dev/assets`（图注）、`/dev/table`
 * （将来的图注）都要用，各写一遍迟早会出现这里叫「蓝呢」那里叫「深蓝」。
 */
export const FELT_LABELS: Record<FeltColor, string> = {
  green: '绿呢',
  blue: '蓝呢',
};

/** 描金边色（SPEC §4.6「桌面边框」） */
const GOLD_RIM = '#8B6B3D';

/** 最外沿的暗色勾边，与全局背景同族，让桌子和页面不脱节 */
const OUTER_EDGE = '#0D1117';

/** 未传尺寸时的默认视口，比例接近 16:9 横屏桌面 */
const DEFAULT_WIDTH = 1000;
const DEFAULT_HEIGHT = 560;

/** 描金边宽度（px，视口单位） */
const RIM_WIDTH = 16;

/** 绒布内圈那条细金线距边界的距离 */
const INNER_LINE_INSET = 30;

export interface TableFeltOptions {
  readonly felt: FeltColor;
  /**
   * 本页内唯一的前缀。同一页放两张桌子时必须不同，否则两张会共用同一份
   * 渐变与滤镜定义（见文件头）。
   */
  readonly idPrefix: string;
  readonly width?: number;
  readonly height?: number;
}

export interface TableFelt {
  /** 一张完整可独立渲染的桌面 SVG */
  readonly svg: string;
}

function hexToRgb(hex: string): number[] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * 把底色向白（`t > 0`）或向黑（`t < 0`）线性插值，返回大写 hex。
 *
 * 必须输出大写：仓库里的 ESLint 规则（`checkLowercaseHex`）不允许代码里出现
 * 小写色值，而这里是运行时拼字符串，规则盯不住，所以自己保证。
 */
function mix(hex: string, t: number): string {
  const target = t >= 0 ? 255 : 0;
  const k = Math.abs(t);
  const body = hexToRgb(hex)
    .map((channel) => Math.round(channel + (target - channel) * k))
    .map((channel) => channel.toString(16).padStart(2, '0').toUpperCase())
    .join('');
  return `#${body}`;
}

/** 去掉浮点噪声，免得 SVG 里出现 `499.99999999999994` */
function n(value: number): string {
  return String(Math.round(value * 100) / 100);
}

export function tableFeltParts(options: TableFeltOptions): TableFelt {
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const base = FELT_COLORS[options.felt];
  const { idPrefix } = options;

  const gradientId = `${idPrefix}-felt-gradient`;
  const noiseId = `${idPrefix}-felt-noise`;
  const clipId = `${idPrefix}-felt-clip`;
  const logoId = `${idPrefix}-table-logo`;

  const cx = width / 2;
  const cy = height / 2;
  const outerRx = cx - 3;
  const outerRy = cy - 3;
  const feltRx = outerRx - RIM_WIDTH;
  const feltRy = outerRy - RIM_WIDTH;

  const light = mix(base, 0.2);
  const dark = mix(base, -0.5);
  const rimShadow = mix(GOLD_RIM, -0.55);
  const logoInk = mix(base, 0.55);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(width)} ${n(height)}" width="${n(width)}" height="${n(height)}">
  <defs>
    <radialGradient id="${gradientId}" cx="50%" cy="42%" r="72%">
      <stop offset="0%" stop-color="${light}" />
      <stop offset="58%" stop-color="${base}" />
      <stop offset="100%" stop-color="${dark}" />
    </radialGradient>
    <filter id="${noiseId}" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="4" seed="12" stitchTiles="stitch" result="grain" />
      <feColorMatrix in="grain" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0.34 0.34 0.34 0 0" />
    </filter>
    <clipPath id="${clipId}">
      <ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(feltRx)}" ry="${n(feltRy)}" />
    </clipPath>
  </defs>
  <ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(outerRx + 2)}" ry="${n(outerRy + 2)}" fill="${rimShadow}" stroke="${OUTER_EDGE}" stroke-width="2" />
  <ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(outerRx)}" ry="${n(outerRy)}" fill="${GOLD_RIM}" />
  <ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(feltRx)}" ry="${n(feltRy)}" fill="url(#${gradientId})" />
  <rect x="0" y="0" width="${n(width)}" height="${n(height)}" clip-path="url(#${clipId})" filter="url(#${noiseId})" />
  <ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(feltRx - INNER_LINE_INSET)}" ry="${n(feltRy - INNER_LINE_INSET)}" fill="none" stroke="${logoInk}" stroke-width="1.5" opacity="0.35" />
  <g id="${logoId}" opacity="0.22">
    <ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(feltRx * 0.3)}" ry="${n(feltRy * 0.3)}" fill="none" stroke="${logoInk}" stroke-width="2" />
    <text x="${n(cx)}" y="${n(cy - 6)}" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="${n(Math.min(width, height) * 0.075)}" letter-spacing="4" fill="${logoInk}">HOLD'EM</text>
    <text x="${n(cx)}" y="${n(cy + feltRy * 0.14)}" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="${n(Math.min(width, height) * 0.03)}" letter-spacing="3" fill="${logoInk}">PRIVATE TABLE</text>
  </g>
</svg>`;

  return { svg };
}

const uriCache = new Map<string, string>();

/**
 * 桌面 → data URI，交给 `<img>` 渲染（同 `cardFaces.ts` 的理由：内联几十份带 id 的
 * SVG 会让 `url(#id)` 全部指到第一份）。`idPrefix` 进缓存 key，
 * 因为不同前缀的结果本就不同。
 */
export function tableFeltDataUri(options: TableFeltOptions): string {
  const key = JSON.stringify(options);
  const hit = uriCache.get(key);
  if (hit !== undefined) return hit;
  const uri = `data:image/svg+xml,${encodeURIComponent(tableFeltParts(options).svg)}`;
  uriCache.set(key, uri);
  return uri;
}
