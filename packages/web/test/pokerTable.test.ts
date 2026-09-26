/**
 * 牌桌桌面资产（SPEC §4.5「椭圆，径向渐变 + feTurbulence 噪点滤镜模拟绒布 + 内圈描金线 + 中央 logo」）。
 *
 * ## 这里最值钱的两个断言
 *
 * 1. **两张桌子放在同一页时 id 不撞名**。桌面的渐变和噪点滤镜都靠 `id` 引，
 *    `/dev/assets` 页要同时摆绿呢和蓝呢两张（M2.5 的房主可选配色就是这么验的），
 *    如果 id 是写死的，后一张会引用到前一张的滤镜定义 —— 表现是"蓝呢桌子看着偏绿"，
 *    而且单看一张永远发现不了。
 * 2. **绿/蓝两档的色值来自 SPEC，不是我看顺眼挑的**，所以期望值在测试里手抄一遍。
 */

import { describe, expect, it } from 'vitest';

import { FELT_COLORS, tableFeltParts } from '../src/assets/pokerTable';

describe('牌桌桌面', () => {
  it('绿呢与蓝呢两档色值与 SPEC §4.6 逐字一致', () => {
    expect(FELT_COLORS.green).toBe('#1A6B4A');
    expect(FELT_COLORS.blue).toBe('#1F4E79');
  });

  it('桌面由径向渐变 + feTurbulence 噪点 + 描金内圈 + 中央 logo 四部分构成', () => {
    const parts = tableFeltParts({ felt: 'green', idPrefix: 't1' });
    expect(parts.svg).toContain('<radialGradient');
    expect(parts.svg).toContain('feTurbulence');
    // 描金用 §4.6 的「桌面边框 #8B6B3D」，不是强调金 —— 强调金留给当前行动者与赢家。
    expect(parts.svg).toContain('#8B6B3D');
    expect(parts.svg).toContain('table-logo');
  });

  it('同一页放两张桌子时，两张的 id 完全不重叠', () => {
    const a = tableFeltParts({ felt: 'green', idPrefix: 'table-a' });
    const b = tableFeltParts({ felt: 'blue', idPrefix: 'table-b' });
    const idOf = (svg: string): string[] => [...svg.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1] ?? '');
    const idsA = new Set(idOf(a.svg));
    const shared = idOf(b.svg).filter((id) => idsA.has(id));
    expect(shared, `两张桌子共有 ${shared.join(', ')} 这些 id`).toEqual([]);
    // 每张自己得真.define 了它自己要引用的那几个 id，否则 `url(#...)` 会指空。
    for (const url of [...a.svg.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1] ?? '')) {
      expect(idsA.has(url), `引用了 #${url} 但没有定义`).toBe(true);
    }
  });

  it('零位图，且 viewBox 跟随传入尺寸', () => {
    const parts = tableFeltParts({ felt: 'blue', idPrefix: 't2', width: 900, height: 480 });
    expect(parts.svg).not.toMatch(/<image|data:image|base64/i);
    expect(parts.svg).toContain('viewBox="0 0 900 480"');
  });
});
