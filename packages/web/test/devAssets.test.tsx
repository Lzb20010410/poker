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
 * 5. **五个音效各有一颗试听按钮**（M4.2 加在这一页上）。
 *
 * ## 为什么音效的试听也放这一页
 *
 * `synth.ts` 的音色表是纯代码，听感这一半机器答不了，而「手机 Safari 能不能出声」
 * 这条验收项更没法在牌桌上等——那要凑齐一桌人打到发牌那一刻。试听按钮把这两件事
 * 压成一次点击：手机上打开这一页，点五下就知道响不响、像不像。
 * 按 D-028 的分工，这一页只回答人的问题，音色表本身的可证部分在 `soundSynth.test.ts`。
 */

import { cleanup, fireEvent, render, screen, waitFor, within, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { RANKS, SUITS } from '@poker-room/shared/view';

import { AppRoutes } from '../src/App';
import { avatarCacheSize, clearAvatarCache } from '../src/avatar';
import { CHIP_DENOMINATIONS } from '../src/assets/chips';
import { DevAssetsPage } from '../src/dev/DevAssetsPage';
import type { SoundPlayer } from '../src/sound/player';
import { SOUND_MUTED_KEY } from '../src/sound/settings';
import { SOUND_LABELS, SOUND_NAMES, type SoundName } from '../src/sound/synth';
import { SoundProvider } from '../src/state/SoundContext';
import { cardText } from '../src/table/components/CardView';

/** 按 `data-assets` 取一个区块。页面本身不在 `AppShell` 里渲染，所以不假设外层 */
function region(key: string): HTMLElement {
  const node = document.querySelector(`[data-assets="${key}"]`);
  if (node === null) throw new Error(`缺少 data-assets="${key}" 区块`);
  return node as HTMLElement;
}

/**
 * 渲染这一页。
 *
 * 生产里它永远挂在 `<SoundProvider>` 下面（`App.tsx`），而试听区读 `useSound()`，
 * Provider 外面是**故意**抛错的（和 `useRoom` / `useProfile` 同一口径），所以用例也得套上。
 * 传 `player` 是给试听那几条记账用的；不传就自己建一枚，jsdom 里没有 `AudioContext`，
 * 它会安静地什么都不放。
 */
function renderPage(player?: SoundPlayer): RenderResult {
  return render(
    <SoundProvider player={player}>
      <DevAssetsPage />
    </SoundProvider>,
  );
}

describe('/dev/assets 资产页', () => {
  afterEach(() => {
    cleanup();
    clearAvatarCache();
  });

  it('平铺 52 张牌面，每张一张独立且互不相同的图', () => {
    renderPage();
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
    renderPage();
    const small = within(region('faces-small')).getAllByRole('img');
    expect(small).toHaveLength(52);
    // 高度必须是真 24px：这条验收项要看的就是 24px，写成 48 再 CSS 缩就是骗眼睛
    expect(new Set(small.map((img) => img.getAttribute('height')))).toEqual(new Set(['24']));
  });

  it('牌背单独一块，与牌面不是同一张图', () => {    renderPage();
    const back = within(region('back')).getAllByRole('img');
    expect(back).toHaveLength(1);
    const faceSources = new Set(within(region('faces')).getAllByRole('img').map((img) => img.getAttribute('src')));
    expect(faceSources.has(back[0]?.getAttribute('src') ?? '')).toBe(false);
  });

  it('6 档筹码按面额标注，两档桌布绿前蓝后', () => {
    renderPage();
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
    const { container } = renderPage();
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('path')).toBeNull();
    expect(container.querySelectorAll('[id*="felt-gradient"], [id*="cb-lattice"], [id*="chip-"]')).toHaveLength(0);
  });

  it('8 个预置头像渲染完成，重渲染不再新增缓存', async () => {
    renderPage();
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
    renderPage();
    const again = within(region('avatars')).getAllByRole('img');
    expect(again.map((img) => img.getAttribute('src'))).toEqual(srcs);
    expect(avatarCacheSize(), '第二次渲染应当命中缓存').toBe(8);
  });

  it('自定义 seed 立刻能看到自己的脸（预置只有 8 张，不够玩家用）', async () => {
    renderPage();
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
      <SoundProvider>
        <MemoryRouter initialEntries={['/dev/assets']}>
          <AppRoutes />
        </MemoryRouter>
      </SoundProvider>,
    );
    await screen.findByRole('heading', { level: 1, name: '资产总览' });
    expect(screen.queryByRole('heading', { level: 2, name: '你的身份' })).toBeNull();
  });
});

/**
 * 试听区（M4.2）。这一组测的是「按钮 ↔ 音效名」这条接线，音色本身的对错在
 * `soundSynth.test.ts`，能不能在浏览器里响在 `soundPlayer.test.ts`。
 *
 * 播放器换成记账的假件是有理由的：这一页要证的只有「点这颗按钮放的是这一声」，
 * 而真播放器在没有 `AudioContext` 的 jsdom 里会静默退化——那样点了什么都不记，
 * 用例就会红在「没接线」和「环境不支持」两种完全不同的原因上，分不出来。
 */
describe('/dev/assets 音效试听区', () => {
  function recordingPlayer(): { player: SoundPlayer; played: SoundName[] } {
    const played: SoundName[] = [];
    return {
      played,
      player: { unlock: () => undefined, play: (name) => played.push(name) },
    };
  }

  function renderWithPlayer(): SoundName[] {
    const { player, played } = recordingPlayer();
    renderPage(player);
    return played;
  }

  function soundButton(name: SoundName): HTMLElement {
    return within(region('sounds')).getByRole('button', { name: SOUND_LABELS[name] });
  }

  it('五声按 `SOUND_NAMES` 的顺序各摆一颗，文案是中文', () => {
    renderWithPlayer();
    const buttons = within(region('sounds')).getAllByRole('button');
    expect(buttons).toHaveLength(SOUND_NAMES.length);
    expect(buttons.map((button) => button.textContent)).toEqual(SOUND_NAMES.map((name) => SOUND_LABELS[name]));
  });

  it.each(SOUND_NAMES)('点「%s」这一颗，放的是这一声，不是别的', (name) => {
    const played = renderWithPlayer();
    fireEvent.click(soundButton(name));
    expect(played).toEqual([name]);
  });

  it('静音档下点试听不响：门禁只有 Provider 一处，页面不自己绕过它放声', () => {
    localStorage.setItem(SOUND_MUTED_KEY, 'muted');
    const played = renderWithPlayer();
    fireEvent.click(soundButton('deal'));
    expect(played).toEqual([]);
  });

  afterEach(() => {
    localStorage.removeItem(SOUND_MUTED_KEY);
  });
});
