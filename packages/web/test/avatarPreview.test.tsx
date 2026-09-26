/**
 * 头像组件的懒加载契约（D-020）。
 *
 * 头像是**装饰性**内容：它晚一帧出现可以接受，白屏或整块 DOM 抖一下不能接受。
 * 所以这里盯两件事：
 * 1. 图片没就绪时画的是**占位块**（尺寸和无障碍标签都在，不会撑破布局、也不会丢标签）；
 * 2. 图片就绪后原位换成真 `<img>`，且缓存已命中的情况下**首帧就是图**（列表滚动不闪）。
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { clearAvatarCache, loadAvatarDataUri } from '../src/avatar';
import { AvatarPreview } from '../src/lobby/components/AvatarPreview';

beforeEach(() => {
  clearAvatarCache();
});

describe('AvatarPreview', () => {
  it('头像库还在加载：先画带尺寸和标签的占位块，不画空 src 的 <img>', () => {
    const { container } = render(<AvatarPreview seed="Seed123" label="阿博的头像" size={40} />);
    expect(screen.queryByAltText('阿博的头像')).toBeNull();
    const slot = container.querySelector('[data-avatar="loading"]');
    expect(slot).not.toBeNull();
    expect(slot?.getAttribute('aria-label')).toBe('阿博的头像');
    expect(slot).toHaveStyle({ width: '40px', height: '40px' });
  });

  it('加载完成后原位换成真正的 data URI 图片', async () => {
    const { container } = render(<AvatarPreview seed="Seed123" label="阿博的头像" size={40} />);
    const img = await screen.findByAltText('阿博的头像');
    expect(img.tagName).toBe('IMG');
    expect(img.getAttribute('src')?.startsWith('data:image/svg+xml')).toBe(true);
    expect(container.querySelector('[data-avatar="loading"]')).toBeNull();
  });

  it('缓存里已经有了就不经过占位帧（列表滚动不闪）', async () => {
    await loadAvatarDataUri('Seed123', 40);
    render(<AvatarPreview seed="Seed123" label="阿博的头像" size={40} />);
    expect(screen.getByAltText('阿博的头像').getAttribute('src')?.startsWith('data:image/svg+xml')).toBe(true);
  });

  it('seed 换了就换图：同尺寸下两张脸不会串，也不会把旧脸挂在新名字下面', async () => {
    const { rerender } = render(<AvatarPreview seed="Seed123" label="阿博的头像" size={40} />);
    const first = await screen.findByAltText('阿博的头像');
    const firstSrc = first.getAttribute('src');
    rerender(<AvatarPreview seed="Seed124" label="阿博的头像" size={40} />);
    // Seed124 的图还没加载出来，此时必须回到占位，而不是继续显示 Seed123 的脸。
    expect(screen.queryByAltText('阿博的头像')).toBeNull();
    const second = await screen.findByAltText('阿博的头像');
    expect(second.getAttribute('src')).not.toBe(firstSrc);
    expect(second.getAttribute('src')?.startsWith('data:image/svg+xml')).toBe(true);
  });
});
