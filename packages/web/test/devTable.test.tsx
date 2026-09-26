/**
 * `/dev/table` 布局验收页（M2.2 的验收载体）。
 *
 * ## 这一页存在的理由，以及这里为什么只钉三件事
 *
 * `TASKS.md` M2.2 第一条验收是「2/3/4/5/6/7/8 人各截一张图，用户目视验收」——
 * 那是人眼判定的，机器替不了。但**给人看的东西本身也会坏**：路由写错、某一档人数漏了、
 * 手机那一栏忘了钉宽度，都会让人以为"看过了"其实看的是别的东西。所以这里只验
 * 这一页作为验收工具是否成立：命中路由、七档人数齐全、每档两个视口模型都是真桌面。
 *
 * 几何对不对不在这里管，那是 `tableLayout.test.ts` 的五十几条用例。
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { AppRoutes } from '../src/App';
import { DevTablePage } from '../src/dev/DevTablePage';

describe('/dev/table 布局验收页', () => {
  it('2 到 8 人各一行，一档不落', () => {
    render(<DevTablePage />);
    const rows = screen.getAllByRole('region', { name: /^\d+ 人桌$/ });
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual([
      '2 人桌',
      '3 人桌',
      '4 人桌',
      '5 人桌',
      '6 人桌',
      '7 人桌',
      '8 人桌',
    ]);
  });

  it('每一档摆两个视口模型，用的是产品里的真桌面', () => {
    render(<DevTablePage />);
    // 7 档 × 2 个视口。桌面图与公共牌区各 14 份，说明渲染的是 `TableStage` 本体
    expect(screen.getAllByRole('img', { name: '牌桌桌面' })).toHaveLength(14);
    expect(screen.getAllByRole('region', { name: '公共牌' })).toHaveLength(14);
    expect(screen.getAllByText('手机视口 390px · 竖屏几何')).toHaveLength(7);
    expect(screen.getAllByText('桌面视口 980px · 横屏几何')).toHaveLength(7);
  });

  it('路由 /dev/table 真的命中，不被 `*` 兜底送回大厅', async () => {
    render(
      <MemoryRouter initialEntries={['/dev/table']}>
        <AppRoutes />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { level: 1, name: '牌桌布局总览' });
    expect(screen.queryByRole('heading', { level: 2, name: '你的身份' })).toBeNull();
  });
});
