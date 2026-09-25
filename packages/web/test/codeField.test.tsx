/**
 * 配对码输入框 —— 直接对应验收项「配对码输入自动转大写，非法字符被过滤」。
 *
 * 收敛规则本身在 shared 的 `filterPairingInput` 里已经有单测，
 * 这里测的是**它有没有真的接到 input 上**：受控组件回填的是 state，
 * 所以非法字符不只是提交时报错，而是根本打不进去。
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { CodeField } from '../src/lobby/components/CodeField';

/** 受控组件要有地方存值，所以套一层最小的宿主 */
function Harness({ initial = '', onSubmit, disabled = false }: HarnessProps): ReactNode {
  const [value, setValue] = useState(initial);
  return <CodeField id="code" value={value} onChange={setValue} onSubmit={onSubmit} disabled={disabled} />;
}

interface HarnessProps {
  readonly initial?: string;
  readonly onSubmit?: () => void;
  readonly disabled?: boolean;
}

function input(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>('配对码');
}

function typeIn(raw: string): void {
  fireEvent.change(input(), { target: { value: raw } });
}

describe('CodeField · 输入收敛', () => {
  it('小写自动转大写', () => {
    render(<Harness />);
    typeIn('k7qm3d');
    expect(input().value).toBe('K7QM3D');
  });

  it('易混淆的 I O 0 1 打不进去', () => {
    render(<Harness />);
    typeIn('IiOo01');
    expect(input().value).toBe('');
  });

  it('空白、连字符、中文一律被过滤', () => {
    render(<Harness />);
    typeIn(' K7-QM 3D 好');
    expect(input().value).toBe('K7QM3D');
  });

  it('顺序回归：粘贴 IIIIIIABC 得到 ABC 而不是空', () => {
    // 如果给 input 加了 maxLength，浏览器会先把它剪成 IIIIII，过滤完就成了空。
    // 玩家明明敲对了码，框里却什么都没有——这是不能接受的。
    render(<Harness />);
    typeIn('IIIIIIABC');
    expect(input().value).toBe('ABC');
  });

  it('顺序回归：前面塞满 0 也一样', () => {
    render(<Harness />);
    typeIn('0000000000ABCDEF');
    expect(input().value).toBe('ABCDEF');
  });

  it('超过 6 位被截断', () => {
    render(<Harness />);
    typeIn('ABCDEFGH');
    expect(input().value).toBe('ABCDEF');
  });

  it('刻意不设 maxLength 属性（理由见上一条）', () => {
    render(<Harness />);
    expect(input()).not.toHaveAttribute('maxlength');
  });
});

describe('CodeField · 提示与可访问性', () => {
  it('空值时提示规则，不报错', () => {
    render(<Harness />);
    expect(screen.getByText('不含易混淆的 I O 0 1，共 6 位')).toBeInTheDocument();
    expect(input()).not.toHaveAttribute('aria-invalid', 'true');
  });

  it('打了一半时告诉玩家还差几位', () => {
    render(<Harness initial="K7Q" />);
    expect(screen.getByText('还差 3 位')).toBeInTheDocument();
    expect(input()).toHaveAttribute('aria-invalid', 'true');
  });

  it('打满且合法时给正反馈，并去掉 valid 之外的错误态', () => {
    render(<Harness initial="K7QM3D" />);
    expect(screen.getByText('配对码格式正确')).toBeInTheDocument();
    expect(input()).toHaveAttribute('aria-invalid', 'false');
    expect(input()).toHaveClass('field__input--valid');
  });

  it('提示通过 aria-describedby 关联到输入框', () => {
    render(<Harness initial="K7Q" />);
    expect(input()).toHaveAttribute('aria-describedby', 'code-hint');
    expect(screen.getByText('还差 3 位').id).toBe('code-hint');
  });

  it('手机上会弹字母键盘并默认大写', () => {
    render(<Harness />);
    expect(input()).toHaveAttribute('autocapitalize', 'characters');
    expect(input()).toHaveAttribute('autocomplete', 'off');
  });
});

describe('CodeField · 提交与禁用', () => {
  it('敲回车触发 onSubmit（手机上的「前往」键等价于点「加入」）', () => {
    const onSubmit = vi.fn();
    render(<Harness initial="K7QM3D" onSubmit={onSubmit} />);
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('其它按键不触发', () => {
    const onSubmit = vi.fn();
    render(<Harness initial="K7QM3D" onSubmit={onSubmit} />);
    fireEvent.keyDown(input(), { key: 'a' });
    fireEvent.keyDown(input(), { key: 'Tab' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('没传 onSubmit 时敲回车也不炸', () => {
    render(<Harness initial="K7QM3D" />);
    expect(() => {
      fireEvent.keyDown(input(), { key: 'Enter' });
    }).not.toThrow();
  });

  it('disabled 会传到 input 上', () => {
    render(<Harness disabled />);
    expect(input()).toBeDisabled();
  });
});
