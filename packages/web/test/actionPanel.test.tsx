/**
 * 操作面板（M2.4）。
 *
 * ## 为什么直接渲染 `ActionPanel`
 *
 * 这一份管的全是「面板自己的形状」：三颗按钮的文案、滑杆的范围、快捷额度、
 * 键盘、抽屉。连接和路由不参与，套整页只会让失败原因变模糊
 * （`table.test.tsx` 已经在那一侧盯着「点了之后上送的那条命令长什么样」）。
 *
 * ## 断言的两条界线
 *
 * - 面板**不判定合法性**。它只把服务端的 `legal` 翻成 disabled 属性、把范围抄进滑杆。
 *   所以这里断言的是「范围等于 `legal` 给的那两个数」，而不是「这个加注合不合规则」。
 * - 非法额度**照样能发**（SPEC §4.4 的软提示）。这一条和 M1.6 的旧行为相反，
 *   旧实现是「越界就不亮」；改过来的理由写在下面那条用例的注释里。
 */

import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { Action } from '@poker-room/shared/view';

import type { LegalActionsView } from '../src/net/types';
import { ActionPanel } from '../src/table/components/ActionPanel';

/**
 * 翻牌前：桌上要跟 20，我这一街还没投（不在盲位），剩 1820。
 *
 * `chips` 取 1820 而不是一个整数的 1800，是为了让「加注上限 = 已投 + 筹码」这条
 * 公式落在一个**不是大盲整数倍**的数上。刻度吸附与全下档的行为差别只有在这种
 * 时候才看得出来（见下面「全下那一档给的是 max」）。
 */
const TABLE = {
  smallBlind: 10,
  bigBlind: 20,
  chips: 1820,
  committedThisStreet: 0,
  currentBet: 20,
  lastRaiseSize: 20,
  potTotal: 120,
};

/**
 * 服务端会给我的那一份提示位。
 *
 * 两个范围数字是照 SPEC §4.4 的公式摆出来的 fixture——真值由 `engine` 算
 * （`betting.ts` 的 `legalActions`），面板只照抄。写成公式是为了让下面的断言
 * 一眼看得出「滑杆的 min/max 到底该等于什么」。
 */
function legalFor(overrides: Partial<LegalActionsView> = {}): LegalActionsView {
  return {
    canFold: true,
    canCheck: false,
    callAmount: TABLE.currentBet - TABLE.committedThisStreet,
    canRaise: true,
    minRaiseTotal: TABLE.currentBet + TABLE.lastRaiseSize,
    maxRaiseTotal: TABLE.chips + TABLE.committedThisStreet,
    canAllIn: true,
    ...overrides,
  };
}

function renderPanel(props: Partial<ComponentProps<typeof ActionPanel>> = {}) {
  const onAction = vi.fn<(action: Action) => void>();
  const legal = props.legal ?? legalFor();
  const rendered = render(
    <ActionPanel
      legal={legal}
      handId="h-1"
      turnVersion={3}
      canAct
      potTotal={TABLE.potTotal}
      currentBet={TABLE.currentBet}
      bigBlind={TABLE.bigBlind}
      onAction={onAction}
      {...props}
    />,
  );
  return { ...rendered, onAction, legal };
}

const slider = (): HTMLElement => screen.getByRole('slider', { name: '加注额度' });
const amountBox = (): HTMLElement => screen.getByRole('spinbutton', { name: '加注到（总额）' });

describe('操作面板 · 三颗主按钮', () => {
  it('有下注额要跟时，中间那颗是「跟注 N」，不是「过牌」', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: '弃牌' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '跟注 20' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: '过牌' })).not.toBeInTheDocument();
  });

  it('不用跟的时候同一颗变成「过牌」，点下去上送 check', () => {
    const { onAction } = renderPanel({
      legal: legalFor({ canCheck: true, callAmount: 0 }),
    });
    fireEvent.click(screen.getByRole('button', { name: '过牌' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'check' });
  });

  it('第三颗写着它要送的额度，加注时上送的是总额不是增量', () => {
    const { onAction } = renderPanel();
    const raise = screen.getByRole('button', { name: '加注到 40' });
    fireEvent.click(raise);
    expect(onAction).toHaveBeenCalledWith({ type: 'raise', totalBet: 40 });
  });

  it('短码加不动（canRaise 关着）时第三颗就是「全下」，上送 allIn', () => {
    const { onAction } = renderPanel({
      legal: legalFor({ canRaise: false, maxRaiseTotal: 30, minRaiseTotal: 40 }),
    });
    fireEvent.click(screen.getByRole('button', { name: '全下' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'allIn' });
  });

  it('短码时滑杆与快捷额度整排撤掉：没有可加的范围就别摆一排刻度', () => {
    renderPanel({ legal: legalFor({ canRaise: false, maxRaiseTotal: 30, minRaiseTotal: 40 }) });
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '1/2 池' })).not.toBeInTheDocument();
  });

  it('canAct 为 false（没轮到我 / 断线 / 上一步悬着）时三颗全灰', () => {
    renderPanel({ canAct: false });
    for (const name of ['弃牌', '跟注 20', '加注到 40']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
  });
});

describe('操作面板 · 滑杆范围（SPEC §4.4）', () => {
  it('min = currentBet + lastRaiseSize，max = chips + committedThisStreet，步长 = 大盲', () => {
    renderPanel();
    expect(slider()).toHaveAttribute('min', String(TABLE.currentBet + TABLE.lastRaiseSize));
    expect(slider()).toHaveAttribute('max', String(TABLE.chips + TABLE.committedThisStreet));
    expect(slider()).toHaveAttribute('step', String(TABLE.bigBlind));
    // 输入框与滑杆同范围：两处各写一套上限，迟早有一处忘了跟着改
    expect(amountBox()).toHaveAttribute('min', '40');
    expect(amountBox()).toHaveAttribute('max', '1820');
  });

  it('拖滑杆同时改掉输入框里的数', () => {
    renderPanel();
    fireEvent.change(slider(), { target: { value: '300' } });
    expect(amountBox()).toHaveValue(300);
  });
});

describe('操作面板 · 快捷额度', () => {
  it('四档算出的额度同时落到滑杆与输入框', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '2/3 池' }));
    // 底池 120 的 2/3 = 80，加在 currentBet 20 之上 = 100（已落在 20 的刻度上）
    expect(amountBox()).toHaveValue(100);
    expect(slider()).toHaveValue('100');
    expect(screen.getByRole('button', { name: '加注到 100' })).toBeEnabled();
  });

  it('全下那一档给的是 max，不是四舍五入到刻度上的值', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '底池' }));
    expect(amountBox()).toHaveValue(140);
    fireEvent.click(screen.getByRole('button', { name: '全下' }));
    expect(amountBox()).toHaveValue(1820);
    expect(screen.getByRole('button', { name: '加注到 1,820' })).toBeEnabled();
  });

  it('步长是大盲时按比例算不出整刻度，就近吸附而不是发一个奇怪的数', () => {
    renderPanel({ bigBlind: 50 });
    fireEvent.click(screen.getByRole('button', { name: '1/2 池' }));
    expect(amountBox()).toHaveValue(90);
  });
});

describe('操作面板 · 非法额度标红但照发', () => {
  it('超出服务端范围时输入框标红、给一句说明，按钮仍然能点', () => {
    const { onAction } = renderPanel();
    fireEvent.change(amountBox(), { target: { value: '99999' } });
    expect(amountBox()).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: '加注到 99,999' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '加注到 99,999' }));
    // M1.6 的旧行为是「越界就不亮」。改成标红照发是 SPEC §4.4 的软提示：
    // 前端多一套判定就多一处和服务端漂移的地方，判错的方向还正好是「不让玩家下注」。
    expect(onAction).toHaveBeenCalledWith({ type: 'raise', totalBet: 99999 });
  });

  it('标红的那句说明带着服务端给的范围，不让人猜合法区间', () => {
    renderPanel();
    fireEvent.change(amountBox(), { target: { value: '25' } });
    expect(screen.getByText(/40\s*~\s*1,820/)).toBeInTheDocument();
  });

  it('输入框清空时回到最低加注额，界面不留空白', () => {
    renderPanel();
    fireEvent.change(amountBox(), { target: { value: '' } });
    expect(amountBox()).toHaveValue(40);
    expect(amountBox()).toHaveAttribute('aria-invalid', 'false');
  });
});

describe('操作面板 · 键盘（SPEC §4.4）', () => {
  it('F / C / R 分别对应弃牌、跟注、调额度', () => {
    const { onAction } = renderPanel();
    fireEvent.keyDown(window, { key: 'f' });
    expect(onAction).toHaveBeenCalledWith({ type: 'fold' });
    fireEvent.keyDown(window, { key: 'c' });
    expect(onAction).toHaveBeenCalledWith({ type: 'call' });
    fireEvent.keyDown(window, { key: 'r' });
    // 展开后那颗切换钮的文案会跟着翻（调整 ↔ 收起），所以按名字的后半段找
    expect(screen.getByRole('button', { name: /加注额度$/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: '收起加注额度' })).toBeInTheDocument();
  });

  it('↑↓ 按大盲的整数倍调额度，Enter 送加注', () => {
    const { onAction } = renderPanel();
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(amountBox()).toHaveValue(80);
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(amountBox()).toHaveValue(60);
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onAction).toHaveBeenCalledWith({ type: 'raise', totalBet: 60 });
  });

  it('不用加注时 Enter 送的是跟注', () => {
    const { onAction } = renderPanel({ legal: legalFor({ canRaise: false }) });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onAction).toHaveBeenCalledWith({ type: 'call' });
  });

  it('焦点在输入框里时，字母与箭头都不抢键（手机打字与桌面改数都不受影响）', () => {
    const { onAction } = renderPanel();
    const box = amountBox();
    fireEvent.keyDown(box, { key: 'f' });
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(onAction).not.toHaveBeenCalled();
    expect(box).toHaveValue(40);
  });

  it('canAct 为 false 时键盘整个不响应', () => {
    const { onAction } = renderPanel({ canAct: false });
    fireEvent.keyDown(window, { key: 'f' });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onAction).not.toHaveBeenCalled();
  });

  it('带修饰键的组合不抢（Ctrl+F 浏览器的查找还得能用）', () => {
    const { onAction } = renderPanel();
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    expect(onAction).not.toHaveBeenCalled();
  });
});

describe('操作面板 · 竖屏抽屉', () => {
  it('抽屉默认收起，展开时容器带上 open 类名（样式决定竖屏藏哪一段）', () => {
    const { container } = renderPanel();
    const panel = container.querySelector('.action-panel');
    expect(panel?.className).not.toContain('action-panel--open');
    fireEvent.click(screen.getByRole('button', { name: '调整加注额度' }));
    expect(panel?.className).toContain('action-panel--open');
  });

  it('换了一步（handId / turnVersion）抽屉自己收回去，不留上一步展开的状态', () => {
    const { rerender, container } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '调整加注额度' }));
    rerender(
      <ActionPanel
        legal={legalFor()}
        handId="h-1"
        turnVersion={4}
        canAct
        potTotal={TABLE.potTotal}
        currentBet={TABLE.currentBet}
        bigBlind={TABLE.bigBlind}
        onAction={() => {}}
      />,
    );
    expect(container.querySelector('.action-panel')?.className).not.toContain('action-panel--open');
    expect(amountBox()).toHaveValue(40);
  });

  it('每一档可点区域都标了 48px 以上的高度由 CSS 给（类名在此处可断言）', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: '弃牌' }).className).toContain('btn');
    expect(slider().className).toContain('action-panel__slider');
  });
});
