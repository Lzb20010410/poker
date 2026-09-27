/**
 * 座位内容（M2.3）。
 *
 * ## 为什么这里直接渲染 `TableStage`，不套整页
 *
 * M2.3 改的是「一格座位里有什么」，跟连接、路由、上下文都没关系。
 * 套整页就要引入假 client，一旦失败分不清是座位写错了还是快照没推进。
 * 快照直接用 `fakeSnapshot` 拼；桌面量不到尺寸时 `TableStage` 走 `FALLBACK_STAGE`，
 * 坐标由 `layout.ts` 定，这一份只管**内容**。
 *
 * ## 紧凑档那一组为什么直接渲染 `SeatList`
 *
 * 走不走紧凑版式是 `layout.ts` 按量到的桌面尺寸定的，而 jsdom 没有排版引擎，
 * `useStageSize` 永远回 `FALLBACK_STAGE`（全尺寸档）。所以要测「手机上那一档」，
 * 只能把几何自己算出来（358×286 / 8 人 → 每格 104×44 紧凑）当 prop 递给 `SeatList`。
 * 这恰好也是 D-029 之后组件的真实数据流：几何一处算，组件只管往里填内容。
 *
 * ## 两条不自己判定的界线
 *
 * - 底牌：别人的牌面**不在快照里**（隐私铁律），所以这一格里只可能出现牌背，
 *   正面只可能来自 `reveals`（服务端摊牌时定向广播过的）。
 * - 「这人还在牌里」读的是服务端的 `folded / sittingOut`，前端不推。
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { Card } from '@poker-room/shared/view';

import type { HandPlayerView, RoomSnapshot } from '../src/net/types';
import { layoutTable, type TableLayout } from '../src/table/layout';
import { SeatList } from '../src/table/components/SeatList';
import { TableStage } from '../src/table/components/TableStage';
import { fakePlayer, fakeSnapshot } from './fakeClient';

const aceOfSpades: Card = { rank: 14, suit: 's' };
const kingOfHearts: Card = { rank: 13, suit: 'h' };

/** 昵称 12 个字码，屏幕上只剩前 8 个 + 省略号（SPEC §4.3） */
const TRUNCATED = '一个很长很长要省…';
const LONG_NAME = '一个很长很长要省略的昵称';

/** 4 人桌：我在 0 号（庄家）在行动，p2 长昵称 + 七位数筹码，p3 既是 BB 又全下，p4 已弃牌 */
function snapshotWith(overrides: Partial<RoomSnapshot> = {}): RoomSnapshot {
  const me = fakePlayer('self', '我', true, { seatIndex: 0, chips: 1000, isHost: true });
  const longName = fakePlayer('p2', LONG_NAME, false, { seatIndex: 1, chips: 1234567 });
  const allInBB = fakePlayer('p3', '小美', false, { seatIndex: 2, chips: 90 });
  const folded = fakePlayer('p4', '阿明', false, { seatIndex: 3, chips: 4000 });
  return fakeSnapshot('K7QM3D', {
    players: [me, longName, allInBB, folded],
    handPlayers: [
      hand('self', 0, '我'),
      hand('p2', 1, LONG_NAME, { hasActed: true, committedThisStreet: 10, committedTotal: 10 }),
      hand('p3', 2, '小美', { hasActed: true, allIn: true, committedThisStreet: 20, committedTotal: 20 }),
      hand('p4', 3, '阿明', { hasActed: true, folded: true, committedThisStreet: 0, committedTotal: 0 }),
    ],
    phase: 'PREFLOP',
    mySeat: 0,
    dealerSeat: 0,
    sbSeat: 1,
    bbSeat: 2,
    currentTurn: 0,
    isMyTurn: true,
    currentBet: 20,
    potTotal: 30,
    board: [
      { rank: 7, suit: 'c' },
      { rank: 12, suit: 'h' },
      aceOfSpades,
    ],
    ...overrides,
  });
}

function hand(
  playerId: string,
  seatIndex: number,
  nickname: string,
  extras: Partial<HandPlayerView> = {},
): HandPlayerView {
  return {
    playerId,
    seatIndex,
    nickname,
    avatarSeed: `seed-${playerId}`,
    folded: false,
    allIn: false,
    sittingOut: false,
    hasActed: false,
    committedThisStreet: 0,
    committedTotal: 0,
    ...extras,
  };
}

function stage(snapshot: RoomSnapshot) {
  return (
    <TableStage
      snapshot={snapshot}
      disabled={false}
      seatEmotes={[]}
      onSit={() => {}}
      onStand={() => {}}
      onRebuy={() => {}}
    />
  );
}

/** 某个名字的座位格子。断言一律限定在这一格，免得「别处也有」蒙过去 */
function seatOf(nickname: string): HTMLElement {
  const name = screen.getByText(nickname);
  const row = name.closest('li');
  if (row === null) throw new Error(`${nickname} 不在任何座位格子里`);
  return row;
}

/** 某一格里筹码那一段的文字 */
function chipsText(nickname: string): string {
  const chips = seatOf(nickname).querySelector('.seat__chips');
  if (chips === null) throw new Error(`${nickname} 这一格没有筹码行`);
  return chips.textContent ?? '';
}

/** 某一格里露出的牌名（头像也是 img，所以只认 `.seat__hole` 里的那两张） */
function cardNamesIn(nickname: string): string[] {
  return Array.from(seatOf(nickname).querySelectorAll('.seat__hole img')).map(
    (img) => img.getAttribute('alt') ?? '',
  );
}

describe('座位 · 昵称与筹码', () => {
  it('昵称超过 8 字省略，完整名字留在 title 里（窄框再靠 CSS 收一道）', () => {
    render(stage(snapshotWith()));
    const name = screen.getByText(TRUNCATED);
    expect(name.getAttribute('title')).toBe(LONG_NAME);
    expect(screen.queryByText(LONG_NAME)).toBeNull();
  });

  it('8 字以内的昵称原样显示', () => {
    render(stage(snapshotWith()));
    expect(screen.getByText('小美')).toBeInTheDocument();
  });

  it('筹码千分位：七位数带逗号，整千也带逗号', () => {
    render(stage(snapshotWith()));
    expect(chipsText(TRUNCATED)).toBe('1,234,567');
    /*
     * 我那一格没有筹码行了（D-038）：同一数额在屏幕上出现两次，而窄屏那一格还把它裁掉。
     * 那一份数字搬到底牌区，页面级的断言在 `table.test.tsx`「我的筹码叠在底牌区」。
     */
    expect(seatOf('我').querySelector('.seat__chips')).toBeNull();
  });

  it('筹码数变化是一格一格滚过去的，而且每一帧都是合法千分位', async () => {
    const first = snapshotWith();
    const { rerender } = render(stage(first));
    // 挂别人那一格：我那一份现在在底牌区（D-038），而这一条测的是 `ChipCount` 本身
    const node = screen.getByText('1,234,567');
    const frames: string[] = [];
    const observer = new MutationObserver(() => {
      frames.push(node.textContent ?? '');
    });
    observer.observe(node, { childList: true, characterData: true, subtree: true });

    rerender(
      stage({ ...first, players: first.players.map((p) => (p.isSelf ? p : { ...p, chips: 1229567 })) }),
    );

    await waitFor(() => expect(node.textContent).toBe('1,229,567'), { timeout: 3000 });
    observer.disconnect();
    // 滚动的证据 = 中间确实停在过别的数。只断言「最后等于 1,229,567」的话，瞬变也能过
    expect(frames.some((frame) => frame !== '1,234,567' && frame !== '1,229,567')).toBe(true);
    for (const frame of frames) expect(frame).toMatch(/^\d{1,3}(,\d{3})*$/);
  });
});

describe('座位 · 状态角标', () => {
  it('角标用 D / SB / BB / ALL-IN，同一个人身上可以叠着显示', () => {
    render(stage(snapshotWith()));
    expect(seatOf('我').querySelector('.seat__flags')?.textContent).toContain('D');
    expect(seatOf(TRUNCATED).querySelector('.seat__flags')?.textContent).toContain('SB');
    const both = seatOf('小美').querySelector('.seat__flags');
    expect(both?.textContent).toContain('BB');
    expect(both?.textContent).toContain('ALL-IN');
  });

  it('弃牌玩家整格变暗（类名在，样式由 CSS 给），但格子还占着位', () => {
    render(stage(snapshotWith()));
    const row = seatOf('阿明');
    expect(row.className).toContain('seat--folded');
    expect(row).toHaveTextContent('已弃牌');
    // 仍在几何里：内联宽高由 layout 给，弃牌不把他摘出这一圈
    expect(row.getAttribute('style')).toContain('width');
  });

  it('轮到谁由 acting 类名标出来（M3 的呼吸光圈与倒计时环认这个类名）', () => {
    render(stage(snapshotWith()));
    expect(seatOf('我').className).toContain('seat--acting');
    expect(seatOf('小美').className).not.toContain('seat--acting');
  });
});

describe('座位 · 底牌与牌面资产', () => {
  it('别人格子里是两张牌背，一张正面都不露', () => {
    render(stage(snapshotWith()));
    const backs = within(seatOf('小美')).getAllByRole('img', { name: '扣着的牌' });
    expect(backs).toHaveLength(2);
    for (const back of backs) expect(back.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    expect(cardNamesIn('小美')).not.toContain('A♠');
  });

  it('我这格里不放底牌：我的两张是屏幕底部那条大牌（SPEC §4.2 竖屏 22%）', () => {
    render(stage(snapshotWith()));
    expect(seatOf('我').querySelectorAll('.seat__hole')).toHaveLength(0);
  });

  it('弃牌的人牌已经没了，格子里不留牌背', () => {
    render(stage(snapshotWith()));
    expect(within(seatOf('阿明')).queryAllByRole('img', { name: '扣着的牌' })).toHaveLength(0);
  });

  it('摊牌亮出来的牌是正面，读的是服务端给的 reveals', () => {
    render(stage(snapshotWith({ reveals: [{ playerId: 'p2', seatIndex: 1, cards: [aceOfSpades, kingOfHearts] }] })));
    expect(cardNamesIn(TRUNCATED)).toEqual(['A♠', 'K♥']);
  });

  it('公共牌五格里，发到的三张是 SVG 牌面', () => {
    render(stage(snapshotWith()));
    const board = screen.getByRole('region', { name: '公共牌' });
    const faces = within(board).getAllByRole('img');
    expect(faces).toHaveLength(3);
    for (const face of faces) expect(face.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    expect(within(board).getAllByLabelText('还没发到这一张')).toHaveLength(2);
  });
});

describe('牌桌上所有金额同一个口径', () => {
  it('底池与「已投」都带千分位：1234567 与 1,234,567 是两种读法', () => {
    render(
      stage(
        snapshotWith({
          potTotal: 1234567,
          handPlayers: [
            hand('self', 0, '我', { committedThisStreet: 12345, committedTotal: 12345 }),
            hand('p2', 1, LONG_NAME),
            hand('p3', 2, '小美'),
            hand('p4', 3, '阿明'),
          ],
        }),
      ),
    );
    expect(screen.getByText('底池').nextElementSibling?.textContent).toBe('1,234,567');
    expect(seatOf('我').querySelector('.seat__flags')?.textContent).toContain('已投 12,345');
  });
});

/**
 * 紧凑档（手机上满桌那一档，D-029 的第 2 条）。
 *
 * 这一组的根据是「104×44 的框里到底排不排得下」：全尺寸档那一套（头像 + 昵称 + 筹码 +
 * 两枚 20px 牌背 + 一整条徽标）在这个尺寸里必然被 `overflow: hidden` 裁掉，而他报回来的
 * 正是「筹码、手牌看不全」。所以这一档不是"缩小一点"，是**换一套内容**：
 * 牌背换成微型两枚仍然要画，徽标只留「这一格里没有第二处可看」的那两类。
 */
const COMPACT_LAYOUT = layoutTable({ width: 358, height: 286, capacity: 6 });

function seatListView(snapshot: RoomSnapshot, layout: TableLayout) {
  return (
    <SeatList
      snapshot={snapshot}
      layout={layout}
      seatEmotes={[]}
      disabled={false}
      onSit={() => {}}
      onStand={() => {}}
      onRebuy={() => {}}
    />
  );
}

/** 某一格里排出来的角标（按 DOM 顺序），用来精确检查"紧凑档到底留了哪几枚" */
function badgeTexts(nickname: string): string[] {
  return Array.from(seatOf(nickname).querySelectorAll('.badge')).map((el) => el.textContent ?? '');
}

describe('座位 · 紧凑档（手机满桌，D-029）', () => {
  it('这一档的几何确实是紧凑版式（否则下面全部白测）', () => {
    expect(COMPACT_LAYOUT.seats.every((seat) => seat.compact)).toBe(true);
    expect(COMPACT_LAYOUT.seats[0]?.w).toBeCloseTo(104, 0);
    expect(COMPACT_LAYOUT.seats[0]?.h).toBeCloseTo(44, 0);
  });

  it('别人那格里还是两张牌背——手牌信息不在小格子里省掉', () => {
    render(seatListView(snapshotWith(), COMPACT_LAYOUT));
    const backs = within(seatOf('小美')).getAllByRole('img', { name: '扣着的牌' });
    expect(backs).toHaveLength(2);
  });

  it('摊牌亮出来的正面在紧凑档同样是正面', () => {
    render(
      seatListView(
        snapshotWith({
          reveals: [{ playerId: 'p3', seatIndex: 2, cards: [aceOfSpades, kingOfHearts] }],
        }),
        COMPACT_LAYOUT,
      ),
    );
    expect(cardNamesIn('小美')).toEqual(['A♠', 'K♥']);
  });

  it('徽标只留位置与状态：行动中 / 已投 / 房主 / 你 在紧凑档不排', () => {
    render(seatListView(snapshotWith(), COMPACT_LAYOUT));
    // 「我」这格身上同时是庄家 + 行动中 + 房主 + 你 + 已投，紧凑档只认庄家的 D
    expect(badgeTexts('我')).toEqual(['D']);
    expect(seatOf('我').className).toContain('seat--acting');
    expect(seatOf(TRUNCATED).querySelector('.seat__hole')).not.toBeNull();
  });

  it('位置与状态并存时两枚都留（BB 与 ALL-IN 叠在同一人身上）', () => {
    render(seatListView(snapshotWith(), COMPACT_LAYOUT));
    expect(badgeTexts('小美')).toEqual(['BB', 'ALL-IN']);
  });

  it('弃牌在紧凑档缩成单字「弃」，全称留给 title 与读屏', () => {
    render(seatListView(snapshotWith(), COMPACT_LAYOUT));
    const badge = seatOf('阿明').querySelector('.badge');
    expect(badge?.textContent).toBe('弃');
    expect(badge?.getAttribute('title')).toBe('已弃牌');
  });

  it('旁观那格不留底牌、只留「旁观」', () => {
    const snapshot = snapshotWith();
    render(
      seatListView(
        {
          ...snapshot,
          handPlayers: snapshot.handPlayers.map((row) =>
            row.playerId === 'p2' ? { ...row, sittingOut: true } : row,
          ),
        },
        COMPACT_LAYOUT,
      ),
    );
    expect(badgeTexts(TRUNCATED)).toEqual(['SB', '旁观']);
    expect(within(seatOf(TRUNCATED)).queryAllByRole('img', { name: '扣着的牌' })).toHaveLength(0);
  });

  it('断线的徽标不留单字：它是这一格里唯一说"为什么还没轮到"的东西', () => {
    const snapshot = snapshotWith();
    render(
      seatListView(
        {
          ...snapshot,
          players: snapshot.players.map((p) => (p.id === 'p4' ? { ...p, presence: 'reconnecting' as const } : p)),
        },
        COMPACT_LAYOUT,
      ),
    );
    expect(badgeTexts('阿明')).toEqual(['弃', '断线']);
  });

  it('空座位在紧凑档照样能入座，标签仍然是「入座 N 号座位」', () => {
    render(seatListView(snapshotWith({ mySeat: null }), COMPACT_LAYOUT));
    expect(screen.getByRole('button', { name: '入座 5 号座位' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '入座 6 号座位' })).toBeInTheDocument();
  });

  it('紧凑档的空格子里「入座」与「空座位」只留一句：两句话就把筹码那行顶出框', () => {
    render(seatListView(snapshotWith({ mySeat: null }), COMPACT_LAYOUT));
    expect(screen.queryAllByText('空座位')).toHaveLength(0);
  });

  it('坐下之后空格子只剩「空座位」——按钮没了，那句话就得回来', () => {
    render(seatListView(snapshotWith(), COMPACT_LAYOUT));
    expect(screen.queryAllByText('空座位').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /^入座/ })).toBeNull();
  });
});
