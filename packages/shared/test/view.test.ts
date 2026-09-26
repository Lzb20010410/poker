/**
 * `shared/view` 入口的边界契约（DECISIONS.md D-019）。
 *
 * 根入口 `index.ts` 是给服务端的：它 `export * from './engine'`，把评估器连带
 * CommonJS 的 pokersolver 一起拖出来，打包器摇不掉。`view.ts` 是给前端的：
 * 只准有"看懂牌桌"要用的东西。
 *
 * `scripts/check-arch.mjs` 规则 7 已经在文件系统层面扫过导入闭包；这里再从
 * **模块导出面**挡一道：将来谁在 view 里补一句 `export * from './engine'`，
 * 闭包扫描和这个测试会同时变红，而前端打包要等到看 bundle 才会发现。
 */
import { describe, expect, it } from 'vitest';

import * as view from '../src/view';

/** 前端确实需要的东西：漏了它，`packages/web` 就直接编译不过 */
const REQUIRED = [
  'PAIRING_ALPHABET',
  'filterPairingInput',
  'normalizePairingCode',
  'isValidPairingCode',
  'rankLabel',
  'suitSymbol',
  'SUITS',
  'RANKS',
  'PHASES',
  'DEFAULT_TABLE_CONFIG',
  'MAX_NICKNAME_LENGTH',
  'sanitizeNickname',
  'cryptoRandom',
  'randomInt',
];

/** 只有服务端要的规则引擎出口。出现在 view 的导出面里就等于边界漏了 */
const FORBIDDEN = [
  'createDeck',
  'shuffle',
  'Deck',
  'evaluate7',
  'createTable',
  'applyPlayerAction',
  'startTable',
  'tickTable',
  'rebuyPlayer',
];

describe('shared/view 的导出面', () => {
  const exported = Object.keys(view);

  it('把前端要用的纯函数和常量都带出来了', () => {
    for (const name of REQUIRED) expect(exported).toContain(name);
  });

  it('一个规则引擎的出口都没带（pokersolver 因此进不了浏览器包）', () => {
    for (const name of FORBIDDEN) expect(exported).not.toContain(name);
  });

  it('导出面里没有任何名字来自 engine 目录（random 除外）', async () => {
    const engine = await import('../src/engine');
    const allowed = new Set(['cryptoRandom', 'randomInt']);
    const leaked = Object.keys(engine).filter((name) => exported.includes(name) && !allowed.has(name));
    expect(leaked).toEqual([]);
  });
});
