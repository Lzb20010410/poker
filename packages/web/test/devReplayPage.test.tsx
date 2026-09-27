/**
 * `/dev/replay` 回放器**页面**（M3.2）。
 *
 * ## 这里钉的是"这台仪器通不通电"，不是"动画好不好看"
 *
 * `TASKS.md` M3.2 的验收第一条是「不连服务端即可运行」，最后一条是「用户目视验收：必须好用」。
 * 后者机器替不了——牌飞得利落不利落只有人眼能判。但给人用的东西本身也会坏，
 * 而它一坏就是**整个 M3 的验收工具失效**：路由没挂上、播放键按下去不动、
 * 动画期间按钮不灰（那这里验的就和线上不是一回事）、换场景没归零。
 * 所以这一条测试线钉的全是"仪器本身成立吗"。
 *
 * 帧里的数据对不对（筹码守恒、只亮发过的那手牌、`legal` 只落在我这格）在 `devReplay.test.ts`；
 * 队列的规则在 `animQueue.test.ts`；事件怎么变成长计划在 `animPlan.test.ts`。三层各钉各的。
 *
 * ## 为什么不 mock 动画
 *
 * 页面上的「跳过动画」「按钮灰不灰」全部取决于队列的真实节拍。把渲染器换成同步完成的假件，
 * `blocked` 就几乎永远是 false，那两条断言会退化成"元素存在吗"——看着绿，其实什么都没钉。
 * 所以这里渲染真组件、跑真 GSAP：需要稳定读数就在点击之后**立刻**取值（那一拍 rAF 还没走），
 * 每个用例收尾时用「跳过动画」把队列清空，不把上一段的动画带进下一条。
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { ANIM_BACKLOG_LIMIT } from '../src/anim/queue';
import { AppRoutes } from '../src/App';
import { DevReplayPage } from '../src/dev/DevReplayPage';

/** A（8 人满桌）里第一份带事件的帧：`hand:start → shuffle → deal:start → turn:change` 同批到达 */
const FRAME_DEAL = '开局 · 发牌';
/** B（边池）的最后一帧：6 段动画，天生超过积压上限 */
const FRAME_SIDE_POT_AWARD = '4 号全进 → 三个池依次派彩';
/** C（单挑）的最后一帧：单人派彩路径，末尾挂着一条 `player:emoji` */
const FRAME_WALK = '对面弃牌 → 300 退回 → 直接派彩';
const PICK_HEADS_UP = '单挑 · 无人跟注的派彩';
const PICK_SIDE_POTS = '边池 · 三个池三个赢家';

const EMPTY_QUEUE = `队列 0 段 / 上限 ${String(ANIM_BACKLOG_LIMIT)}`;
const ACTION_HINT = '轮到你行动了（这一页点了不会有任何反应）。';
const BLOCKED_HINT = '正在播动画，按钮按 SPEC §3.1 按住。';

/** 这一页不挂任何 Provider：没有连接可注入，挂上反而是假的成立 */
function renderReplay(): HTMLElement {
  return render(<DevReplayPage />).container;
}

function requireNode(container: HTMLElement, selector: string): HTMLElement {
  const node = container.querySelector<HTMLElement>(selector);
  if (node === null) throw new Error(`回放器页面缺了 ${selector}`);
  return node;
}

/** 队列读数。目前只用它收尾（确认这一段真的清空了），不当断言对象，理由见下面那条多池用例 */
function queueText(container: HTMLElement): string {
  return (requireNode(container, '.dev-replay__queue').textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** 「第 i / N 帧」——这一页唯一的"我播到哪儿了" */
function positionText(container: HTMLElement): string {
  return (requireNode(container, '.dev-replay__position').textContent ?? '').replace(/\s+/g, ' ').trim();
}

function frameList(container: HTMLElement): HTMLElement {
  return requireNode(container, '.dev-replay__frames');
}

function frameButtons(container: HTMLElement): HTMLElement[] {
  return Array.from(frameList(container).querySelectorAll<HTMLElement>('.dev-replay__frame'));
}

function frameCount(container: HTMLElement): number {
  return frameButtons(container).length;
}

/** 跳到第 `index` 帧（0 起）。这一页最常用的动作，所以每条用例都从它进 */
function jumpTo(container: HTMLElement, index: number): void {
  const button = frameButtons(container)[index];
  if (button === undefined) throw new Error(`没有第 ${String(index + 1)} 帧`);
  fireEvent.click(button);
}

function jumpToLabel(container: HTMLElement, label: string): void {
  const index = frameButtons(container).findIndex((row) => (row.textContent ?? '').includes(label));
  if (index < 0) throw new Error(`这一桌没有名为「${label}」的帧`);
  jumpTo(container, index);
}

/** 把在飞的这一段收干净：没有「跳过动画」就说明队列本来就空着 */
function settle(container: HTMLElement): void {
  const skip = screen.queryByRole('button', { name: '跳过动画' });
  if (skip !== null) fireEvent.click(skip);
  expect(queueText(container)).toBe(EMPTY_QUEUE);
}

function foldButton(): HTMLElement {
  return screen.getByRole('button', { name: '弃牌' });
}

describe('/dev/replay 回放器页面', () => {
  it('不连服务端、不挂 Provider 就把整套牌桌摆出来了', () => {
    render(<DevReplayPage />);
    screen.getByRole('heading', { level: 1, name: '状态回放器' });
    // 产品组件本体：桌面图、公共牌区、底牌区各一份，说明渲染的是真组件而不是占位
    expect(screen.getAllByRole('img', { name: '牌桌桌面' })).toHaveLength(1);
    expect(screen.getAllByRole('region', { name: '公共牌' })).toHaveLength(1);
    expect(screen.getAllByRole('region', { name: '我的底牌' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: new RegExp(FRAME_DEAL) })).not.toBeNull();
  });

  it('三个预置场景各一颗按钮，起手选中第一个', () => {
    render(<DevReplayPage />);
    const picks = within(screen.getByRole('group', { name: '场景' })).getAllByRole('button');
    expect(picks.map((button) => button.textContent)).toEqual([
      '8 人满桌 · 平分底池',
      PICK_SIDE_POTS,
      PICK_HEADS_UP,
    ]);
    expect(picks[0]).toHaveAttribute('aria-pressed', 'true');
    expect(picks[2]).toHaveAttribute('aria-pressed', 'false');
  });

  it('起手停在第一帧，队列空着', () => {
    const root = renderReplay();
    expect(positionText(root)).toBe(`第 1 / ${String(frameCount(root))} 帧`);
    expect(queueText(root)).toBe(EMPTY_QUEUE);
    // 起手那一帧是「空桌」：座位有人，但牌还没发
    expect(root.querySelector('.hole-strip[data-self]')).toBeNull();
  });

  it('跳帧会把位置读数与 `aria-current` 一起带上', () => {
    const root = renderReplay();
    jumpTo(root, 1);
    expect(positionText(root)).toBe(`第 2 / ${String(frameCount(root))} 帧`);
    const current = frameButtons(root).filter((row) => row.getAttribute('aria-current') === 'true');
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent ?? '').toContain(FRAME_DEAL);
    settle(root);
  });

  it('发牌那一帧把「我」的两张底牌挂上动画锚点', () => {
    const root = renderReplay();
    jumpToLabel(root, FRAME_DEAL);
    // `data-anim="hole-0"` 是 `dealJob` 找落点用的键，锚点错了牌就飞到一个不存在的格子上
    expect(requireNode(root, '.hole-strip[data-self]').getAttribute('data-anim')).toBe('hole-0');
    settle(root);
  });

  /**
   * SPEC §3.1「动画期间操作按钮按住」——回放器存在的意义之一。
   *
   * 线上要复现这一刻得攒一桌人、还得刚好轮到你自己；这里点一帧就行。
   * 而且那一帧脚本给「我」填了 `legal`，所以按住的确实是一颗**本来能点**的按钮：
   * 换成轮不到人的帧来测，按钮本来就灰，断言就成了摆设。
   */
  it('动画没播完之前操作按钮是灰的，跳过之后立刻还回来', () => {
    const root = renderReplay();
    jumpToLabel(root, FRAME_DEAL);
    expect(screen.getByRole('button', { name: '跳过动画' })).not.toBeNull();
    screen.getByText(BLOCKED_HINT);
    expect(foldButton()).toBeDisabled();
    expect(queueText(root)).not.toBe(EMPTY_QUEUE);

    settle(root);
    expect(screen.queryByRole('button', { name: '跳过动画' })).toBeNull();
    expect(foldButton()).toBeEnabled();
    screen.getByText(ACTION_HINT);
  });

  it('轮不到我的那一帧，提示文字不许冒充"该你动手"', () => {
    const root = renderReplay();
    jumpTo(root, 2);
    settle(root);
    expect(screen.queryByText(ACTION_HINT)).toBeNull();
    expect(screen.queryByText(BLOCKED_HINT)).toBeNull();
    expect(foldButton()).toBeDisabled();
  });

  it('单步一帧一帧走，到底了就停住', () => {
    const root = renderReplay();
    const total = frameCount(root);
    fireEvent.click(screen.getByRole('button', { name: '单步' }));
    expect(positionText(root)).toBe(`第 2 / ${String(total)} 帧`);
    settle(root);
    fireEvent.click(screen.getByRole('button', { name: '单步' }));
    expect(positionText(root)).toBe(`第 3 / ${String(total)} 帧`);
    settle(root);

    jumpTo(root, total - 1);
    settle(root);
    expect(screen.getByRole('button', { name: '单步' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '播放' })).toBeDisabled();
  });

  /**
   * 「等这一段播完再走下一帧」这条节奏规则，机器能钉的是"它确实会自己往前走"。
   * 停得顺不顺、每一帧呼吸多久，是目视验收的活。
   */
  it('播放会自己进下一帧，暂停就停在当前', async () => {
    const root = renderReplay();
    fireEvent.click(screen.getByRole('button', { name: '播放' }));
    expect(screen.getByRole('button', { name: '暂停' })).not.toBeNull();
    await waitFor(() => {
      expect(positionText(root)).toBe(`第 2 / ${String(frameCount(root))} 帧`);
    });
    fireEvent.click(screen.getByRole('button', { name: '暂停' }));
    expect(screen.getByRole('button', { name: '播放' })).not.toBeNull();
    settle(root);
  });

  it('加速那颗在 0.5× 与原速之间来回拨', () => {
    render(<DevReplayPage />);
    fireEvent.click(screen.getByRole('button', { name: '加速' }));
    fireEvent.click(screen.getByRole('button', { name: '原速' }));
    expect(screen.getByRole('button', { name: '加速' })).not.toBeNull();
  });

  /*
    换场景 / 重来的实现是「换 React 的 `key` 整棵重挂」，所以这两条验的是重挂之后
    什么都没了：帧位回到 1、队列空、气泡不跟着过去。
  */

  it('重来把帧位、队列、气泡一起归零', () => {
    const root = renderReplay();
    fireEvent.click(screen.getByRole('button', { name: PICK_HEADS_UP }));
    jumpToLabel(root, FRAME_WALK);
    expect(root.querySelector('.seat__emote')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '重来' }));
    expect(positionText(root)).toBe(`第 1 / ${String(frameCount(root))} 帧`);
    expect(queueText(root)).toBe(EMPTY_QUEUE);
    expect(root.querySelector('.seat__emote')).toBeNull();
  });

  it('换场景之后帧数、说明、帧名都是新那一桌的', () => {
    const root = renderReplay();
    const eightMax = frameCount(root);
    expect(frameButtons(root).some((row) => (row.textContent ?? '').includes('我开局加注 60'))).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: PICK_HEADS_UP }));
    const headsUp = frameCount(root);
    expect(headsUp).toBeLessThan(eightMax);
    expect(positionText(root)).toBe(`第 1 / ${String(headsUp)} 帧`);
    expect(frameButtons(root).some((row) => (row.textContent ?? '').includes('我开局加注 60'))).toBe(false);
    screen.getByText(/两人桌的规矩都在这儿/);
  });

  /** `DevTablePage` 里那句「想亲眼验气泡去 /dev/replay（它会发 `player:emoji`）」靠这条成立 */
  it('带表情的帧把气泡挂在那一格的座位上，而不是全桌一人一条', () => {
    const root = renderReplay();
    fireEvent.click(screen.getByRole('button', { name: PICK_HEADS_UP }));
    jumpToLabel(root, FRAME_WALK);
    const bubbles = root.querySelectorAll('.seat__emote');
    expect(bubbles).toHaveLength(1);
    expect((bubbles[0]?.textContent ?? '').trim().length).toBeGreaterThan(0);
    settle(root);
  });

  /**
   * 三个池的那一帧：终态一次到位，三个池一个不落地摆在结算面板里。
   *
   * 「积压超过上限就整队作废」是 `queue.ts` 的账（`animQueue.test.ts` 逐条钉），
   * 「哪一帧最重」是脚本的账（`devReplay.test.ts` 逐帧钉成清单，那一帧 6 段）。
   * 这里只钉页面上看得见的那半：**作废与否都不该改变事实**。
   * 队列深度刻意不断言——jsdom 量不到真实盒子，那一帧里有一段动画会同步落终态，
   * 于是这台机器上看到的峰值比浏览器里少一段。在这里断言「牌飞了没飞」
   * 就是假装看见了只有浏览器里才有的那一幕。
   */
  it('三个池的那一帧把三份派彩按终态摆出来', () => {
    const root = renderReplay();
    fireEvent.click(screen.getByRole('button', { name: PICK_SIDE_POTS }));
    jumpToLabel(root, FRAME_SIDE_POT_AWARD);
    expect(root.querySelectorAll('.award-list__item')).toHaveLength(3);
    settle(root);
  });

  it('路由 /dev/replay 真的命中，不被 `*` 兜底送回大厅', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/dev/replay']}>
        <AppRoutes />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(within(container).getByRole('heading', { level: 1 })).toHaveTextContent('状态回放器');
    });
    expect(within(container).queryByRole('heading', { level: 2, name: '你的身份' })).toBeNull();
  });
});
