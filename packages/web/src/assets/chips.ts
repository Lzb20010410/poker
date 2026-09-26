/**
 * 筹码（自绘 SVG，SPEC §4.5：圆形 + 8 条边缘色带 + 内圈面额数字）。
 *
 * ## 配色不是随便挑的
 *
 * 六档里有三档直接复用 §4.6 已经定下的语义色：弃牌红 `#DA3633`、加注绿 `#238636`、
 * 强调金 `#E3B341`。剩下三档（白 / 黑 / 紫）取同一色系的相邻值，保证 6 档互不相同，
 * 而且**在白底筹码上数字不会跟着变白** —— 这一条由测试用 WCAG 对比度独立算一遍，
 * 而不是问模块"你觉得够不够"。
 *
 * ## 为什么给 `<img>` 用 data URI
 *
 * 和牌面同一个理由：一桌最多 8 人 × 多摞筹码，同一个文档里塞几十份带 id 的 SVG
 * 会让 `url(#...)` 互相打架。见 `cardFaces.ts` 顶部说明与 D-023。
 */

/** SPEC §4.5 的六档面额 */
export const CHIP_DENOMINATIONS = [1, 5, 25, 100, 500, 1000] as const;

export type ChipDenomination = (typeof CHIP_DENOMINATIONS)[number];

const BASE_COLOR: Record<ChipDenomination, string> = {
  1: '#E6EDF3',
  5: '#DA3633',
  25: '#238636',
  100: '#30363D',
  500: '#8957E5',
  1000: '#E3B341',
};

const DARK_TEXT = '#0D1117';
const LIGHT_TEXT = '#FFFFFF';

/**
 * 底色够亮就用深字，否则用白字。
 * 阈值 0.4 而不是 0.5：本表里最亮的两档（金 0.49、白 0.83）要深字，
 * 中间那三档红/绿/紫的相对亮度都贴在 0.18 附近，必须走白字才够 4.5:1。
 */
function textColorFor(base: string): string {
  const channels = [1, 3, 5].map((i) => Number.parseInt(base.slice(i, i + 2), 16) / 255);
  const linear = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance =
    0.2126 * linear(channels[0] ?? 0) +
    0.7152 * linear(channels[1] ?? 0) +
    0.0722 * linear(channels[2] ?? 0);
  return luminance > 0.4 ? DARK_TEXT : LIGHT_TEXT;
}

/** 8 条边缘色带：同一个矩形绕圆心每次多转 45° */
function bands(textColor: string): string {
  return Array.from(
    { length: 8 },
    (_, index) =>
      `<rect class="chip-band" x="45.5" y="1.5" width="9" height="13" rx="2" fill="${textColor}" transform="rotate(${String(index * 45)} 50 50)"/>`,
  ).join('\n');
}

const uriByDenom = new Map<ChipDenomination, string>();

/** 某个面额的筹码 SVG 源码 */
export function chipSvg(denomination: ChipDenomination): string {
  const base = BASE_COLOR[denomination];
  const text = textColorFor(base);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100" data-chip-base="${base}" data-chip-text="${text}">
<circle cx="50" cy="50" r="49" fill="${base}"/>
${bands(text)}
<circle cx="50" cy="50" r="35" fill="${base}"/>
<circle cx="50" cy="50" r="35" fill="none" stroke="${text}" stroke-opacity="0.55" stroke-width="1.5"/>
<text x="50" y="50" text-anchor="middle" dominant-baseline="central" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="26" font-weight="700" fill="${text}">${String(denomination)}</text>
</svg>`;
}

/** 某个面额的 data URI，给 `<img src>` 用；同一面额每次返回同一个字符串 */
export function chipDataUri(denomination: ChipDenomination): string {
  const cached = uriByDenom.get(denomination);
  if (cached !== undefined) return cached;
  const uri = `data:image/svg+xml,${encodeURIComponent(chipSvg(denomination))}`;
  uriByDenom.set(denomination, uri);
  return uri;
}
