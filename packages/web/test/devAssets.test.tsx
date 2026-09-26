/**
 * `/dev/assets` 资产平铺页（M2.1 的验收载体）。
 *
 * ## 这个页面存在的唯一理由
 *
 * `TASKS.md` M2.1 要求「有一个 `/dev/assets` 页面平铺展示全部资产，用户目视验收」。
 * 目视的部分机器做不了（这个环境没有视口也没有光栅器），所以这里只钉机器钉得住的：
 *
 * 1. **一张不缺**：52 张牌面、1 张牌背、6 档筹码、两档桌布、8 个预置头像。少一张
 *    就是资产文件名和 `RANKS × SUITS` 对不上，而那正是 `cardFaces.ts` 最容易腐坏的地方。
 * 2. **每张都是独立的一张图**：52 个 `src` 互不相同。哪天有人改成雪碧图或按花色合并，
 *    `src` 会开始重复，这条就红。
 * 3. **页面的 DOM 里没有内联 SVG 的 `id`**。牌面和桌面都是 data URI 交给 `<img>` 渲染；
 *    要是有人图省事把整份 SVG 注进文档，两份同名 `id` 会互相打架，症状是"这张牌的
 *    花色变成了别人的"——极难查。
 * 4. **头像缓存真的生效**：同一 seed 再问一次，缓存条目不增长。
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { RANKS, SUITS } from '@poker-room/shared/view';

import { AppRoutes } from '../src/App';
import { avatarCacheSize, clearAvatarCache } from '../src/avatar';
import { CHIP_DENOMINATIONS } from '../src/assets/chips';
import { DevAssetsPage } from '../src/dev/DevAssetsPage';
import { cardText } from '../src/table/components/CardView';

/** 按 `data-assets` 取一个区块。页面本身不在 `AppShell` 里渲染，所以不假设外层 */
function region(key: string): HTMLElement {
  const node = document.querySelector(`[data-assets="${key}"]`);
  if (node === null) throw new Error(`缺少 data-assets="${key}" 区块`);
  return node as HTMLElement;
}

describe('/dev/assets 资产页', () => {
  afterEach(() => {
    cleanup();
    clearAvatarCache();
  });

  it('平铺 52 张牌面，每张一张独立且互不相同的图', () => {
    render(<DevAssetsPage />);
    const faces = within(region('faces')).getAllByRole('img');
    expect(faces).toHaveLength(52);
    expect(new Set(faces.map((img) => img.getAttribute('src'))).size).toBe(52);

    // 13 rank × 4 suit 一个都不能少。（牌面内容对不对由 cardFaces.test.ts 直接查盘负责，
    // 它才是独立证据；这里只管"平铺得全"。）
    const expected = new Set(RANKS.flatMap((rank) => SUITS.map((suit) => cardText({ rank, suit }))));
    expect(expected.size).toBe(52);
    expect(new Set(faces.map((img) => img.getAttribute('alt') ?? ''))).toEqual(expected);
  });

  it('另有一条 24px 高的牌面带，供「小尺寸可辨识」目视验收', () => {
    render(<DevAssetsPage />);
    const small = within(region('faces-small')).getAllByRole('img');
    expect(small).toHaveLength(52);
    // 高度必须是真 24px：这条验收项要看的就是 24px，写成 48 再 CSS 缩就是骗眼睛
    expect(new Set(small.map((img) => img.getAttribute('height')))).toEqual(new Set(['24']));
  });

  it('牌背单独一块，与牌面不是同一张图', () => {    render(<DevAssetsPage />);
    const back = within(region('back')).getAllByRole('img');
    expect(back).toHaveLength(1);
    const faceSources = new Set(within(region('faces')).getAllByRole('img').map((img) => img.getAttribute('src')));
    expect(faceSources.has(back[0]?.getAttribute('src') ?? '')).toBe(false);
  });

  it('6 档筹码按面额标注，两档桌布绿前蓝后', () => {
    render(<DevAssetsPage />);
    const chips = within(region('chips')).getAllByRole('img');
    expect(chips).toHaveLength(CHIP_DENOMINATIONS.length);
    expect(chips).toHaveLength(6);
    expect(chips.map((img) => img.getAttribute('alt'))).toEqual(
      CHIP_DENOMINATIONS.map((value) => `筹码 ${value.toLocaleString('en-US')}`),
    );

    const felts = within(region('table')).getAllByRole('img');
    expect(felts.map((img) => img.getAttribute('alt'))).toEqual(['绿呢桌面', '蓝呢桌面']);
  });

  it('整页没有内联 SVG，也没有任何 SVG 内部 id 泄漏到文档里', () => {
    const { container } = render(<DevAssetsPage />);
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('path')).toBeNull();
    expect(container.querySelectorAll('[id*="felt-gradient"], [id*="cb-lattice"], [id*="chip-"]')).toHaveLength(0);
  });

  it('8 个预置头像渲染完成，重渲染不再新增缓存', async () => {
    render(<DevAssetsPage />);
    // 加载期间 `AvatarPreview` 画的是 `role="img"` 的占位块，光按 role 等是等不到的，
    // 所以先等缓存真的填进 8 条，再检查 DOM 上的 8 张脸。
    await waitFor(() => expect(avatarCacheSize()).toBe(8));
    const tiles = within(region('avatars')).getAllByRole('img');
    expect(tiles).toHaveLength(8);
    expect(tiles.map((tile) => tile.tagName)).toEqual(Array.from({ length: 8 }, () => 'IMG'));
    expect(tiles.map((tile) => tile.getAttribute('alt'))).toEqual(
      Array.from({ length: 8 }, (_, index) => `预置头像 ${index + 1}`),
    );

    const srcs = tiles.map((img) => img.getAttribute('src'));
    cleanup();
    render(<DevAssetsPage />);
    const again = within(region('avatars')).getAllByRole('img');
    expect(again.map((img) => img.getAttribute('src'))).toEqual(srcs);
    expect(avatarCacheSize(), '第二次渲染应当命中缓存').toBe(8);
  });

  it('自定义 seed 立刻能看到自己的脸（预置只有 8 张，不够玩家用）', async () => {
    render(<DevAssetsPage />);
    await waitFor(() => expect(avatarCacheSize()).toBe(8));

    const input = screen.getByRole('textbox', { name: '自定义头像 seed' });
    fireEvent.change(input, { target: { value: 'MyOwnSeed42' } });
    fireEvent.click(screen.getByRole('button', { name: '看看这张' }));

    await waitFor(() => expect(avatarCacheSize()).toBe(9));
    const custom = screen.getByRole('img', { name: 'seed MyOwnSeed42 的头像' });
    expect(custom.tagName).toBe('IMG');
    expect(custom.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
  });

  it('路由 /dev/assets 真的命中，不被 `*` 兜底送回大厅', async () => {
    render(
      <MemoryRouter initialEntries={['/dev/assets']}>
        <AppRoutes />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { level: 1, name: '资产总览' });
    expect(screen.queryByRole('heading', { level: 2, name: '你的身份' })).toBeNull();
  });
});
