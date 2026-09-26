/**
 * 牌背（自绘，SPEC §4.5：「深蓝底 + 菱形纹样 SVG，避免用来源不明的牌背」）。
 *
 * `viewBox` 与牌面逐字相同 —— 这件事不能靠记性。牌背与牌面是**同一个槽位的两种内容**，
 * 比例差一点，发牌/亮牌时就是"翻面瞬间跳一下"，而在手机上肉眼只看得出"有点怪"。
 * `cardBack.test.ts` 会拿全部 52 张牌面的 viewBox 对一遍。
 */

/** 牌面素材的画布尺寸，直接抄自 `./cards/*.svg` 的 viewBox */
const CARD_VIEW_BOX = '0 0 167.0869141 242.6669922';
const CARD_WIDTH = 167.0869141;
const CARD_HEIGHT = 242.6669922;
/** 白边宽度：牌面素材四周留的就是这一圈纸边 */
const PAPER_EDGE = 6;

/** 菱形纹样：45° 斜交的线格铺在深蓝底上。id 带 `cb-` 前缀，避免与文档内其他 SVG 撞名 */
function lattice(): string {
  return `<defs><pattern id="cb-lattice" width="18" height="18" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
<rect width="18" height="18" fill="#16345E"/>
<path d="M0 9h18M9 0v18" stroke="#2F6CB0" stroke-width="1.6"/>
<path d="M0 0l18 18M18 0L0 18" stroke="#1D4478" stroke-width="0.8"/>
</pattern></defs>`;
}

export const CARD_BACK_SVG: string = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${CARD_VIEW_BOX}" width="${CARD_WIDTH}" height="${CARD_HEIGHT}">
${lattice()}
<rect x="0" y="0" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" rx="12" fill="#F2F5F8"/>
<rect x="${PAPER_EDGE}" y="${PAPER_EDGE}" width="${CARD_WIDTH - PAPER_EDGE * 2}" height="${CARD_HEIGHT - PAPER_EDGE * 2}" rx="8" fill="url(#cb-lattice)"/>
<rect x="${PAPER_EDGE}" y="${PAPER_EDGE}" width="${CARD_WIDTH - PAPER_EDGE * 2}" height="${CARD_HEIGHT - PAPER_EDGE * 2}" rx="8" fill="none" stroke="#0D1117" stroke-opacity="0.35" stroke-width="1.2"/>
<rect x="${PAPER_EDGE + 5}" y="${PAPER_EDGE + 5}" width="${CARD_WIDTH - (PAPER_EDGE + 5) * 2}" height="${CARD_HEIGHT - (PAPER_EDGE + 5) * 2}" rx="5" fill="none" stroke="#E3B341" stroke-opacity="0.7" stroke-width="1"/>
</svg>`;

export const CARD_BACK_DATA_URI: string = `data:image/svg+xml,${encodeURIComponent(CARD_BACK_SVG)}`;
