/**
 * 自绘牌背的测试。牌背不来自任何第三方仓库（SPEC §4.5：牌背自绘），
 * 所以这里防的是"牌背和牌面尺寸不一致"这一类会毁掉发牌动画的问题。
 */

import { RANKS, SUITS } from '@poker-room/shared/view';
import { describe, expect, it } from 'vitest';

import { CARD_BACK_DATA_URI, CARD_BACK_SVG } from '../src/assets/cardBack';
import { cardFaceSvg } from '../src/assets/cardFaces';

/** 从 SVG 根元素上取 viewBox 的四个数 */
function viewBox(svg: string): number[] {
  const match = /viewBox="([^"]+)"/.exec(svg);
  expect(match, 'SVG 没有 viewBox').not.toBeNull();
  return (match?.[1] ?? '').trim().split(/\s+/).map(Number);
}

describe('牌背', () => {
  it('与全部 52 张牌面同比例同尺寸，换成牌面时不会跳版', () => {
    const back = viewBox(CARD_BACK_SVG);
    // 逐张而不是抽样：牌面有两条来源（精雕 + `simple` 的 J/Q/K），比例不一致的话
    // 只会在那 12 张上暴露，而"发牌动画走到花牌就抖一下"恰好是最难复现的一类 bug。
    for (const rank of RANKS) {
      for (const suit of SUITS) {
        const face = viewBox(cardFaceSvg({ rank, suit }));
        expect(face, `${rank}${suit} 与牌背比例不一致`).toEqual(back);
      }
    }
  });

  it('是自绘矢量：无位图、无外部引用、无脚本', () => {
    expect(CARD_BACK_SVG).not.toMatch(/<image|data:image/i);
    // xlink:href / href 只允许指向本文档内的 #id，不允许出现任何 scheme。
    for (const ref of CARD_BACK_SVG.match(/(?:xlink:)?href="([^"]*)"/g) ?? []) {
      expect(ref).not.toMatch(/https?:|\.svg|\.png/);
    }
    expect(CARD_BACK_SVG).not.toMatch(/<script/i);
  });

  it('data URI 能原样解回牌背源码', () => {
    expect(CARD_BACK_DATA_URI.startsWith('data:image/svg+xml,')).toBe(true);
    expect(decodeURIComponent(CARD_BACK_DATA_URI.slice('data:image/svg+xml,'.length))).toBe(
      CARD_BACK_SVG,
    );
  });
});
