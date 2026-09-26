/**
 * 牌桌布局几何（M2.2）的守卫用例。
 *
 * ## 为什么这一层的验收先给机器而不是眼睛
 *
 * `TASKS.md` M2.2 第一条验收是「2/3/4/5/6/7/8 人各截一张图，用户目视验收，**无重叠、无溢出**」。
 * 但"无重叠、无溢出"是可以严格计算的：座位框两两求交、全体与视口求交，7 种人数 ×
 * 横竖屏共 14 个情形一次跑完，比 14 张截图覆盖得更全（截图只能证明"那一帧没重叠"）。
 * 于是机器管"对不对"，眼睛只管"好不好看"。
 *
 * ## 为什么几何是纯函数
 *
 * 同一套椭圆参数有三处要用：牌桌组件定位、M3 动画的目标点、以及给你看布局的那份
 * 静态快照页。收在 `layout.ts` 里三处共用一份；写进组件样式就会各算各的，
 * 动画会把牌发到座位框外面。
 */

import { describe, expect, it } from 'vitest';

import {
  FALLBACK_STAGE,
  POT_CLEARANCE,
  POT_LINE_HEIGHT,
  POT_NUMBER_LINE,
  READABLE_SEAT_FLOOR,
  layoutTable,
  OPPOSITE_SEAT_SCALE,
  PORTRAIT_MAX_VIEWPORT_WIDTH,
  relativeOffset,
  type Box,
  type SeatSlot,
  type TableLayout,
} from '../src/table/layout';

/** SPEC §4.2 点名的两个验收视口：桌面 1440×900，以及 /dev 手机框里 390 宽量到的那一格 */
const LANDSCAPE = { width: 1440, height: 900 };
const PORTRAIT = { width: 390, height: 312 };

/**
 * 手机上 `.felt-stage` **真正量到的**盒子（D-029）：宽度是 `app__main` 扣掉左右各 16px
 * 之后剩下的，高度是 `aspect-ratio: 5/4`、`max-height: 46vh`、`min-height: 240px` 三者
 * 共同决定的。之前只测过 `390×300` 那种"按长宽比推出来的"尺寸，于是几何在真机上塌成
 * 桌面只占屏宽 62%、对面座位 50×38（字被 `overflow: hidden` 裁掉）——
 * 下面这几档才是他手机上看到的那一套坐标，`PHONE_TIGHT_HEIGHT` 是分屏/小窗的最矮一档。
 */
const PHONE_PORTRAIT_390 = { width: 358, height: 286 };
const PHONE_PORTRAIT_375 = { width: 343, height: 274 };
const PHONE_TIGHT_HEIGHT = { width: 358, height: 240 };
const PHONE_LANDSCAPE = { width: 812, height: 211 };

/** 只有这三档是他手机上的真实尺寸，"看得清"那组断言挂在这几档上 */
const PHONES = [PHONE_PORTRAIT_390, PHONE_PORTRAIT_375, PHONE_LANDSCAPE] as const;

const CAPACITIES = [2, 3, 4, 5, 6, 7, 8] as const;

const CASES = [
  { name: '横屏 1440×900', viewport: LANDSCAPE },
  { name: '竖屏 390×312（/dev 手机框）', viewport: PORTRAIT },
  { name: '390 屏手机竖屏 358×286', viewport: PHONE_PORTRAIT_390 },
  { name: '375 屏手机竖屏 343×274', viewport: PHONE_PORTRAIT_375 },
  { name: '分屏小窗竖屏 358×240（min-height 顶住 46vh）', viewport: PHONE_TIGHT_HEIGHT },
  { name: '844 屏手机横过来 812×211', viewport: PHONE_LANDSCAPE },
  // 桌面量不到尺寸时组件用的就是这一档，所以它也得过同一套验算：
  // 不然「测试里无重叠」和「屏幕上无重叠」验的就不是同一套坐标。
  { name: '回退尺寸 948×520', viewport: FALLBACK_STAGE },
] as const;

function seatAt(layout: TableLayout, offset: number): SeatSlot {
  const seat = layout.seats[offset];
  if (seat === undefined) throw new Error(`布局里缺 ${offset} 号座位`);
  return seat;
}

function boardAt(layout: TableLayout, index: number): Box {
  const box = layout.board[index];
  if (box === undefined) throw new Error(`公共牌只有 ${layout.board.length} 格，没有第 ${index} 格`);
  return box;
}

function intersects(a: Box, b: Box): boolean {
  // 共用一条边也算重叠：视觉上就是"贴住了"
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function contains(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

function viewportBox(viewport: { width: number; height: number }): Box {
  return { x: 0, y: 0, w: viewport.width, h: viewport.height };
}

function centerOf(box: Box): { x: number; y: number } {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

/**
 * 屏幕方位角：椭圆中心为原点，**12 点方向 0°、顺时针增大**（SVG 的 y 轴朝下，
 * 所以 `atan2(横向, -纵向)` 才是"顺时针"而不是默认的逆时针）。
 */
function bearingOf(layout: TableLayout, box: Box): number {
  const c = centerOf(box);
  const raw = (Math.atan2(c.x - layout.center.x, layout.center.y - c.y) * 180) / Math.PI;
  return (raw % 360 + 360) % 360;
}

/** 牌堆的合法出口只有两个：给出一块偏右上的框，或者干脆给 `null`（组件不画它） */
function fixedBoxes(layout: TableLayout): Box[] {
  return [...layout.board, layout.pot, ...(layout.deck === null ? [] : [layout.deck])];
}

describe('无重叠', () => {
  for (const { name, viewport } of CASES) {
    for (const capacity of CAPACITIES) {
      it(`${name} / ${capacity} 人：任意两个座位框不相交`, () => {
        const { seats } = layoutTable({ ...viewport, capacity });
        expect(seats).toHaveLength(capacity);
        const offenders: string[] = [];
        for (const a of seats) {
          for (const b of seats) {
            if (a.offset >= b.offset) continue;
            if (intersects(a, b)) offenders.push(`${a.offset}×${b.offset}`);
          }
        }
        expect(offenders).toEqual([]);
      });

      /**
       * 每种人数都要单独查一遍：牌堆的位置是**搜**出来的，而可用的钟点随人数变（8 人时
       * 1 点半那格被座位占了）。只测 8 人等于放过了「人少时桌面更大、牌堆落点完全不同」
       * 那几档，而那正是手机上最常开的局。
       */
      it(`${name} / ${capacity} 人：座位与公共牌区 / 底池 / 牌堆互不相交，后四者彼此也不相交`, () => {
        const layout = layoutTable({ ...viewport, capacity });
        const { seats } = layout;
        const fixed = fixedBoxes(layout);
        const offenders: string[] = [];
        for (const seat of seats) {
          fixed.forEach((box, index) => {
            if (intersects(seat, box)) offenders.push(`座位 ${seat.offset} × 固定区 ${index}`);
          });
        }
        for (let i = 0; i < fixed.length; i += 1) {
          for (let j = i + 1; j < fixed.length; j += 1) {
            const a = fixed[i];
            const b = fixed[j];
            if (a !== undefined && b !== undefined && intersects(a, b)) offenders.push(`${i}×${j}`);
          }
        }
        expect(offenders).toEqual([]);
      });
    }
  }
});

describe('无溢出', () => {
  for (const { name, viewport } of CASES) {
    for (const capacity of CAPACITIES) {
      it(`${name} / ${capacity} 人：每个座位框完整在视口内`, () => {
        const page = viewportBox(viewport);
        for (const seat of layoutTable({ ...viewport, capacity }).seats) {
          expect(contains(page, seat)).toBe(true);
        }
      });

      it(`${name} / ${capacity} 人：桌面、五格公共牌、底池、牌堆都在视口内`, () => {
        const page = viewportBox(viewport);
        const layout = layoutTable({ ...viewport, capacity });
        expect(layout.board).toHaveLength(5);
        for (const box of [...fixedBoxes(layout), layout.felt]) {
          expect(contains(page, box)).toBe(true);
        }
      });
    }
  }

  it('公共牌五格彼此不相交，且整排以椭圆中心为水平中点', () => {
    const layout = layoutTable({ ...LANDSCAPE, capacity: 8 });
    for (let i = 0; i < 5; i += 1) {
      for (let j = i + 1; j < 5; j += 1) {
        expect(intersects(boardAt(layout, i), boardAt(layout, j))).toBe(false);
      }
    }
    const first = boardAt(layout, 0);
    const last = boardAt(layout, 4);
    expect(first.x + (last.x + last.w - first.x) / 2).toBeCloseTo(layout.center.x, 6);
  });

  it('底池在公共牌上方，牌堆在中心偏右上（SPEC §4.2）', () => {
    const { pot, felt, deck, center } = layoutTable({ ...LANDSCAPE, capacity: 8 });
    expect(pot.y + pot.h).toBeLessThan(felt.y + felt.h / 2);
    expect(centerOf(pot).x).toBeCloseTo(center.x, 6);
    // 这一档给得起牌堆（给不起的是手机横屏那几档，由下面那条扫描用例守着）
    if (deck === null) throw new Error('横屏 1440×900 / 8 人这一格该有牌堆的位置');
    expect(deck.x + deck.w / 2).toBeGreaterThan(center.x);
    expect(deck.y + deck.h / 2).toBeLessThan(center.y);
  });

  /**
   * D-029 之前这里是「底池的右沿必须停在牌堆左边」——那是牌堆被硬编码在固定半径时的
   * 近似规矩。现在底池是一条横带、牌堆在"12 点到 3 点之间（不含两端）"这一片里**搜**一
   * 个不压任何东西的落点，两者一上一下本就可能横向重叠而不相交，那条断言反而会把合法解判成 bug。
   *
   * 换成真正要守的两种出口：牌堆要么落在中心偏右上（SPEC §4.2），要么挤不下给 `null`、
   * 组件不画它。绝不允许第三种——为了画出一摞牌背而压在别人的座位上，那正是报回来的"重叠"。
   */
  it('牌堆要么偏右上、要么干脆不给（挤不下时不画，不许压在座位上）', () => {
    let nullCount = 0;
    for (const { viewport } of CASES) {
      for (const capacity of CAPACITIES) {
        const { deck, center, seats, board, pot } = layoutTable({ ...viewport, capacity });
        if (deck === null) {
          nullCount += 1;
          continue;
        }
        const c = centerOf(deck);
        expect(c.x).toBeGreaterThan(center.x);
        expect(c.y).toBeLessThan(center.y);
        expect(contains(viewportBox(viewport), deck)).toBe(true);
        // 与五格公共牌、底池、每一格座位都不相交（座位那几格正是它以前压上去的地方）
        for (const box of [...board, pot, ...seats]) {
          expect(intersects(deck, box)).toBe(false);
        }
      }
    }
    // 至少有一档真的塞不下：否则这条 `null` 出口就是没人走过的死代码
    expect(nullCount).toBeGreaterThan(0);
  });
});

describe('桌面椭圆的形状', () => {
  /**
   * 这条不是审美检查，是 `TableStage.tsx` 的前提：桌面那张 SVG 只在挂载时按
   * 「标准画布 + SPEC 的长宽比」生成一份，之后靠 CSS 拉伸到实际盒子。
   * 只有当 `layout.felt` 的比例恒等于那个比例时，拉伸才等价于重画——
   * 一旦几何改成"宽度富余就把桌子拉胖一点"，描金边会立刻变形。
   */
  it('横屏 2:1、竖屏 1.7:1，2~8 人都不变（桌面图按这个比例等比拉伸）', () => {
    for (const capacity of CAPACITIES) {
      const wide = layoutTable({ ...LANDSCAPE, capacity }).felt;
      expect(wide.w / wide.h).toBeCloseTo(2, 2);
      const tall = layoutTable({ ...PORTRAIT, capacity }).felt;
      expect(tall.w / tall.h).toBeCloseTo(1.7, 2);
    }
  });

  it('椭圆中心就是视口中心，长轴水平', () => {
    const layout = layoutTable({ ...LANDSCAPE, capacity: 6 });
    const c = centerOf(layout.felt);
    expect(c.x).toBeCloseTo(layout.center.x, 6);
    expect(c.y).toBeCloseTo(layout.center.y, 6);
    expect(layout.felt.w).toBeGreaterThan(layout.felt.h);
  });
});

describe('相对视角：自己在正下方中央、按顺时针排', () => {
  for (const { name, viewport } of CASES) {
    it(`${name}：2~8 人时 offset 0 都在正下方中央`, () => {
      for (const capacity of CAPACITIES) {
        const layout = layoutTable({ ...viewport, capacity });
        const self = seatAt(layout, 0);
        expect(centerOf(self).x).toBeCloseTo(layout.center.x, 1);
        const lowest = Math.max(...layout.seats.map((seat) => seat.y + seat.h));
        expect(self.y + self.h).toBeCloseTo(lowest, 1);
      }
    });

    it(`${name}：座位沿椭圆的**参数角**等分（SPEC §4.2 的参数方程），且屏幕上严格顺时针`, () => {
      for (const capacity of CAPACITIES) {
        const layout = layoutTable({ ...viewport, capacity });
        const step = 360 / capacity;
        // 参数角：把点按长短轴归一化后再取角度。椭圆上"等参数角"≠"等屏幕角"
        // （等屏幕角会让座位在左右两端挤成一团），所以这里比的是参数角。
        const parametric = layout.seats.map((seat) => {
          const c = centerOf(seat);
          const raw =
            (Math.atan2((c.y - layout.center.y) / layout.ring.ry, (c.x - layout.center.x) / layout.ring.rx) *
              180) /
            Math.PI;
          return ((raw % 360) + 360) % 360;
        });
        for (const [offset, angle] of parametric.entries()) {
          expect(angle).toBeCloseTo((90 + offset * step) % 360, 1);
        }
        // 屏幕方位角：12 点方向为 0°，**顺时针**增大。上面的参数角检查已经保证了
        // 等分，这里再保证「offset 越大越往顺时针方向走」——也就是下一位行动者
        // 在我左手边（德州的下家顺序）。跨 360° 那一次允许回绕。
        //
        // 每步的上限不是 `step`，而是 `step × 长轴/短轴`：椭圆上"等参数角"在屏幕上
        // 并不等角，正上/正下方那一段被拉开（8 人 2:1 那档实测 63.4°，均值只有 45°），
        // 左右两端被压拢。乘上轴比才是这条弧长真的能张到的角度；再加 0.5° 是给落到
        // CSS 像素上的那道舍入（343×274 那档 2 人桌实测 180.0029°）。
        const stretch = layout.felt.w / layout.felt.h;
        let previous = bearingOf(layout, seatAt(layout, 0));
        for (const seat of layout.seats.slice(1)) {
          let angle = bearingOf(layout, seat);
          if (angle <= previous) angle += 360;
          expect(angle).toBeGreaterThan(previous);
          expect(angle - previous).toBeLessThanOrEqual(step * stretch + 0.5);
          previous = angle;
        }
      }
    });
  }

  it('relativeOffset：无论我在几号位，我都是 0 号槽，且邻居关系保持顺时针', () => {
    expect(relativeOffset(3, 3, 8)).toBe(0);
    expect(relativeOffset(4, 3, 8)).toBe(1);
    expect(relativeOffset(2, 3, 8)).toBe(7);
    expect(relativeOffset(0, 7, 2)).toBe(1);
    expect(relativeOffset(7, 0, 8)).toBe(7);
    // 还没入座（旁观）时不报错，退化成"座位号即槽位号"
    expect(relativeOffset(5, null, 8)).toBe(5);
    // 越界的脏数据（服务端说了才算，前端只保证不炸）
    expect(relativeOffset(9, 3, 8)).toBe(6);
    expect(relativeOffset(-1, 3, 8)).toBe(4);
  });

  it('槽位几何只跟人数上限有关，且同一个输入永远给同一个结果', () => {
    // 同一张 8 人桌调两次必须逐字节相同：组件在 resize 中反复重算，
    // 只要有一处依赖了别的东西（比如 Math.random 或时间），坐标就会抖
    const a = layoutTable({ ...LANDSCAPE, capacity: 8 });
    const b = layoutTable({ ...LANDSCAPE, capacity: 8 });
    expect(b.seats).toEqual(a.seats);
    // 6 人桌是另一套几何
    const six = layoutTable({ ...LANDSCAPE, capacity: 6 });
    expect(six.seats).toHaveLength(6);
    expect(seatAt(six, 0).w).toBeGreaterThanOrEqual(seatAt(a, 0).w);
    expect(centerOf(seatAt(six, 3))).not.toEqual(centerOf(seatAt(a, 3)));
  });
});

describe('竖屏压缩（SPEC §4.2「对面 3 个座位缩小到 70%」）', () => {
  it('竖屏：上半桌按 0.7 缩，但缩到可读下限就停；横屏不缩', () => {
    const portrait = layoutTable({ ...PORTRAIT, capacity: 8 });
    const top = portrait.seats.filter((seat) => seat.opposite);
    const bottom = portrait.seats.filter((seat) => !seat.opposite);
    expect(top.length).toBeGreaterThan(0);
    expect(bottom.length).toBeGreaterThan(0);
    const firstBottom = bottom[0];
    if (firstBottom === undefined) throw new Error('竖屏 8 人桌算不出下半桌座位');
    for (const seat of top) {
      // 「缩到 70%」是上限，不是命令：缩完小到装不下昵称与筹码就不许再缩，
      // 否则就是他把「对面那几个看不清」报回来的那条（D-029）。
      // 精度 1 而不是 6：几何最后按两位小数落在 CSS 的像素上
      expect(seat.h).toBeCloseTo(Math.max(firstBottom.h * OPPOSITE_SEAT_SCALE, READABLE_SEAT_FLOOR.h), 1);
      expect(seat.w).toBeCloseTo(Math.max(firstBottom.w * OPPOSITE_SEAT_SCALE, READABLE_SEAT_FLOOR.w), 1);
      expect(seat.h).toBeLessThanOrEqual(firstBottom.h);
    }
    const landscape = layoutTable({ ...LANDSCAPE, capacity: 8 });
    expect(new Set(landscape.seats.map((seat) => seat.h)).size).toBe(1);
  });

  it('那个 0.7 就是 SPEC 写的数', () => {
    expect(OPPOSITE_SEAT_SCALE).toBeCloseTo(0.7, 10);
  });

  it('竖屏 8 人时座位被压到"紧凑档"，横屏 8 人不会', () => {
    const portrait = layoutTable({ ...PORTRAIT, capacity: 8 });
    const landscape = layoutTable({ ...LANDSCAPE, capacity: 8 });
    for (const seat of portrait.seats) {
      expect(seat.compact).toBe(true);
    }
    for (const seat of landscape.seats) {
      expect(seat.compact).toBe(false);
    }
  });
});

describe('resize 连续（不跳变）', () => {
  /**
   * 拖动窗口时几何每像素重算一次，所以真正的验收是两条：
   * **每一档尺寸自己合法**（不重叠、不溢出），以及**同一版式档内不抖**。
   *
   * 「全尺寸档 → 紧凑档」那一步是合法的跳变：座位版式整个换了（112 高变 44 高），
   * 桌面随之铺开，中心必然动。768→1000 那趟扫到 916×458 会撞上它一次，实测单步 66px
   * （约那一档桌面高的 14%）——所以换版式时放宽到「不超过桌面高的五分之一」，
   * 同一版式内仍按 < 2px 守。
   */
  function sweep(from: number, to: number, aspect: number, label: string): void {
    let previous: TableLayout | null = null;
    let switches = 0;
    for (let width = from; width <= to; width += 1) {
      const viewport = { width, height: Math.round(width / aspect) };
      const current = layoutTable({ ...viewport, capacity: 8 });
      const page = viewportBox(viewport);

      // ① 每一档自己合法：每 1px 都过一遍，不是只抽查几个宽度
      const fixed = fixedBoxes(current);
      for (const seat of current.seats) {
        expect(contains(page, seat), `${label} ${width}`).toBe(true);
        for (const box of fixed) {
          expect(intersects(seat, box), `${label} ${width}`).toBe(false);
        }
      }
      for (const box of [...fixed, current.felt]) {
        expect(contains(page, box), `${label} ${width}`).toBe(true);
      }

      if (previous === null) {
        previous = current;
        continue;
      }
      // ② 相邻两档之间：同一套版式不许抖；换版式允许跳，但一跳不能超过桌面高的五分之一。
      //    换版式有两处来源——横竖屏断点（长宽比整个换掉）与全尺寸↔紧凑档（座位框自己缩），
      //    768 那一步是前者，实测位移 24px；916→917 那一步是后者，实测 66px。
      const changedVersion =
        previous.orientation !== current.orientation ||
        previous.seats[0]?.compact !== current.seats[0]?.compact;
      if (changedVersion) switches += 1;
      for (const seat of current.seats) {
        const before = seatAt(previous, seat.offset);
        const moved = Math.hypot(
          centerOf(seat).x - centerOf(before).x,
          centerOf(seat).y - centerOf(before).y,
        );
        if (changedVersion) {
          expect(moved, `${label} ${width} 换版式`).toBeLessThan(viewport.height / 5);
        } else {
          expect(moved, `${label} ${width}`).toBeLessThan(2);
        }
      }
      previous = current;
    }
    // 换版式的次数有界：一路加宽却反复来回换档，说明迭代在两个解之间振荡
    expect(switches, label).toBeLessThanOrEqual(3);
  }

  it('横屏逐像素加宽：桌面 1:2 与手机横屏 16:9 两档都不重叠、不溢出、不抖', () => {
    sweep(768, 1000, 2, '横屏 1:2');
    sweep(700, 1000, 16 / 9, '手机横屏 16:9');
  });

  it('竖屏逐像素加宽：桌面 1:1.7 与窄屏上界那一档同样成立', () => {
    sweep(320, 500, 1.7, '竖屏 1:1.7');
    sweep(500, 767, 1.7, '竖屏 1:1.7（窄屏上界）');
  });

  it('跨过竖屏断点那一步移动有界：换档必然要动，但不许整桌飞掉', () => {
    const portrait = layoutTable({
      width: PORTRAIT_MAX_VIEWPORT_WIDTH - 1,
      height: Math.round((PORTRAIT_MAX_VIEWPORT_WIDTH - 1) / 1.7),
      capacity: 8,
    });
    const landscape = layoutTable({
      width: PORTRAIT_MAX_VIEWPORT_WIDTH,
      height: Math.round(PORTRAIT_MAX_VIEWPORT_WIDTH / 2),
      capacity: 8,
    });
    expect(portrait.orientation).toBe('portrait');
    expect(landscape.orientation).toBe('landscape');
    for (const seat of landscape.seats) {
      const before = seatAt(portrait, seat.offset);
      const moved = Math.hypot(
        centerOf(seat).x - centerOf(before).x,
        centerOf(seat).y - centerOf(before).y,
      );
      expect(moved).toBeLessThan(landscape.width * 0.35);
    }
  });
});

/**
 * 他在手机上看完回来的三条（筹码/手牌看不全、桌面塌成一条、"底池"压在公共牌上），
 * 全部都能写成数：座位框有下限、桌面占宽有下限、底池那一行给的是**文字**的高度。
 *
 * 这三条不是"越大越好"的贪心：它们和「无重叠」「无溢出」抢同一块地方，
 * 所以真正的验收是**四条同时成立**——上面那两组用例一条都没放松，这里只是把
 * "小到你看不清"也变成失败，而不是只能靠眼睛发现。
 */
describe('手机上要看得清（D-029）', () => {
  for (const { name, viewport } of CASES) {
    for (const capacity of CAPACITIES) {
      it(`${name} / ${capacity} 人：座位框不低于"昵称 + 筹码"读得清的那条线`, () => {
        for (const seat of layoutTable({ ...viewport, capacity }).seats) {
          expect(seat.w).toBeGreaterThanOrEqual(READABLE_SEAT_FLOOR.w);
          expect(seat.h).toBeGreaterThanOrEqual(READABLE_SEAT_FLOOR.h);
        }
      });
    }
  }

  it('底池那一行始终给足文字高度，并且与公共牌留够呼吸距离', () => {
    for (const { name, viewport } of CASES) {
      for (const capacity of CAPACITIES) {
        const layout = layoutTable({ ...viewport, capacity });
        // 框高只能落在"数字那一行"与"整行"之间：低于前者就是从前那 18px 的 bug
        expect(layout.pot.h, name).toBeGreaterThanOrEqual(POT_NUMBER_LINE);
        expect(layout.pot.h, name).toBeLessThanOrEqual(POT_LINE_HEIGHT);
        expect(boardAt(layout, 0).y - (layout.pot.y + layout.pot.h), name).toBeGreaterThanOrEqual(
          POT_CLEARANCE - 1,
        );
      }
    }
  });

  for (const phone of PHONES) {
    for (const capacity of CAPACITIES) {
      it(`${phone.width}×${phone.height} / ${capacity} 人：公共牌还认得出是牌`, () => {
        const { cardSize } = layoutTable({ ...phone, capacity });
        expect(cardSize.w).toBeGreaterThanOrEqual(20);
      });
    }
  }

  /** 各档视口桌面至少要铺开到屏宽的这个比例，否则"塌成一条"就又回来了 */
  const OCCUPANCY = [
    { viewport: PORTRAIT, min: 0.7 },
    { viewport: PHONE_PORTRAIT_390, min: 0.65 },
    { viewport: PHONE_PORTRAIT_375, min: 0.65 },
    { viewport: PHONE_TIGHT_HEIGHT, min: 0.6 },
    // 横屏手机被 211px 的高度卡死（座位要在 12 点方向落一格），能铺到三成已经是极限
    { viewport: PHONE_LANDSCAPE, min: 0.28 },
    { viewport: FALLBACK_STAGE, min: 0.7 },
  ] as const;

  for (const { viewport, min } of OCCUPANCY) {
    for (const capacity of CAPACITIES) {
      it(`${viewport.width}×${viewport.height} / ${capacity} 人：桌面铺满 ${Math.round(min * 100)}% 以上屏宽`, () => {
        const { felt } = layoutTable({ ...viewport, capacity });
        expect(felt.w / viewport.width).toBeGreaterThanOrEqual(min);
      });
    }
  }
});
