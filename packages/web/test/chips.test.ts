/**
 * 自绘筹码的测试（SPEC §4.5「筹码：圆形 + 8 条边缘色带 + 内圈面额数字，6 种面额配色」）。
 *
 * ## 期望色值为什么在测试里重抄一遍
 *
 * 如果测试写 `expect(chipColor(5)).toBe(chipColor(5))` 这类自反断言，它永远绿。
 * 这里的期望值是**从 SPEC §4.5/§4.6 手抄**进来的独立口径：将来谁调了配色，
 * 要么连 SPEC 一起改（那是个产品决定），要么被这条用例拦住。
 * 三个能沿用的色（弃牌红 / 加注绿 / 强调金）直接取自 §4.6 的按钮与强调色，不是新发明的颜色。
 */

import { describe, expect, it } from 'vitest';

import { CHIP_DENOMINATIONS, chipDataUri, chipSvg } from '../src/assets/chips';

/** SPEC §4.5 的 6 档面额与配色（1白 / 5红 / 25绿 / 100黑 / 500紫 / 1000金） */
const SPEC_COLORS: Readonly<Record<number, string>> = {
  1: '#E6EDF3',
  5: '#DA3633',
  25: '#238636',
  100: '#30363D',
  500: '#8957E5',
  1000: '#E3B341',
};

/**
 * WCAG 2.1 相对亮度比。这里**故意在测试里独立实现一遍**：
 * 被测模块只需要交出它用的两个颜色，"这对不对"由测试自己判断，
 * 而不是问模块"你算的对比度是多少"。
 */
function contrastRatio(a: string, b: string): number {
  const lum = (hex: string): number => {
    const value = /^#?([0-9a-f]{6})$/i.exec(hex)?.[1] ?? '';
    const [r, g, bl] = [0, 2, 4].map((i) => Number.parseInt(value.slice(i, i + 2), 16) / 255);
    const lin = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r ?? 0) + 0.7152 * lin(g ?? 0) + 0.0722 * lin(bl ?? 0);
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return ((x ?? 0) + 0.05) / ((y ?? 0) + 0.05);
}

describe('筹码资产', () => {
  it('面额档位与 SPEC 逐字一致', () => {
    expect([...CHIP_DENOMINATIONS]).toEqual([1, 5, 25, 100, 500, 1000]);
  });

  it('每个面额的底色与 SPEC 抄下来的期望值一致，且六档互不相同', () => {
    const colors = CHIP_DENOMINATIONS.map((denom) => {
      const svg = chipSvg(denom);
      const match = /data-chip-base="([^"]+)"/.exec(svg);
      expect(match, `${denom} 筹码没标底色`).not.toBeNull();
      expect(match?.[1]?.toLowerCase()).toBe(SPEC_COLORS[denom]?.toLowerCase());
      return match?.[1] ?? '';
    });
    // 六档挤成五种可分辨的色是"看不出自己面前是 100 还是 500"的直接成因。
    expect(new Set(colors).size).toBe(6);
  });

  it('每张筹码是圆 + 恰好 8 条边缘色带 + 内圈面额数字', () => {
    for (const denom of CHIP_DENOMINATIONS) {
      const svg = chipSvg(denom);
      expect(/<circle\b/.test(svg), `${denom} 没有圆形主体`).toBe(true);
      expect(svg.match(/class="chip-band"/g) ?? [], `${denom} 边缘色带不是 8 条`).toHaveLength(8);
      const numbers = [...svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)]
        .map((m) => m[1]?.trim())
        .filter((t): t is string => t !== undefined && t.length > 0);
      expect(numbers, `${denom} 内圈没有面额数字`).toContain(String(denom));
    }
  });

  it('data URI 能原样解回源码，且同一面额重复取到同一个字符串', () => {
    for (const denom of CHIP_DENOMINATIONS) {
      const uri = chipDataUri(denom);
      const encoded = uri.slice('data:image/svg+xml,'.length);
      expect(encoded).not.toContain('#');
      expect(decodeURIComponent(encoded)).toBe(chipSvg(denom));
      // 引用相等：一摞筹码每帧都重算的话，动画期间会稳定掉帧。
      expect(chipDataUri(denom)).toBe(uri);
    }
  });

  it('六档底色与各自的数字之间都有足够对比度（WCAG AA 4.5:1）', () => {
    for (const denom of CHIP_DENOMINATIONS) {
      const svg = chipSvg(denom);
      const base = /data-chip-base="([^"]+)"/.exec(svg)?.[1];
      const text = /data-chip-text="([^"]+)"/.exec(svg)?.[1];
      expect(base, `${denom} 缺 data-chip-base`).toBeDefined();
      expect(text, `${denom} 缺 data-chip-text`).toBeDefined();
      const ratio = contrastRatio(base ?? '', text ?? '');
      // 1 白档最容易被做错：白底配白字在深色桌布上就是一张空圈。
      expect(ratio, `${denom} 对比度 ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('全部筹码加起来仍然是零位图（M2.1「全部是 SVG 或 CSS」那条验收）', () => {
    const all = CHIP_DENOMINATIONS.map(chipSvg).join('');
    expect(all).not.toMatch(/<image|data:image|base64/i);
  });
});
