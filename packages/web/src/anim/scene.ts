/**
 * 动画层的地基：量真元素的盒子、造幽灵、遮真元素（SPEC §3.1「动画期间的状态遮罩」）。
 *
 * ## 为什么动画不写在 React 里
 *
 * GSAP 要在两帧之间反复改同一个节点的 `transform`。React 每来一个 patch 就重画那棵树，
 * 两边抢同一个节点的结果是「牌飞到一半被 re-render 拽回原位」。所以动画只碰**幽灵**：
 * 本文件造出来、挂在 `.anim-layer` 上、React 完全不知道它存在的节点。
 * 真元素只被改一样东西：`visibility`（见下面的遮罩）。
 *
 * ## 坐标只有一个原点
 *
 * `.anim-layer` 是 `.table-page` 的 `inset: 0` 覆盖层，所以「舞台上的某个点」在两边
 * 是同一套数字：所有矩形都换算成**相对 layer 左上角**，幽灵的 `left/top` 也以 layer 为
 * offsetParent。于是落点是现量出来的，不缓存，拖动窗口不会漂——缩放窗口时唯一变的是
 * 量到的尺寸，而每次开播都重量。
 *
 * ## 遮罩为什么用 `visibility` 而不用 `display`
 *
 * 遮住的目的是「幽灵飞到位之前，别看见终态」。而 `display:none` 会把盒子尺寸一起改掉，
 * 于是同一时刻别的座位量到的坐标就跟着变——牌会飞到一半改道。`visibility:hidden` 保留
 * layout，`getBoundingClientRect()` 照样返回真实尺寸，几何不受影响。
 *
 * ## 计数，不布尔
 *
 * 两段动画可能遮同一个目标（底池在「跟注进池」和「派彩收池」里都要藏）。
 * 布尔的话先结束的那一段就把遮罩撤了，另一段还在飞的东西后面露出终态——
 * 玩家看到的是牌桌上同一个位置闪一下。所以每个元素一个计数，减到 0 才放开。
 * 每个解除函数只生效一次，所以同一个任务里 construction 与 play 各扫一遍是安全的。
 */

import type { Card } from '@poker-room/shared/view';

import { CARD_BACK_DATA_URI } from '../assets/cardBack';
import { cardFaceDataUri } from '../assets/cardFaces';
import { chipDataUri, type ChipDenomination } from '../assets/chips';

/** 一张牌在屏幕上占的盒子。`left/top` 相对 layer 左上角 */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** 遮罩的解除函数：幂等，调多次只生效一次 */
export type MaskRelease = () => void;

export interface AnimScene {
  readonly layer: HTMLElement;
  /** 按 `data-anim` 找锚点。找不到（还没渲染 / 人已经离桌）返回 null */
  readonly find: (key: string) => HTMLElement | null;
  /** 锚点里第 `index` 张牌（`.card-view`）的盒子；锚点在但没有那张牌时退回锚点自身 */
  readonly cardBox: (key: string, index: number) => Box | null;
  /** 锚点整体盒子。找不到返回 null */
  readonly box: (key: string) => Box | null;
  /** 锚点里第 `index` 张牌的中心（layer 坐标系），量不到返回 null */
  readonly cardCenter: (key: string, index: number) => Point | null;
  /**
   * 遮住锚点**和它里面所有的牌**，返回解除函数。
   *
   * 锚点不存在不是错误：发牌动画开播时我自己的 `.hole-strip` 可能还在定向消息的路上，
   * 那一刻没有东西可遮，几毫秒后它出现、下一轮开播前再扫一遍就遮住了。
   */
  readonly mask: (key: string) => MaskRelease;
  /** 造一张幽灵牌：`null` 是牌背。尺寸照 `key` 那一格里第 `index` 张牌量，量不到用 `fallbackWidth` */
  readonly card: (key: string, index: number, card: Card | null, fallbackWidth: number) => HTMLElement;
  /**
   * 造一张**能 3D 翻面**的幽灵牌：初始状态是牌背，把内层 `rotationY` 从 0 打到 180 就露出正面。
   *
   * 正面有两个来源，按事件给不给得出牌面来选：公共牌和摊牌亮牌的事件里就带着 `Card`，
   * 直接用它（`face` 传那张牌）；发牌的事件只说「发几个人」，我自己的两张底牌在哪张牌上
   * 只有 DOM 知道——那一格的正面本来就是定向消息画出来的，渲染层去读快照反而是多一个口径
   * （`face` 传 `null` = 从目标格子现读）。
   *
   * 正反两面各一个 `<img>`，靠 CSS 的 `backface-visibility: hidden` 互相挡（SPEC §3.3）。
   * 只用一张图 + 换 `src` 是更少的代码，但那不是翻面是变脸——玩家一眼就看出来。
   */
  readonly flip: (key: string, index: number, fallbackWidth: number, face: Card | null) => HTMLElement;
  /**
   * 目标那一格第 `index` 张牌此刻**亮着的正面**的图址；那里是牌背、空位或整格不存在时给 null。
   *
   * 判据是 `CardView` 的类名：花色后缀（`card-view--s/h/d/c`）只在正面时出现，
   * 背面是 `card-view--back`、空位是 `card-view--empty`。这是渲染层与那张牌之间唯一的约定，
   * 改 `CardView` 的类名时必须一起改这里。
   */
  readonly faceOf: (key: string, index: number) => string | null;
  /** 这一格是不是我自己的底牌（`.hole-strip` 上标了 `data-self`）。发牌只翻自己那两张 */
  readonly isSelf: (key: string) => boolean;
  readonly chip: (denom: ChipDenomination, size: number) => HTMLElement;
  /** 造一个浮动文字（牌型名、+金额、×N） */
  readonly label: (text: string, tone: 'award' | 'muted') => HTMLElement;
  /**
   * 造一个空的幽灵盒子（轻敲圈、气泡底这类只要形状不要内容的东西）。
   * 尺寸与位置都由调用方摆：`place(node, box)` 或 `center(node, point)`。
   */
  readonly frame: (kind: string) => HTMLElement;
  /** 把幽灵摆到某个盒子的左上角 */
  readonly place: (node: HTMLElement, box: Box) => void;
  /** 把幽灵摆到以 `at` 为中心 */
  readonly center: (node: HTMLElement, at: Point) => void;
  /** 幽灵挂进层里 */
  readonly add: (node: HTMLElement) => void;
  /** 摘掉本层所有幽灵（遮罩由各任务自己负责，这里不动） */
  readonly clear: () => void;
  /** 拆台：幽灵全摘、遮罩全放开 */
  readonly destroy: () => void;
}

/** 牌面 / 牌背的通用类名：`CardView` 用的也是它，所以量尺寸能量到同一套东西 */
const CARD_SELECTOR = '.card-view';

/** 量不到牌时的兜底牌宽（像素）。3:4 是牌面的固有比例 */
export const FALLBACK_CARD_WIDTH = 40;

interface MaskRecord {
  count: number;
  previous: string;
}

function centerOf(box: Box): Point {
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

/** 盒子的中心点。几何只在这一处换算，别处不再自己加半个宽高 */
export function boxCenter(box: Box): Point {
  return centerOf(box);
}

/**
 * `layer` 必须由 React 挂在牌桌容器里、且父级是 `position: relative`。
 * 锚点从 `layer` 的父级往下找，所以幽灵层和牌桌是兄弟，谁也不盖谁的点击。
 */
export function createAnimScene(layer: HTMLElement): AnimScene {
  const container = layer.parentElement ?? layer;
  const masks = new Map<HTMLElement, MaskRecord>();

  const find = (key: string): HTMLElement | null =>
    container.querySelector<HTMLElement>(`[data-anim="${key}"]`);

  const measure = (el: Element): Box => {
    const rect = el.getBoundingClientRect();
    const origin = layer.getBoundingClientRect();
    return {
      left: rect.left - origin.left,
      top: rect.top - origin.top,
      width: rect.width,
      height: rect.height,
    };
  };

  const box = (key: string): Box | null => {
    const el = find(key);
    return el === null ? null : measure(el);
  };

  const cardAt = (key: string, index: number): HTMLElement | null => {
    const el = find(key);
    if (el === null) return null;
    return el.querySelectorAll<HTMLElement>(CARD_SELECTOR).item(index) ?? el;
  };

  const cardBox = (key: string, index: number): Box | null => {
    const el = cardAt(key, index);
    return el === null ? null : measure(el);
  };

  const cardCenter = (key: string, index: number): Point | null => {
    const measured = cardBox(key, index);
    return measured === null ? null : centerOf(measured);
  };

  const maskOne = (el: HTMLElement): MaskRelease => {
    const existing = masks.get(el);
    if (existing === undefined) masks.set(el, { count: 1, previous: el.style.visibility });
    else existing.count += 1;
    el.style.visibility = 'hidden';
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const record = masks.get(el);
      if (record === undefined) return;
      record.count -= 1;
      if (record.count > 0) return;
      masks.delete(el);
      el.style.visibility = record.previous;
    };
  };

  const mask = (key: string): MaskRelease => {
    const el = find(key);
    if (el === null) return () => undefined;
    const releases: MaskRelease[] = [maskOne(el)];
    for (const card of Array.from(el.querySelectorAll<HTMLElement>(CARD_SELECTOR))) {
      releases.push(maskOne(card));
    }
    return () => {
      for (const release of releases) release();
    };
  };

  const node = (kind: string): HTMLElement => {
    const el = document.createElement('div');
    el.className = `anim-ghost anim-ghost--${kind}`;
    el.dataset['animGhost'] = kind;
    return el;
  };

  const picture = (src: string): HTMLImageElement => {
    const el = document.createElement('img');
    el.src = src;
    el.alt = '';
    el.className = 'anim-ghost__img';
    return el;
  };

  /** 幽灵的尺寸照目标那一格现有的牌量；量不到（还没渲染）用兜底宽 + 3:4 */
  const cardSize = (key: string, index: number, fallbackWidth: number): { w: number; h: number } => {
    const measured = cardBox(key, index);
    const width = measured === null || measured.width === 0 ? fallbackWidth : measured.width;
    const height = measured === null || measured.height === 0 ? (width * 4) / 3 : measured.height;
    return { w: Math.round(width), h: Math.round(height) };
  };

  /** 牌面朝上的那张牌长什么样：`CardView` 用花色后缀标正面，背面与空位各是另一个后缀 */
  const FACE_CLASS = /card-view--([shdc])(\s|$)/;

  const faceOf = (key: string, index: number): string | null => {
    const el = cardAt(key, index);
    if (el === null) return null;
    if (!FACE_CLASS.test(el.className)) return null;
    const src = el instanceof HTMLImageElement ? el.getAttribute('src') : null;
    return src === null || src.length === 0 ? null : src;
  };

  const scene: AnimScene = {
    layer,
    find,
    cardBox,
    box,
    cardCenter,
    mask,
    card: (key, index, card, fallbackWidth) => {
      const el = node(card === null ? 'card-back' : 'card-face');
      const size = cardSize(key, index, fallbackWidth);
      el.style.width = `${size.w}px`;
      el.style.height = `${size.h}px`;
      el.appendChild(picture(card === null ? CARD_BACK_DATA_URI : cardFaceDataUri(card)));
      return el;
    },
    flip: (key, index, fallbackWidth, face) => {
      const outer = node('card-flip');
      const size = cardSize(key, index, fallbackWidth);
      outer.style.width = `${size.w}px`;
      outer.style.height = `${size.h}px`;
      const inner = document.createElement('div');
      inner.className = 'anim-flip';
      const back = document.createElement('div');
      back.className = 'anim-flip__side anim-flip__side--back';
      back.appendChild(picture(CARD_BACK_DATA_URI));
      const front = document.createElement('div');
      front.className = 'anim-flip__side anim-flip__side--front';
      front.appendChild(picture(face === null ? (faceOf(key, index) ?? CARD_BACK_DATA_URI) : cardFaceDataUri(face)));
      inner.append(back, front);
      outer.appendChild(inner);
      return outer;
    },
    faceOf,
    isSelf: (key) => {
      const el = find(key);
      return el !== null && el.hasAttribute('data-self');
    },
    chip: (denom, size) => {
      const el = node('chip');
      el.style.width = `${size}px`;
      el.style.height = `${size}px`;
      el.appendChild(picture(chipDataUri(denom)));
      return el;
    },
    label: (text, tone) => {
      const el = node(`label-${tone}`);
      el.textContent = text;
      return el;
    },
    frame: (kind) => node(kind),
    place: (target, at) => {
      target.style.left = `${at.left}px`;
      target.style.top = `${at.top}px`;
    },
    center: (target, at) => {
      // 尺寸在造出来时就钉死了（牌、筹码都是），所以这里量的是自己，不碰坐标系
      const rect = target.getBoundingClientRect();
      target.style.left = `${at.x - rect.width / 2}px`;
      target.style.top = `${at.y - rect.height / 2}px`;
    },
    add: (target) => {
      layer.appendChild(target);
    },
    clear: () => {
      for (const ghost of Array.from(layer.querySelectorAll<HTMLElement>('[data-anim-ghost]'))) {
        ghost.remove();
      }
    },
    destroy: () => {
      scene.clear();
      for (const [el, record] of masks) {
        el.style.visibility = record.previous;
      }
      masks.clear();
    },
  };

  return scene;
}

/**
 * 翻面幽灵里**该被旋转的那一层**。
 *
 * 外层不转：它带 `left/top` 定位，GSAP 的 `x/y` 位移也要落在外层。
 * 内层带 `transform-style: preserve-3d`，正反两面各自 `backface-visibility: hidden`。
 * 拿不到内层（不该发生）就退化成转外层——宁可转得糙一点，也不要在这里抛错打断队列。
 */
export function flipInner(ghost: HTMLElement): HTMLElement {
  return ghost.querySelector<HTMLElement>('.anim-flip') ?? ghost;
}
