/**
 * `/dev/table` —— M2.2 布局 + M2.3 座位内容 + M2.4 操作面板的**目视验收页**：
 * 把同一套桌面几何摆在 2~8 人、桌面与手机两种宽度下逐个平铺出来给人看，
 * 末尾再摆一份「四种局面 × 两种宽度」的操作面板。
 *
 * ## 为什么用真组件而不是画一张示意图
 *
 * 示意图会骗人：画图和线上代码是两套东西，图上好看不代表屏幕上不重叠。
 * 这一页摆的就是产品里那几个组件本体（`TableStage` / `SeatList` / `ActionPanel`），
 * 用的是同一份 `layout.ts`、同一份 `global.css`、同一张桌布 data URI。
 * 唯一的差别是这里喂的是假快照（不连服务端），以及两个框的宽度是钉出来的视口
 * （见 `global.css` 里 `.dev-table__frame--phone` 那段）。
 *
 * ## 机器已经验过的，这里不再重复
 *
 * 「无重叠、无溢出、自己在正下方、顺时针、椭圆 2:1 / 1.3:1」是
 * `test/tableLayout.test.ts` 那五十几条在管的事，跑一次就够；
 * 昵称省略、千分位、筹码滚动、弃牌压暗、牌背与亮牌是 `test/seatContent.test.tsx` 在管的事；
 * 滑杆范围、快捷额度、键盘、非法额度是 `test/actionPanel.test.tsx` 在管的事。
 * 这一页只回答机器答不了的问题：**位置关系顺不顺眼、密度受不受得了、徽章挤不挤得下、
 * 三颗按钮的颜色分不分得清**。
 *
 * ## 一行看不全，七行加起来看全
 *
 * `previewRoles` 把状态分成两类：「弃牌 / 旁观」会改整格的样子，必须独占一个座位；
 * 「断线 / 长昵称 / 七位筹码」只是叠在座位上的文字，座位不够就挂在别人身上。
 * 所以人越少的一行越是几件事挤在同一格（单挑那一行大盲同时是断线的人），
 * 8 人桌则每个状态各占一格。逐行核对不必求全，扫一眼 8 人桌即可。
 *
 * ## 抽屉在这里看不出效果（最后一节唯一的坑）
 *
 * 竖屏抽屉收起与否由**真实视口**决定（`useIsPortrait` 走 `matchMedia`），
 * 不由这个 390px 的框决定。所以在桌面上看右边那一栏，额度那一排会跟左边一样摊着。
 * 要看抽屉：把浏览器窗口整个拖窄到 768px 以下，或者直接在手机上打开这一页。
 */

import { FELT_VALUES, RANKS, SUITS, type Card, type FeltColor } from '@poker-room/shared/view';
import type { ReactNode } from 'react';

import { PRESET_AVATAR_SEEDS } from '../avatar';
import type { ConnectedPlayer, HandPlayerView, LegalActionsView, RoomSnapshot } from '../net/types';
import { ActionPanel } from '../table/components/ActionPanel';
import { TableStage } from '../table/components/TableStage';
import type { SeatEmote } from '../table/useSeatEmotes';

/** 这一页不接受操作，座位上的按钮点了也不该有反应 */
const noop = (): void => {
  /* 验收页无状态可改 */
};

/**
 * 表情气泡要真事件才有得看，这一页没有连接，所以给它一份空的。
 * 想亲眼验气泡去 `/dev/replay`（它会发 `player:emoji`）。
 */
const NO_EMOTES: readonly SeatEmote[] = [];

/** 验收要跑的人数档：`TASKS.md` M2.2 点名 2/3/4/5/6/7/8 */
const CAPACITIES = [2, 3, 4, 5, 6, 7, 8] as const;

/** 公共牌给四张：第五格是空槽，正好一起看空位长什么样 */
const PREVIEW_BOARD: readonly Card[] = [
  { rank: RANKS[12] ?? 14, suit: SUITS[0] ?? 's' },
  { rank: RANKS[3] ?? 5, suit: SUITS[1] ?? 'h' },
  { rank: RANKS[6] ?? 8, suit: SUITS[2] ?? 'd' },
  { rank: RANKS[1] ?? 2, suit: SUITS[3] ?? 'c' },
];

/** 我自己摊在桌上的两张 */
const PREVIEW_HOLES: readonly [Card, Card] = [
  { rank: 14, suit: 's' },
  { rank: 13, suit: 'h' },
];

/** 亮牌的那一位：一对 7，正面对着别人手里的牌背 */
const PREVIEW_REVEAL: readonly [Card, Card] = [
  { rank: 7, suit: 'c' },
  { rank: 7, suit: 'h' },
];

/** 12 个码点，超过 `displayNickname` 的 8 个，用来看省略号与 title 里的全名 */
const LONG_NICKNAME = '一个很长很长要省略的昵称';

const NO_LEGAL = {
  canFold: false,
  canCheck: false,
  callAmount: 0,
  canRaise: false,
  minRaiseTotal: 0,
  maxRaiseTotal: 0,
  canAllIn: false,
};

/**
 * 一桌人各自担当的角色，`null` 表示这一档人数摆不下这个状态。
 *
 * 座位号是服务端口径（0 号位 = 我自己 = 屏幕正下方），不是槽位号。
 */
interface PreviewRoles {
  readonly dealer: number;
  readonly sb: number;
  /** 这一位同时是全下（短码推光），所以「BB」「ALL-IN」两枚徽章要并排显示 */
  readonly bb: number;
  /** 轮到的那一位，坐在我的对面，正好看光圈落在缩小档的座位上 */
  readonly actor: number;
  readonly folded: number | null;
  readonly spectator: number | null;
  readonly dropped: number;
  readonly longName: number;
  readonly bigStack: number;
}

function previewRoles(capacity: number): PreviewRoles {
  const dealer = 0;
  // 单挑时庄家就是小盲，顺时针数第二格才是大盲；三人以上才是庄家往后两位
  const sb = capacity === 2 ? 0 : 1;
  const bb = capacity === 2 ? 1 : 2;
  const actor = (bb + 1) % capacity;
  const spare = [3, 4, 5, 6, 7].filter((seat) => seat < capacity && seat !== actor);
  return {
    dealer,
    sb,
    bb,
    actor,
    folded: spare[0] ?? null,
    spectator: spare[1] ?? null,
    // 没有空位时挂到盲注身上；单挑时 0 号位就是庄家，于是挂到大盲（那位全下且断线）
    dropped: spare[2] ?? (sb === 0 ? bb : sb),
    longName: spare[3] ?? actor,
    bigStack: actor,
  };
}

/** 七位数验千分位，0 验空栈，其余是一串位数各不相同的普通筹码 */
const MEDIUM_STACKS = [1000, 890, 230, 4500, 77, 12345, 3200, 640];

function chipsAt(seat: number, roles: PreviewRoles): number {
  // 全下的人桌上不会再剩筹码，旁观的那位是上一手打光了才下来的
  if (seat === roles.bb || seat === roles.spectator) return 0;
  if (seat === roles.bigStack) return 1234567;
  return MEDIUM_STACKS[seat % MEDIUM_STACKS.length] ?? 1000;
}

function nicknameAt(seat: number, roles: PreviewRoles): string {
  if (seat === roles.longName) return LONG_NICKNAME;
  if (seat === 0) return '我自己';
  return `玩家${seat + 1}`;
}

function committedAt(seat: number, roles: PreviewRoles): number {
  if (seat === roles.actor) return 120;
  if (seat === roles.folded || seat === roles.bb) return 20;
  if (seat === roles.sb) return 10;
  return 0;
}

function previewPlayer(seat: number, roles: PreviewRoles): ConnectedPlayer {
  return {
    id: `p-${seat}`,
    nickname: nicknameAt(seat, roles),
    avatarSeed: PRESET_AVATAR_SEEDS[seat % PRESET_AVATAR_SEEDS.length] ?? `seed-${seat}`,
    isSelf: seat === 0,
    seatIndex: seat,
    chips: chipsAt(seat, roles),
    presence: seat === roles.dropped ? 'reconnecting' : 'online',
    isHost: seat === 0,
    legal: NO_LEGAL,
  };
}

function previewHandPlayer(seat: number, roles: PreviewRoles): HandPlayerView {
  const committed = committedAt(seat, roles);
  return {
    playerId: `p-${seat}`,
    seatIndex: seat,
    nickname: nicknameAt(seat, roles),
    avatarSeed: PRESET_AVATAR_SEEDS[seat % PRESET_AVATAR_SEEDS.length] ?? `seed-${seat}`,
    folded: seat === roles.folded,
    allIn: seat === roles.bb,
    sittingOut: seat === roles.spectator,
    hasActed: seat !== roles.actor && seat !== roles.spectator,
    committedThisStreet: committed,
    committedTotal: committed + 60,
  };
}

/**
 * `?felt=blue` 把整页换成蓝呢，用来目视验收「房主选了另一张桌布之后整套界面还协调吗」。
 * `/dev/assets` 摆的是两张桌面本体，看的是色值；这一页摆的是真组件 + 真样式，
 * 看的是座位徽标、筹码金字、弃牌压暗在这些底色上够不够对比。
 *
 * 名单外的值（打错的链接、旧书签）回落到默认档，方向和产品里的 `net/view.ts` 一致：
 * 这一页存在的意义是给人看桌子，不是报错。
 */
function devFelt(): FeltColor {
  const raw = new URLSearchParams(window.location.search).get('felt');
  return raw !== null && (FELT_VALUES as readonly string[]).includes(raw) ? (raw as FeltColor) : FELT_VALUES[0];
}

function previewSnapshot(capacity: number, felt: FeltColor): RoomSnapshot {
  const roles = previewRoles(capacity);
  const seats = Array.from({ length: capacity }, (_, index) => index);
  return {
    code: 'DEV420',
    players: seats.map((seat) => previewPlayer(seat, roles)),
    handPlayers: seats.map((seat) => previewHandPlayer(seat, roles)),
    pots: [{ amount: 1234, eligible: [0, 1, 2] }],
    results: [],
    board: PREVIEW_BOARD,
    awards: [],
    reveals: [{ playerId: `p-${roles.bb}`, seatIndex: roles.bb, cards: PREVIEW_REVEAL }],
    holeCards: PREVIEW_HOLES,
    timeoutWarning: null,
    actionPending: false,
    phase: 'TURN',
    handId: 'dev-hand-7',
    handNo: 7,
    turnVersion: 3,
    hostId: 'p-0',
    myId: 'p-0',
    mySeat: 0,
    isHost: true,
    isMyTurn: false,
    dealerSeat: roles.dealer,
    sbSeat: roles.sb,
    bbSeat: roles.bb,
    currentTurn: roles.actor,
    deadline: null,
    nextHandAt: null,
    currentBet: PANEL_TABLE.currentBet,
    lastRaiseSize: 20,
    runOutBoard: false,
    potTotal: PANEL_TABLE.potTotal,
    introducedChips: 8000,
    retainedChips: 8000,
    config: {
      smallBlind: 10,
      bigBlind: PANEL_TABLE.bigBlind,
      startingChips: 1000,
      maxPlayers: capacity,
      actionTimeoutSec: 30,
      minPlayersToStart: 2,
      felt,
    },
    clockOffsetMs: 0,
  };
}

/* ---------- M2.4 操作面板 ---------- */

/**
 * 面板那四个局面共用的桌面数字：下注额 120、底池 1234、大盲 20。
 *
 * 这四个局面要判的是「同一排控件在四种服务端提示位下各长成什么样」，
 * 所以 `legal` 里的范围数字照引擎公式摆（`min = currentBet + lastRaiseSize`、
 * `max = chips + committedThisStreet`），而不是随手写三个好看的数——
 * 不然眼睛记住了「滑杆到 1820」，线上却是别的值。
 */
const PANEL_TABLE = { currentBet: 120, lastRaiseSize: 20, potTotal: 1234, bigBlind: 20 };

interface PanelScenario {
  readonly label: string;
  readonly legal: LegalActionsView;
  readonly canAct: boolean;
}

const PANEL_SCENARIOS: readonly PanelScenario[] = [
  {
    label: '有注要跟：中间那颗写「跟注 N」，第三颗写它要送的总额',
    legal: {
      canFold: true,
      canCheck: false,
      callAmount: PANEL_TABLE.currentBet - 20,
      canRaise: true,
      minRaiseTotal: PANEL_TABLE.currentBet + PANEL_TABLE.lastRaiseSize,
      maxRaiseTotal: 1700 + 20,
      canAllIn: true,
    },
    canAct: true,
  },
  {
    label: '不用跟（前面的人都过牌）：同一颗换成「过牌」',
    legal: {
      canFold: true,
      canCheck: true,
      callAmount: 0,
      canRaise: true,
      minRaiseTotal: PANEL_TABLE.currentBet + PANEL_TABLE.lastRaiseSize,
      maxRaiseTotal: 1700 + 20,
      canAllIn: true,
    },
    canAct: true,
  },
  {
    label: '短码加不动：第三颗整颗变「全下」，滑杆与快捷额度整排撤掉',
    legal: {
      canFold: true,
      canCheck: false,
      callAmount: PANEL_TABLE.currentBet - 20,
      canRaise: false,
      // 上限低于最低加注额，引擎此刻就是不给加（`canRaise` 的判据）
      minRaiseTotal: PANEL_TABLE.currentBet + PANEL_TABLE.lastRaiseSize,
      maxRaiseTotal: 60,
      canAllIn: true,
    },
    canAct: true,
  },
  {
    label: '没轮到我 / 断线 / 上一步还悬着：三颗全灰，键盘也不响应',
    legal: {
      canFold: true,
      canCheck: false,
      callAmount: PANEL_TABLE.currentBet - 20,
      canRaise: true,
      minRaiseTotal: PANEL_TABLE.currentBet + PANEL_TABLE.lastRaiseSize,
      maxRaiseTotal: 1700 + 20,
      canAllIn: true,
    },
    canAct: false,
  },
];

function PanelFrame({ scenario }: { scenario: PanelScenario }): ReactNode {
  return (
    <ActionPanel
      legal={scenario.legal}
      handId="dev-hand-7"
      turnVersion={3}
      canAct={scenario.canAct}
      potTotal={PANEL_TABLE.potTotal}
      currentBet={PANEL_TABLE.currentBet}
      bigBlind={PANEL_TABLE.bigBlind}
      onAction={noop}
    />
  );
}

export function DevTablePage(): ReactNode {
  const felt = devFelt();
  return (
    <div className="dev-table">
      <h1 className="dev-assets__title">牌桌布局总览</h1>
      <p className="dev-assets__hint">
        M2.2、M2.3 与 M2.4 的目视验收页。同一套几何（<code>src/table/layout.ts</code>）在 2~8 人下各摆一遍，
        每行两个框分别是桌面视口 980px（牌桌满栏 948px）与手机视口 390px（内容宽 358px，
        走竖屏几何），用的是产品里的真组件、真样式、真桌布。
        每行都摆着同一批边界状态：长昵称（省略号）、七位筹码（千分位）、零筹码、
        大盲并且全下、已弃牌（压暗但仍占一格）、旁观、断线、轮到的人、牌背与亮牌。
        人少的行会把几件事挤在同一格，8 人桌才是一格一件。
        最后一节是操作面板的四种局面 × 两种宽度。
        换桌布看 URL 参数：<code>?felt=blue</code> 整页改蓝呢（默认绿呢），
        选桌布的操作本身在产品里——房主面板的「桌布」那一栏，只在等待阶段能改。
        无重叠 / 无溢出 / 自己在正下方 / 顺时针 / 椭圆 2:1 与 1.3:1 这些由
        <code>test/tableLayout.test.ts</code> 机器验算；这一页只看位置关系与密度顺不顺眼。
      </p>

      {CAPACITIES.map((capacity) => (
        <section className="dev-table__row" key={capacity} aria-label={`${capacity} 人桌`}>
          <h2 className="asset-section__title">{capacity} 人桌</h2>
          <div className="dev-table__frames">
            <div className="dev-table__frame dev-table__frame--desktop">
              <p className="dev-table__caption">桌面视口 980px · 横屏几何</p>
              <TableStage
                snapshot={previewSnapshot(capacity, felt)}
                disabled={false}
                seatEmotes={NO_EMOTES}
                onSit={noop}
                onStand={noop}
                onRebuy={noop}
              />
            </div>
            <div className="dev-table__frame dev-table__frame--phone">
              <p className="dev-table__caption">手机视口 390px · 竖屏几何</p>
              <TableStage
                snapshot={previewSnapshot(capacity, felt)}
                disabled={false}
                seatEmotes={NO_EMOTES}
                onSit={noop}
                onStand={noop}
                onRebuy={noop}
              />
            </div>
          </div>
        </section>
      ))}

      <section className="dev-table__row" aria-label="操作面板四种局面">
        <h2 className="asset-section__title">操作面板 · 四种局面</h2>
        <p className="dev-assets__hint">
          右边那一栏的宽度是钉出来的 390px，但抽屉收起与否看的是真实视口
          （<code>matchMedia</code>）。在桌面上看，两栏的额度那一排都是摊开的；
          要看竖屏抽屉，把浏览器窗口整个拖窄到 768px 以下，或在手机上打开这一页。
          键盘（F / C / R / ↑↓ / Enter）在这页按了不会有反应——这里每一颗按钮的回调都是空的，
          键盘那部分由 <code>test/actionPanel.test.tsx</code> 验。
        </p>
        <div className="dev-table__panels">
          {PANEL_SCENARIOS.map((scenario) => (
            <div className="dev-table__panel-pair" key={scenario.label}>
              <h3 className="dev-table__caption dev-table__caption--wide">{scenario.label}</h3>
              <div className="dev-table__frames">
                <div className="dev-table__frame dev-table__frame--desktop">
                  <p className="dev-table__caption">桌面视口 980px</p>
                  <PanelFrame scenario={scenario} />
                </div>
                <div className="dev-table__frame dev-table__frame--phone">
                  <p className="dev-table__caption">手机视口 390px</p>
                  <PanelFrame scenario={scenario} />
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
