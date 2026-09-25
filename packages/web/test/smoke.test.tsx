/**
 * 整棵 App 的冒烟测试。
 *
 * 其它测试都注入假的 `GameClient`，这一个**故意不注入**：它要验证的是
 * 「真组件树在 jsdom 里能挂起来、首屏不会白屏」。这里不会真的联网——
 * `RoomProvider` 里的 client 是懒加载的，只有点了创建/加入才会去连。
 */

import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { App } from '../src/App';
import { resetWebState } from './harness';

function goTo(path: string): void {
  window.history.pushState({}, '', path);
}

beforeEach(() => {
  resetWebState();
  goTo('/');
});

afterEach(() => {
  resetWebState();
  goTo('/');
});

describe('App 冒烟', () => {
  it('首屏就是大厅，合规声明在每个页面都看得见（D-000）', () => {
    render(<App />);

    expect(screen.getByRole('link', { name: '私局德州' })).toHaveAttribute('href', '/');
    expect(screen.getByText('朋友局 · 纯虚拟筹码 · 不涉及任何真实价值交换')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建房间' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '加入房间' })).toBeInTheDocument();
  });

  it('没有存档时自动生成一套身份，而不是甩一个空表单给玩家', () => {
    render(<App />);
    const nickname = screen.getByLabelText<HTMLInputElement>('昵称');
    expect(nickname.value.length).toBeGreaterThan(0);
    expect(screen.getByAltText('你的头像')).toHaveAttribute('src', expect.stringContaining('data:image/svg+xml'));
  });

  it('未知路由重定向回大厅（分享链接被人改坏一个字符也不该白屏）', () => {
    goTo('/不存在的路径');
    render(<App />);
    expect(screen.getByRole('button', { name: '创建房间' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/');
  });
});
