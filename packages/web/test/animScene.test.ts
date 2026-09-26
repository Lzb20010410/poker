/**
 * 动画地基的单测（`src/anim/scene.ts`）。
 *
 * ## 为什么这些能机器验、别的不能
 *
 * jsdom 不做 layout，所以「牌有没有飞到位」在这里验不了——那是 `/dev/replay` 的肉眼活。
 * 但它上面三件事**是纯 DOM 语义**，跟渲染无关，恰好都是写坏了会立刻在真机上咬人的：
 *
 * 1. **坐标系**：所有盒子都要换算成「相对 layer 左上角」。少减一次原点，
 *    整桌动画就整体偏移一个牌桌到页面顶部的距离。
 * 2. **遮罩的引用计数**：两段动画遮同一个底池，先结束的那段把遮罩撤了，
 *    另一段还在飞的牌后面就露出终态——真机上表现为「桌上同一个位置闪一下」。
 * 3. **幽灵的生命周期**：`clear` / `destroy` 必须把节点摘干净、把 `visibility` 还原。
 *    漏一条，玩家离开牌桌后屏幕上留着几张永远不消失的假牌。
 *
 * `getBoundingClientRect` 在这里被换成读 `data-rect` 的桩：jsdom 一律返回全 0，
 * 而原点换算这件事只有给不同元素不同坐标才测得出来。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAnimScene, type AnimScene } from '../src/anim/scene';

/** layer 在页面上的位置。所有断言里的期望值都已经减掉这个原点 */
const LAYER = '100,50,800,600';

const HTML = `
<div id="page" style="position:relative">
  <div id="felt" data-anim="stage" data-rect="120,60,600,300"></div>
  <div id="deck" data-anim="deck" data-rect="400,180,40,56"></div>
  <p id="pot" data-anim="pot" data-rect="360,200,120,28"></p>
  <span id="hole3" class="seat__hole" data-anim="hole-3" data-rect="300,340,90,56">
    <img class="card-view" data-rect="300,340,40,56" />
    <img class="card-view" data-rect="350,340,40,56" />
  </span>
  <span id="board0" class="felt-stage__slot" data-anim="board-0" data-rect="260,200,40,56">
    <span class="card-view card-view--empty" data-rect="260,200,40,56"></span>
  </span>
  <div id="layer" class="anim-layer" data-rect="${LAYER}"></div>
</div>`;

function mount(): AnimScene {
  document.body.innerHTML = HTML;
  const layer = document.querySelector<HTMLElement>('#layer');
  if (layer === null) throw new Error('fixture 没挂上');
  return createAnimScene(layer);
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

/**
 * jsdom 里没有 layout：`getBoundingClientRect()` 恒为全 0。
 * 桩把 `data-rect="left,top,width,height"` 当成视口坐标直接吐出来。
 */
function stubRects(): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ): DOMRect {
    const raw = this.getAttribute('data-rect');
    const [left = 0, top = 0, width = 0, height = 0] =
      raw === null
        ? []
        : raw.split(',').map((part) => Number(part));
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({}),
    };
  });
}

describe('坐标只有一个原点', () => {
  it('锚点盒子换算成相对 layer，不是相对视口', () => {
    stubRects();
    const scene = mount();
    // deck 在视口 400,180，layer 在 100,50
    expect(scene.box('deck')).toEqual({ left: 300, top: 130, width: 40, height: 56 });
  });

  it('锚点不在 DOM 里（人离桌了 / 还没渲染）给 null，不抛', () => {
    stubRects();
    const scene = mount();
    expect(scene.find('hole-7')).toBeNull();
    expect(scene.box('hole-7')).toBeNull();
    expect(scene.cardBox('hole-7', 0)).toBeNull();
    expect(scene.cardCenter('hole-7', 1)).toBeNull();
  });

  it('取到的是那一格里第 index 张牌，不是整个容器', () => {
    stubRects();
    const scene = mount();
    expect(scene.cardBox('hole-3', 1)).toEqual({ left: 250, top: 290, width: 40, height: 56 });
    expect(scene.cardCenter('hole-3', 0)).toEqual({ x: 220, y: 318 });
  });

  it('要的那张牌还没长出来时退回容器中心，宁可落点粗一点也不要 null', () => {
    stubRects();
    const scene = mount();
    expect(scene.cardBox('hole-3', 5)).toEqual({ left: 200, top: 290, width: 90, height: 56 });
  });
});

describe('遮罩是引用计数，不是布尔', () => {
  it('遮一个锚点会连里面的牌一起遮，解除后原样还原', () => {
    stubRects();
    const scene = mount();
    const release = scene.mask('hole-3');
    const anchor = document.querySelector<HTMLElement>('#hole3');
    const cards = document.querySelectorAll<HTMLElement>('#hole3 .card-view');
    expect(anchor?.style.visibility).toBe('hidden');
    expect(cards[0]?.style.visibility).toBe('hidden');
    expect(cards[1]?.style.visibility).toBe('hidden');
    release();
    expect(anchor?.style.visibility).toBe('');
    expect(cards[1]?.style.visibility).toBe('');
  });

  it('两段动画遮同一个目标：先结束的那段不许把它放出来', () => {
    stubRects();
    const scene = mount();
    const first = scene.mask('pot');
    const second = scene.mask('pot');
    const pot = document.querySelector<HTMLElement>('#pot');
    first();
    expect(pot?.style.visibility).toBe('hidden');
    second();
    expect(pot?.style.visibility).toBe('');
  });

  it('解除函数幂等：调两次只减一次计数', () => {
    stubRects();
    const scene = mount();
    const first = scene.mask('pot');
    const second = scene.mask('pot');
    first();
    first();
    expect(document.querySelector<HTMLElement>('#pot')?.style.visibility).toBe('hidden');
    second();
    expect(document.querySelector<HTMLElement>('#pot')?.style.visibility).toBe('');
  });

  it('遮一个此刻还不存在的锚点不是错误：空解除函数，也不碰别人的样式', () => {
    stubRects();
    const scene = mount();
    const release = scene.mask('hole-9');
    expect(() => release()).not.toThrow();
    expect(document.querySelector<HTMLElement>('#pot')?.style.visibility).toBe('');
  });

  it('遮罩记住的是**遮之前**的值，不是空字符串', () => {
    stubRects();
    const scene = mount();
    const pot = document.querySelector<HTMLElement>('#pot');
    if (pot !== null) pot.style.visibility = 'collapse';
    const release = scene.mask('pot');
    expect(pot?.style.visibility).toBe('hidden');
    release();
    expect(pot?.style.visibility).toBe('collapse');
  });
});

describe('幽灵的造、摆、拆', () => {
  it('牌背与牌面是两个不同的幽灵，尺寸照目标那一格量', () => {
    stubRects();
    const scene = mount();
    const back = scene.card('hole-3', 0, null, 40);
    const face = scene.card('hole-3', 0, { rank: 14, suit: 's' }, 40);
    expect(back.dataset['animGhost']).toBe('card-back');
    expect(face.dataset['animGhost']).toBe('card-face');
    expect(back.style.width).toBe('40px');
    expect(back.style.height).toBe('56px');
    expect(back.firstElementChild?.getAttribute('src')).toMatch(/^data:image\/svg\+xml,/);
  });

  it('量不到目标格时用兜底宽度，并按 3:4 补出高度', () => {
    stubRects();
    const scene = mount();
    const ghost = scene.card('hole-8', 0, null, 30);
    expect(ghost.style.width).toBe('30px');
    expect(ghost.style.height).toBe('40px');
  });

  it('筹码是正方形，牌型名是文字幽灵', () => {
    stubRects();
    const scene = mount();
    const chip = scene.chip(100, 22);
    const label = scene.label('三条', 'award');
    expect(chip.style.width).toBe('22px');
    expect(chip.style.height).toBe('22px');
    expect(label.textContent).toBe('三条');
    expect(label.dataset['animGhost']).toBe('label-award');
  });

  it('摆位按中心对齐：落点就是那张牌的中心，不是左上角', () => {
    stubRects();
    const scene = mount();
    const ghost = scene.card('hole-3', 1, null, 40);
    ghost.dataset['rect'] = '0,0,40,56';
    const at = scene.cardCenter('hole-3', 1);
    if (at === null) throw new Error('目标格量不到');
    scene.center(ghost, at);
    expect(ghost.style.left).toBe('250px');
    expect(ghost.style.top).toBe('290px');
  });

  it('clear 只摘幽灵，destroy 连遮罩一起还原', () => {
    stubRects();
    const scene = mount();
    const release = scene.mask('hole-3');
    scene.add(scene.card('hole-3', 0, null, 40));
    const layer = document.querySelector<HTMLElement>('#layer');
    expect(layer?.children.length).toBe(1);

    scene.clear();
    expect(layer?.children.length).toBe(0);
    expect(document.querySelector<HTMLElement>('#hole3')?.style.visibility).toBe('hidden');

    scene.add(scene.chip(5, 20));
    release();
    scene.destroy();
    expect(layer?.children.length).toBe(0);
    expect(document.querySelector<HTMLElement>('#hole3')?.style.visibility).toBe('');
  });

  it('destroy 会把没人解除的遮罩也放开：拆台不留半截状态', () => {
    stubRects();
    const scene = mount();
    scene.mask('pot');
    expect(document.querySelector<HTMLElement>('#pot')?.style.visibility).toBe('hidden');
    scene.destroy();
    expect(document.querySelector<HTMLElement>('#pot')?.style.visibility).toBe('');
  });
});
