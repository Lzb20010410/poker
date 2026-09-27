/**
 * 动画的 DOM 契约（SPEC §3）：渲染层按名字要的每一个锚点，真页面上必须给得出来。
 *
 * ## 为什么单独立一份，而不是在 `animDraw.test.ts` 里顺手测
 *
 * 那一份用的是手写夹具，`data-anim="seat-0"`、`.card-view--s` 都是测试自己拼的字符串。
 * 于是它测的是「给这么一棵树，动画画不画得出来」，测不到的是**生产代码有没有长成这棵树**。
 * 最要命的那类改动是把 `SeatList` 里的 `hole-${seatIndex}` 改名成 `cards-${seatIndex}`：
 * 全部单测继续绿灯（它们读的是自己的夹具），真牌桌上每次发牌、每次亮牌却都静默降级成
 * 「不播，直接跳终态」——`sceneJob` 找不到落点就返回 false，而这条降级路没有断言守着。
 *
 * 所以这里挂真的 `TablePage`（Provider、假 client、路由一起上），再拿 `createAnimScene`
 * 的只读查询面去问它：键在不在、我那一格带不带 `data-self`、正面是不是只有我看得见。
 * 夹具里那些字符串在这里一次都不出现。
 *
 * ## 只查不改
 *
 * `find` / `faceOf` / `isSelf` 三条是纯查询：不写 `visibility`、不造幽灵。所以这里可以
 * 另起一个 scene 实例去问，与页面自己那一个互不干扰（遮罩计数按实例各记一份）。
 * 真要验「遮罩盖得住、幽灵飞得对」，那归 `animDraw.test.ts` 与 `/dev/replay`。
 *
 * ## 牌堆那一格为什么按几何推、不钉死
 *
 * `TableStage` 只在 `layout.deck !== null` 时画牌堆，而 jsdom 量不到盒子，
 * `useStageSize()` 恒回 `FALLBACK_STAGE`。所以「这一档有没有牌堆」是 `layoutTable()` 算出来的，
 * 这里把它当输入而不是常量（几何本身由 `tableLayout.test.ts` 守）。这条断言守的是
 * 「组件画的与几何给的是同一件事」，两边哪天对不上，这里就会红。
 */

import { act, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TABLE_CONFIG } from '@poker-room/shared';
import type { Card } from '@poker-room/shared/view';

import { createAnimScene, type AnimScene } from '../src/anim/scene';
import type { HandPlayerView } from '../src/net/types';
import { LobbyPage } from '../src/lobby/LobbyPage';
import { FALLBACK_STAGE, layoutTable } from '../src/table/layout';
import { TablePage } from '../src/table/TablePage';
import { createFakeClient, fakePlayer, type FakeRoomHandle } from './fakeClient';
import { renderWithProviders, resetWebState, seedProfile, TEST_PROFILE } from './harness';

const CODE = 'K7QM3D';
const CAPACITY = DEFAULT_TABLE_CONFIG.maxPlayers;

const me = fakePlayer('self', TEST_PROFILE.nickname, true, { seatIndex: 0, isHost: true });
const peer = fakePlayer('peer-2', '老王', false, { seatIndex: 1, chips: 1800 });

/** 快照里 `holeCards` 是个二元组：定向消息一次给两张，不存在"只到一张"的中间态 */
const MY_HOLE: readonly [Card, Card] = [
  { rank: 14, suit: 's' },
  { rank: 13, suit: 'h' },
];
/** 翻牌圈：只有前三格有牌，后两格是 `card-view--empty` */
const BOARD: readonly Card[] = [
  { rank: 2, suit: 'd' },
  { rank: 7, suit: 'c' },
  { rank: 12, suit: 'h' },
];

function handRow(playerId: string, seatIndex: number, nickname: string): HandPlayerView {
  return {
    playerId,
    seatIndex,
    nickname,
    avatarSeed: `seed-${playerId}`,
    folded: false,
    allIn: false,
    sittingOut: false,
    hasActed: true,
    committedThisStreet: 10,
    committedTotal: 20,
  };
}

interface Mounted {
  readonly page: HTMLElement;
  readonly scene: AnimScene;
}

/**
 * 挂整页，推到「翻牌圈、我和老王都在牌里、我拿到两张底牌」这一格，
 * 顺手交回一个只读的 scene 让测试去问它。
 *
 * `handPlayers` 不能省：`SeatList` 画不画别人那两枚牌背，读的是服务端这一手的冻结身份
 * （`holeCardsOf` 里 `hand === undefined → null`）。漏了它就等于测不到 `hole-<peer>` 这个键。
 */
async function mountTable(): Promise<Mounted> {
  seedProfile();
  const fake = createFakeClient();
  renderWithProviders(
    `/t/${CODE}`,
    <Routes>
      <Route path="/" element={<LobbyPage />} />
      <Route path="/t/:code" element={<TablePage />} />
    </Routes>,
    { client: fake.client },
  );
  await screen.findByRole('heading', { name: `牌桌 ${CODE}` });
  const room = fake.rooms.get(CODE);
  if (room === undefined) throw new Error(`假 client 里没有房间 ${CODE}`);
  patch(room, {
    players: [me, peer],
    handPlayers: [handRow('self', 0, TEST_PROFILE.nickname), handRow('peer-2', 1, '老王')],
    phase: 'FLOP',
    handId: 'h-1',
    handNo: 1,
    turnVersion: 4,
    mySeat: 0,
    dealerSeat: 0,
    sbSeat: 1,
    bbSeat: 0,
    currentTurn: 1,
    isMyTurn: false,
    currentBet: 20,
    potTotal: 210,
    holeCards: MY_HOLE,
    board: BOARD,
  });
  const page = document.querySelector<HTMLElement>('.table-page');
  if (page === null) throw new Error('快照推完了却没挂出 .table-page');
  const layer = page.querySelector<HTMLElement>('.anim-layer');
  if (layer === null) throw new Error('.table-page 里没有 .anim-layer');
  const scene = createAnimScene(layer);
  scenes.push(scene);
  return { page, scene };
}

/** 假 client 同步调订阅者，所以每次推进都要包进 `act` */
function patch(room: FakeRoomHandle, changes: Parameters<FakeRoomHandle['patch']>[0]): void {
  act(() => {
    room.patch(changes);
  });
}

/** 每个测试自己起的 scene，收尾统一 `destroy`：只读查询不该留下任何改动 */
let scenes: AnimScene[] = [];

beforeEach(() => {
  scenes = [];
  resetWebState();
});

afterEach(() => {
  for (const scene of scenes) scene.destroy();
  resetWebState();
});

describe('动画 DOM 契约 · 幽灵层', () => {
  it('整页只有一块幽灵层，而且是 .table-page 的最后一个孩子', async () => {
    const { page } = await mountTable();
    const layers = Array.from(page.querySelectorAll('.anim-layer'));
    expect(layers).toHaveLength(1);
    const layer = layers[0];
    if (layer === undefined) throw new Error('上面刚数过只有一块');
    // 「最后」不是审美：它决定幽灵画在座位之上，而 `createAnimScene` 的搜索根就是它的父级
    expect(page.lastElementChild).toBe(layer);
    expect(layer.parentElement).toBe(page);
    // React 一个子节点都不往里放，否则 reconcile 会把正在飞的幽灵连同引用一起摘掉
    expect(layer.childElementCount).toBe(0);
  });
});

describe('动画 DOM 契约 · 锚点键', () => {
  it('渲染层要的那些键，真页面全部给得出来', async () => {
    const { scene } = await mountTable();
    const keys = [
      'pot',
      ...Array.from({ length: 5 }, (_, index) => `board-${String(index)}`),
      // 空座位那一格也必须带键：轻敲圈、气泡要落在没人坐的位子上
      ...Array.from({ length: CAPACITY }, (_, index) => `seat-${String(index)}`),
      'hole-0',
      'hole-1',
    ];
    // 一次列出所有缺的键：少一个键就是一整类动画静默不播，一条条红反而看不全
    expect(keys.filter((key) => scene.find(key) === null)).toEqual([]);
  });

  it('没在牌里的格子就没有底牌键；牌堆的有无与几何一致', async () => {
    const { scene } = await mountTable();
    // 2~7 号位空着：座位格子在，底牌格子不该在（否则发牌会往空气里飞牌）
    expect(scene.find('seat-2')).not.toBeNull();
    expect(scene.find('hole-2')).toBeNull();
    const { deck } = layoutTable({ ...FALLBACK_STAGE, capacity: CAPACITY });
    expect(scene.find('deck') === null).toBe(deck === null);
  });

  /**
   * `felt` 这个键不是给动画「遮」用的，是**量**的：手机横屏满桌时牌堆被几何挤掉，
   * 发牌的起飞点得从桌面椭圆算出来（`kit.ts` 的 `deckCenter`）。挂错节点这条就废了——
   * 尺寸这里量不到（jsdom 恒为 `0×0`），所以钉的是「键落在桌面那张图上」这件事本身。
   */
  it('桌面自己有键，而且挂在桌面那张图上', async () => {
    const { scene } = await mountTable();
    const felt = scene.find('felt');
    expect(felt === null).toBe(false);
    expect(felt?.classList.contains('felt-stage__felt')).toBe(true);
  });

  it('我自己的底牌不在座位格里，只在 `.hole-strip` 那一格', async () => {
    const { scene } = await mountTable();
    // 两处都挂 `hole-0` 的话 `find` 只会命中文档里第一个，发牌动画就飞错地方
    const strips = Array.from(document.querySelectorAll('[data-anim="hole-0"]'));
    expect(strips).toHaveLength(1);
    expect(strips[0]?.classList.contains('hole-strip')).toBe(true);
    // `data-self` 是「只翻我自己那两张」的唯一判据（SPEC §3.2）
    expect(scene.isSelf('hole-0')).toBe(true);
    expect(scene.isSelf('hole-1')).toBe(false);
  });
});

describe('动画 DOM 契约 · 牌面可见性', () => {
  it('正面只读得出来自我的底牌和公共牌，别人的那一格是牌背', async () => {
    const { scene } = await mountTable();
    expect(scene.faceOf('hole-0', 0)).not.toBeNull();
    expect(scene.faceOf('hole-0', 1)).not.toBeNull();
    // 铁律在 DOM 上的投影：别人那两枚只可能是 `card-view--back`，读不出正面才是对的
    expect(scene.faceOf('hole-1', 0)).toBeNull();
    expect(scene.faceOf('hole-1', 1)).toBeNull();
  });

  it('公共牌已发到的格子是正面，没发到的格子还在但不是正面', async () => {
    const { scene } = await mountTable();
    for (const index of [0, 1, 2]) {
      expect(scene.faceOf(`board-${String(index)}`, 0)).not.toBeNull();
    }
    // 空槽位必须存在（`TableStage` 固定五格），但它不是正面：`--empty` 与 `--back`
    // 都不该被 `faceOf` 当成能翻的东西，否则发牌动画会翻出一张"空气牌"
    expect(scene.find('board-3')).not.toBeNull();
    expect(scene.faceOf('board-3', 0)).toBeNull();
    expect(scene.faceOf('board-4', 0)).toBeNull();
  });
});
