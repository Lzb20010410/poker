/**
 * 牌桌几何（M2.2）：把「几个人、多大的视口」算成一套绝对定位坐标。
 *
 * ## 纯函数，且是这套坐标唯一的来源
 *
 * 组件定位、M3 动画的目标点、给你看布局的那份静态快照页都从这里取。
 * 一旦允许组件自己微调偏移，"无重叠"就只能靠截图证明了 —— 而它可以算。
 *
 * ## 两个必须同时成立、又会互相打架的要求
 *
 * SPEC §4.2 既要「座位沿椭圆参数方程分布」，又要「无重叠、无溢出」，还要座位尽量大。
 * 竖屏 390px 宽、8 人满桌时这三个要求挤在一起，所以这里不是查表摆坐标，
 * 而是**在约束下解出最大的合法框**：
 *
 * - 矩形不相交的判据是「横向分开 **或** 纵向分开」两条腿。
 * - 于是对每一对已经贴到一起的框，挑"损失较小的那条腿"去缩，循环到没有一对相交。
 *
 * 这样 2~8 人、横竖屏都能自动得到"在该视口下尽可能大、且保证不重叠"的座位框，
 * 不需要为每种人数手写一组魔法数。
 *
 * ## 已知代价（写在明处，别让它变成惊喜）
 *
 * 竖屏满桌时解出来的框只有 60~70 宽，装不下「头像 + 昵称 + 筹码 + 两张底牌」，
 * 所以这里额外给出 `compact` 标志，由座位组件按标志切紧凑版式（SPEC §4.2 本来就把
 * 自己的底牌挪到屏幕底部，别人家的牌背在这种密度下只能缩成一角的小牌）。
 *
 * 但"紧凑"不等于"看不清"：`READABLE_SEAT_FLOOR` 是这条线的硬下限，
 * 宁可少占桌面也不裁字——被裁掉的字是 bug，不是设计。
 */

/** 竖屏断点：SPEC §4.2「竖屏（<768px）」 */
export const PORTRAIT_MAX_VIEWPORT_WIDTH = 768;

/** SPEC §4.2「对面 3 个座位缩小到 70%」，但它是**上限**不是命令：见 `READABLE_SEAT_FLOOR` */
export const OPPOSITE_SEAT_SCALE = 0.7;

/**
 * 椭圆长宽比：横屏 2:1 是 SPEC §4.2 的数；竖屏 1.7:1 是 D-029 从 1.3 改的。
 * SPEC 给 1.3 的理由是"透视压缩"，但 1.3 在手机上量出来的桌面只有 221×170，
 * 用户判「有点圆了，不够椭圆」。桌面图的画布也按它出，才能等比拉伸。
 */
export const FELT_ASPECT = { landscape: 2, portrait: 1.7 };

/** 座位框的"理想上限"。放不满就按文件头那套解法往下缩 */
const SEAT_BASE = {
  landscape: { w: 180, h: 132 },
  portrait: { w: 104, h: 56 },
};

/**
 * 座位框的**可读下限**，同时是紧凑版式的设计尺寸：`.seat--compact` 那档排的是
 * 「头像 + 昵称/筹码两行」，徽标绝对定位浮在右上角不占高度。低于这条线，字就被
 * `.seat { overflow: hidden }` 裁掉——那是"看不清"，不是"小一点"（用户报的第 2 条）。
 *
 * 它还是 `OPPOSITE_SEAT_SCALE` 的刹车：对面那几个缩到 70% 之后如果小于这条线，
 * 就停在这条线上（SPEC §4.2 要的是"对面别太抢眼"，不是"对面看不清"）。
 */
export const READABLE_SEAT_FLOOR = { w: 64, h: 44 };

/** 框与框、框与视口边缘之间必须留下的呼吸距离 */
const GAP = 6;

/**
 * 全尺寸版式（头像 + 昵称 + 筹码 + 两枚牌背 + 徽标条）真正需要的框高。
 * `SEAT_BASE` 的 132 是留了徽标换行的余量，112 是下限：矮于此，`.seat` 的内容就
 * 溢出到 `overflow: hidden` 外面了，必须改走紧凑版式。
 */
const FULL_SEAT_MIN_HEIGHT = 112;

/**
 * 紧凑版式的**设计框**：`.seat--compact` 排的是「头像 + 昵称/筹码两行」，
 * 104×44 就是它排满的样子，多给一像素都不再多显示任何东西。
 *
 * 为什么要卡得这么死，横竖各说一次：
 * - **竖向**从椭圆中心到视口顶要装下「半格座位 + 呼吸 + 底池那一行 + 呼吸 + 半张
 *   公共牌」，座位高一分公共牌就小一分——横过来那档座位从 55 降到 44，公共牌从
 *   15px 涨到 30px（他报的"看不全"里真正读得出东西的那几个字就靠这 15px）。
 * - **横向**两侧座位的内沿之间的空档就是底池那一行的位子，180 宽时只剩 76px，
 *   连"只显数字"的 84px 都放不下，于是公共牌被压到 12px；收到 104 就宽出 76px。
 *
 * 宽度试过 128（想把 `ALL-IN` 与七位筹码同时排进一行），量下来更亏：横屏 6 人的
 * 公共牌从 29px 掉到 25px，而且牌堆在 6 人和 8 人都找不到位置。`ALL-IN` 那一格
 * 和七位数筹码其实不会同时出现——全下的人桌上剩 0 枚，所以 104 够用。
 */
const COMPACT_SEAT = { w: 104, h: READABLE_SEAT_FLOOR.h };

/** 公共牌最大尺寸（再大就按桌面等比缩），1.4 是牌面宽高比（同 `SPEC.md` §4.5 的牌） */
const CARD_MAX_WIDTH = 86;
const CARD_RATIO = 1.4;
const CARD_GAP_FRACTION = 0.14;
/** 一排公共牌最多占桌面宽这么多，剩下留给描金边与两侧座位 */
const BOARD_ROW_FRACTION = 0.6;

/**
 * 底池那一行的**文字**尺寸：CSS 里是 13px 的「底池」+ 19px 的数字（`.felt-stage__pot`，
 * `white-space: nowrap` 且水平居中）。几何必须按它留位——之前框高是从 `cardH` 推的
 * （手机上 18px），于是那两个字直接压在公共牌上（用户报的第 3 条）。
 *
 * 宽度按私局的量级给：「底池 12,345」这一整行 13px×2 + 8 + 19px×7 ≈ 114，
 * 只显数字时 ≈ 84。金额真到七位数（1,234,567）时文字会从框里对称地溢出去一点——
 * 那是"数字比预留的位子长"，不是"两行叠在一起"，私局的池子不会到那个量级。
 *
 * 收起到"只显数字"是桌面太扁时的退路：再坚持显示「底池」两个字，公共牌就被挤成
 * 十几 px，那是用一个看不清换另一个看不清。两条都走不通时整档降级，见 `potTight`。
 */
export const POT_LINE_HEIGHT = 26;
export const POT_NUMBER_LINE = 20;
export const POT_CLEARANCE = 8;
export const POT_LABEL_WIDTH = 114;
export const POT_NUMBER_WIDTH = 84;
/** 底池那一行的半宽上限（占桌面半轴的比例）：再宽就飘到描金边上去了 */
const POT_HALF_FRACTION = 0.42;
/** 公共牌低于这条线就只是几个色块，读不出牌面（也是"该不该收底池标签"的判据） */
export const CARD_READABLE_MIN = 22;

export interface StageSize {
  readonly width: number;
  readonly height: number;
}

/**
 * 量不到桌面时用的尺寸：`.felt-stage` 在 980px 主栏里的实际大小。
 *
 * 需要它是因为「容器还没布局好」和「根本没有布局」是两回事：浏览器里首帧之后
 * `getBoundingClientRect()` 就有数了，而 jsdom 里永远是 `0×0`。如果直接把 0 喂给
 * `layoutTable`，组件测试断言的就是一套退化坐标，等于没测。
 */
export const FALLBACK_STAGE: StageSize = { width: 948, height: 520 };

export type Orientation = 'landscape' | 'portrait';

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface SeatSlot extends Box {
  /**
   * **相对视角**下的槽位号：0 = 我（永远正下方中央），顺时针递增。
   * 不是服务端的 `seatIndex` —— 后者由 `relativeOffset` 换算过来。
   */
  readonly offset: number;
  /** 上半桌（竖屏要缩到 70% 的那些） */
  readonly opposite: boolean;
  /** 框太小、装不下底牌，座位组件应切紧凑版式 */
  readonly compact: boolean;
  /** 槽位在椭圆上的锚点（框的中心就是它） */
  readonly anchor: { readonly x: number; readonly y: number };
}

export interface TableLayout {
  readonly width: number;
  readonly height: number;
  readonly orientation: Orientation;
  /** 椭圆中心 = 视口中心 */
  readonly center: { readonly x: number; readonly y: number };
  /** 桌面椭圆的内接矩形，交给 `pokerTable.ts` 生成的那张图去铺 */
  readonly felt: Box;
  /** 座位锚点所在的那个椭圆（比桌面椭圆大一圈，让座位压在描金边上） */
  readonly ring: { readonly rx: number; readonly ry: number };
  /** 长度 = `capacity`，下标 = `offset` */
  readonly seats: readonly SeatSlot[];
  /** 5 格公共牌槽位（还没发到的格子照样占位） */
  readonly board: readonly Box[];
  /** 底池数字的位置：公共牌上方（SPEC §4.2）。高度按**文字行框**给，不是从椭圆推 */
  readonly pot: Box;
  /** 桌面太窄、连「底池」两个字都排不下时，组件只显数字 */
  readonly potTight: boolean;
  /**
   * 牌堆：椭圆中心偏右上（SPEC §4.2）。挤到连一块牌背的位置都没有时为 `null`，
   * 组件不画它——压在座位上比没有牌堆更糟。
   */
  readonly deck: Box | null;
  /** 单张公共牌的尺寸，组件拿来算自己的牌 */
  readonly cardSize: { readonly w: number; readonly h: number };
}

export interface LayoutInput {
  readonly width: number;
  readonly height: number;
  /** 座位槽数 = `config.maxPlayers`。坐了几个人不影响几何，空位照样占一格 */
  readonly capacity: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 去掉浮点噪声：坐标最终会变成 CSS 的 px，两位小数足够，且快照页与组件能对得上 */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function orientationFor(width: number): Orientation {
  return width < PORTRAIT_MAX_VIEWPORT_WIDTH ? 'portrait' : 'landscape';
}

/**
 * 服务端座位号 → 相对视角槽位号。
 *
 * 自己必须是 0，别人按顺时针排下去。`mySeat === null`（还没入座 / 旁观）时退化成
 * 「座位号即槽位号」，让旁观者看到一张正常的桌子，而不是一片 NaN。
 * 越界的脏数据也走同一条取模路：前端不替服务端判断合法性，只求不炸。
 */
export function relativeOffset(seatIndex: number, mySeat: number | null, capacity: number): number {
  if (capacity <= 0) return 0;
  const base = mySeat ?? 0;
  return ((seatIndex - base) % capacity + capacity) % capacity;
}

/**
 * 在「两两不相交」的约束下解出尽可能大的座位框。
 *
 * 每发现一对相交的框，就缩掉它两条分离腿中**相对损失较小**的那一条；缩到没有相交对
 * 为止。循环有上限，因为每步都严格变小。
 *
 * "已经没有腿可缩"必须显式判：一条腿已经贴着可读下限时，它的账面损失看着比另一条小，
 * 于是每一对都挑它，另一条腿永远不动——横屏手机上 8 个座位全体重叠在一起就是这么来的。
 * 两条腿都贴地就说明这套锚点装不下可读的座位，直接把下限交回去，让外层 `band` 迭代
 * 把桌子撑大一点再解。
 */
function fitSeatSize(anchors: readonly { x: number; y: number }[], base: { w: number; h: number }): {
  w: number;
  h: number;
} {
  let w = base.w;
  let h = base.h;
  // 下限不能高于理想尺寸，否则等于没缩（比如横屏 base 只有 38 高的极端配置）
  const floorW = Math.min(READABLE_SEAT_FLOOR.w, base.w);
  const floorH = Math.min(READABLE_SEAT_FLOOR.h, base.h);
  const centers = anchors.map((a) => ({ x: a.x, y: a.y }));

  for (let step = 0; step < 64; step += 1) {
    let worst: { dx: number; dy: number } | null = null;
    for (let i = 0; i < centers.length; i += 1) {
      for (let j = i + 1; j < centers.length; j += 1) {
        const a = centers[i];
        const b = centers[j];
        if (a === undefined || b === undefined) continue;
        const dx = Math.abs(a.x - b.x);
        const dy = Math.abs(a.y - b.y);
        if (dx - GAP >= w || dy - GAP >= h) continue; // 这一对已经分得开（还留出呼吸距离）
        if (worst === null || dx + dy < worst.dx + worst.dy) worst = { dx, dy };
      }
    }
    if (worst === null) break;
    const canW = w > floorW + 1e-6;
    const canH = h > floorH + 1e-6;
    if (!canW && !canH) break;
    const nextW = Math.max(floorW, worst.dx - GAP);
    const nextH = Math.max(floorH, worst.dy - GAP);
    const loseW = canW ? (w - nextW) / base.w : Number.POSITIVE_INFINITY;
    const loseH = canH ? (h - nextH) / base.h : Number.POSITIVE_INFINITY;
    if (loseW <= loseH) w = nextW;
    else h = nextH;
  }

  return { w: round(w), h: round(h) };
}

/** 两个框是否相交（共用一条边也算：视觉上就是"贴住了"） */
function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** 五格公共牌 + 底池 + 牌堆：都从椭圆中心长出来，尺寸跟桌面等比 */
function centerPieces(felt: Box, seats: readonly Box[]): {
  board: readonly Box[];
  pot: Box;
  potTight: boolean;
  deck: Box | null;
  cardSize: { w: number; h: number };
} {
  const cx = felt.x + felt.w / 2;
  const cy = felt.y + felt.h / 2;
  const rx = felt.w / 2;
  const ry = felt.h / 2;

  // 一排的横向上限：不出桌沿（留给描金边与两侧座位）。竖向不单独设上限——
  // 它由下面"整排 + 底池那一行都不许压到任何一格座位"这条判据来定，那才是真约束。
  const rowLimit = (felt.w * BOARD_ROW_FRACTION) / (5 + CARD_GAP_FRACTION * 4);
  const widest = Math.min(CARD_MAX_WIDTH, rowLimit);

  /**
   * 按候选牌宽与候选竖向偏移摆出「五格公共牌 + 底池那一行」。
   *
   * 底池的宽度取三者最小：文字实际需要、不出公共牌那一排的两端、让开**与它同一横带**
   * 的座位。最后一条是关键：竖向分得开的座位不该来抢它的宽度。从前用的是"取上半桌
   * 最低的一格当统一天花板"，横屏 8 人时斜上方 45° 那格被算了进来，公共牌从 30px
   * 掉到 12px（他报的第 3 条那一屏，实际读得出的只剩一小块色）。
   */
  const place = (cardW: number, lineHeight: number, textWidth: number, dy: number) => {
    const cardH = round(cardW * CARD_RATIO);
    const gap = round(cardW * CARD_GAP_FRACTION);
    const rowW = round(cardW * 5 + gap * 4);
    const left = round(cx - rowW / 2);
    const board: Box[] = Array.from({ length: 5 }, (_, index) => ({
      x: round(left + index * (cardW + gap)),
      y: round(cy + dy - cardH / 2),
      w: cardW,
      h: cardH,
    }));
    const potY = round(cy + dy - cardH / 2 - POT_CLEARANCE - lineHeight);
    let room = Math.min(rowW / 2, rx * POT_HALF_FRACTION);
    for (const seat of seats) {
      if (seat.y >= potY + lineHeight || potY >= seat.y + seat.h) continue;
      room = Math.min(room, Math.abs(seat.x + seat.w / 2 - cx) - seat.w / 2 - GAP);
    }
    const width = round(Math.max(24, Math.min(textWidth, room * 2)));
    const pot: Box = { x: round(cx - width / 2), y: potY, w: width, h: lineHeight };
    return { board, pot, cardW, cardH };
  };

  /**
   * 由大到小找牌宽，每个牌宽再找竖向偏移：先正中，再往上下各试几档。
   *
   * 为什么要给偏移这一维：奇数人时 12 点方向没有座位，斜上方那两格的下沿却压到中心线
   * 附近（5 人竖屏只剩 46px 的空档），整块牌钉在椭圆正中就只能缩成 12px；往上挪 12px
   * 就恢复到 30px。偶数人对称，第一档（正中）就能摆下，摆法与从前一致。
   * 偏移上限压在桌面半轴的 1/4：再多就不是"牌在桌子中央"了，宁可牌子小一点。
   *
   * 两档文字版式按"先给整行、给不起再只给数字"试；摆得下 = 公共牌与底池都不碰座位、
   * 不出桌面、且底池那一行的位子还容得下它的文字。
   */
  const maxShift = (ry / 4) * 0.9;
  const shifts = [0, -3, 3, -6, 6, -9, 9, -12, 12, -16, 16, -20, 20, -24, 24, -28, 28].filter(
    (value) => Math.abs(value) <= maxShift,
  );
  const passes = [
    { lineHeight: POT_LINE_HEIGHT, minWidth: CARD_READABLE_MIN, textWidth: POT_LABEL_WIDTH, tight: false },
    { lineHeight: POT_NUMBER_LINE, minWidth: 12, textWidth: POT_NUMBER_WIDTH, tight: true },
  ] as const;
  const fits = (board: readonly Box[], pot: Box) => {
    if (pot.y < felt.y || board[4] === undefined || board[4].y + board[4].h > felt.y + felt.h) return false;
    return ![...board, pot].some((box) => seats.some((seat) => intersects(box, seat)));
  };
  let chosen: ReturnType<typeof place> | null = null;
  let tight = true;
  for (const pass of passes) {
    for (let cardW = Math.floor(widest); cardW >= pass.minWidth; cardW -= 1) {
      const hit = shifts
        .map((shift) => place(cardW, pass.lineHeight, pass.textWidth, shift))
        .find((candidate) => fits(candidate.board, candidate.pot) && candidate.pot.w >= pass.textWidth);
      if (hit === undefined) continue;
      chosen = hit;
      tight = pass.tight;
      break;
    }
    if (chosen !== null) break;
  }
  /**
   * 两档都摆不下才走到这里：座位已经压到中心那一列。这一档保不住"好看"，但还保住
   * "不重叠"——底池的宽度已按实际剩的位子收过，牌也退到最小的 12px。
   */
  const { board, pot, cardW, cardH } = chosen ?? place(12, POT_NUMBER_LINE, POT_NUMBER_WIDTH, 0);

  /**
   * 牌堆钉在中心偏右上（SPEC §4.2），但具体落在几点、离中心多远是**搜**出来的：
   * 桌面铺开后座位就压在描金边上，原来那个固定的 0.72 半径在手机上正好坐进 1 点半
   * 那一格里。所以把"12 点半到 3 点"这一片切成 15° 一档、半径 0.86 递减到 0.14，
   * 钟点按 45°→30°→60°→… 的偏好顺序试（正右上最像牌桌的放牌处），全被占就把牌背
   * 本身缩一号再试——它是画面里最不要紧的一块。
   *
   * 真的一处都塞不下时返回 `null`，组件不画它：宁可这一档没有牌堆，也不要一摞牌背
   * 压在别人的座位上——那正是他报回来的"重叠"。走不到这里最好，但代码要有这条出口。
   */
  const obstacles = [...seats, ...board, pot];
  /**
   * 屏幕方位角：0 = 12 点，顺时针增大（x 取 sin、y 取 -cos）。
   * 只取 15°~75°：**不含** 0 和 90，那两个会让牌堆正好落在中心的正上方/正右方，
   * 而 SPEC §4.2 要的是「偏右上」，两个方向都得偏出去一点。
   */
  const bearings = [45, 30, 60, 15, 75];
  const radii = [0.86, 0.8, 0.74, 0.68, 0.62, 0.56, 0.5, 0.44, 0.38, 0.32, 0.26, 0.2, 0.14];
  const deckBoxAt = (radius: number, bearing: number, scale: number): Box => {
    const rad = (bearing * Math.PI) / 180;
    return {
      x: round(cx + rx * radius * Math.sin(rad) - (cardW * scale) / 2),
      y: round(cy - ry * radius * Math.cos(rad) - (cardH * scale) / 2),
      w: round(cardW * scale),
      h: round(cardH * scale),
    };
  };
  let deck: Box | null = null;
  outer: for (const scale of [1, 0.8, 0.62, 0.45]) {
    for (const radius of radii) {
      for (const bearing of bearings) {
        const candidate = deckBoxAt(radius, bearing, scale);
        if (obstacles.some((box) => intersects(box, candidate))) continue;
        deck = candidate;
        break outer;
      }
    }
  }

  return {
    board,
    pot,
    potTight: tight,
    deck,
    cardSize: { w: cardW, h: cardH },
  };
}

export function layoutTable(input: LayoutInput): TableLayout {
  const width = input.width;
  const height = input.height;
  const capacity = clamp(Math.round(input.capacity), 2, 8);
  const orientation = orientationFor(width);
  /**
   * 座位的"理想尺寸"还要被视口扣一道：横屏手机上整条视口只有 211px 高，按原始的
   * 180×132 排下去，两格座位就把高度占满，桌面反而被挤成屏宽的 25%——那是
   * "座位很大、牌桌很小"的怪桌子。单格座位至多吃掉视口的 30% × 26%，剩下的归桌面。
   * 这条只在横屏手机上生效（桌面与竖屏手机的 `SEAT_BASE` 本来就在比例以内）。
   */
  const base = {
    w: Math.min(SEAT_BASE[orientation].w, width * 0.3),
    h: Math.min(SEAT_BASE[orientation].h, height * 0.26),
  };

  const center = { x: round(width / 2), y: round(height / 2) };

  /** 每个槽位在椭圆上的参数角：offset 0 在正下方（SVG 的 y 轴朝下，所以是 +90°），递增即屏幕顺时针 */
  const thetas = Array.from({ length: capacity }, (_, offset) => Math.PI / 2 + (offset * 2 * Math.PI) / capacity);
  const anchorsFor = (rx: number, ry: number) =>
    thetas.map((theta) => ({
      x: round(center.x + rx * Math.cos(theta)),
      y: round(center.y + ry * Math.sin(theta)),
    }));

  /**
   * 座位框整块都要留在视口里，而两条轴各只有一小部分座位顶到边：
   * 竖向是 12 / 6 点那两格，横向是 3 / 9 点那两格。所以**按轴各解一次**
   * （`|rx·cosθ| + w/2 ≤ width/2` 对全部 θ 取最紧的一条），而不是从四边统一让出一条"座位带"。
   * 统一让带是从前的 bug：横屏 2 人桌两个座位都在上下，却按 180 的宽度往上让，
   * 结果 211px 高的视口只剩 19px 给桌面（D-029）。
   *
   * 座位多大取决于椭圆多扁，椭圆多大又取决于座位多大 —— 互为输入，所以迭代。
   * 迭代用**阻尼**：矮视口下存在「座位大 → 桌子小 → 座位小 → 桌子大 → …」的两档循环，
   * 直接迭代就在两个解之间永远跳，而 resize 时每像素都要重算，屏幕上就是整桌每秒抖几回
   * （`resize 连续` 那组用例守着它）。
   */
  const aspect = FELT_ASPECT[orientation];
  const maxCos = Math.max(0.02, ...thetas.map((theta) => Math.abs(Math.cos(theta))));
  const maxSin = Math.max(0.02, ...thetas.map((theta) => Math.abs(Math.sin(theta))));
  const solve = (seatBase: { w: number; h: number }, guess: { w: number; h: number }) => {
    const fromWidth = (width / 2 - guess.w / 2 - GAP) / maxCos;
    const fromHeight = (aspect * (height / 2 - guess.h / 2 - GAP)) / maxSin;
    const rx = round(clamp(Math.min(fromWidth, fromHeight), 20, Math.min(width / 2 - GAP, (height / 2 - GAP) * aspect)));
    const ry = round(rx / aspect);
    const anchors = anchorsFor(rx, ry);
    return { rx, ry, anchors, size: fitSeatSize(anchors, seatBase) };
  };
  /** 给定"座位理想尺寸"，解出椭圆与框的实际尺寸（迭代收敛，收尾以不越界为准） */
  const solveFor = (seatBase: { w: number; h: number }) => {
    let guess = seatBase;
    let solution = solve(seatBase, guess);
    for (let pass = 0; pass < 10; pass += 1) {
      if (Math.abs(solution.size.w - guess.w) < 0.5 && Math.abs(solution.size.h - guess.h) < 0.5) break;
      guess = { w: (guess.w + solution.size.w) / 2, h: (guess.h + solution.size.h) / 2 };
      solution = solve(seatBase, guess);
    }
    /**
     * 收尾以"座位不越界"为准：按 `guess` 定的椭圆是**保守**的（真实座位只会比它小），
     * 最后再用这组锚点解一次尺寸。这样「在视口内」与「两两不相交」两条同时成立，
     * 不靠迭代恰好收敛。
     */
    return { ...solution, size: fitSeatSize(solution.anchors, seatBase) };
  };

  /**
   * 先按全尺寸版式解一次。解出来矮于 `FULL_SEAT_MIN_HEIGHT` 就说明这一档装不下
   * 「头像 + 牌背 + 徽标条」，组件会切紧凑版式——那就按紧凑版的设计框
   * （`COMPACT_SEAT`）重新留位，横竖两条都收回它真正需要的量，把省下的还给桌面。
   *
   * 不换这一档的话，座位白占 12~88px 的高度和一整条中央空档：横屏手机上公共牌从
   * 30px 掉到 15px、底池那一行更是直接压在牌上，也就是他报的那两件事。
   * 换档是**单向**的（重解后座位 ≤ 44 高，只会仍是紧凑），所以不会来回跳。
   */
  let solution = solveFor(base);
  if (solution.size.h < FULL_SEAT_MIN_HEIGHT && base.h > COMPACT_SEAT.h) {
    solution = solveFor({ w: Math.min(base.w, COMPACT_SEAT.w), h: COMPACT_SEAT.h });
  }
  const { rx, ry, anchors, size } = solution;

  const felt: Box = { x: round(center.x - rx), y: round(center.y - ry), w: round(rx * 2), h: round(ry * 2) };
  const seats: SeatSlot[] = anchors.map((anchor, offset) => {
    const opposite = anchor.y < center.y;
    const scale = orientation === 'portrait' && opposite ? OPPOSITE_SEAT_SCALE : 1;
    // 「缩到 70%」是上限，不是命令：缩到小于可读下限就停，否则对面那几个正好被裁字
    const w = round(Math.max(size.w * scale, Math.min(READABLE_SEAT_FLOOR.w, size.w)));
    const h = round(Math.max(size.h * scale, Math.min(READABLE_SEAT_FLOOR.h, size.h)));
    return {
      offset,
      x: round(anchor.x - w / 2),
      y: round(anchor.y - h / 2),
      w,
      h,
      anchor,
      opposite,
      compact: h < FULL_SEAT_MIN_HEIGHT,
    };
  });

  const pieces = centerPieces(felt, seats);

  return {
    width: round(width),
    height: round(height),
    orientation,
    center,
    felt,
    ring: { rx, ry },
    seats,
    ...pieces,
  };
}
