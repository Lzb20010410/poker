/**
 * M2.1 牌面资产映射测试。
 *
 * ## 为什么值得单独一层
 *
 * 52 张牌是**文件名查表**得到的（`11` → `jack`、`s` → `spades`）。这类映射的失败方式很讨厌：
 * 类型照样通过、构建照样绿，只有玩家看到"黑桃 K 画成了黑桃 Q"才发现。而它恰恰是前端
 * 唯一一处"我们自己拼出来的键"——服务端和引擎都拿着结构化的 `Card`，不存在这个风险。
 * 所以这里不看文件名对不对，只看**牌面内容对不对得上这张牌**。
 *
 * ## 为什么测试直接读磁盘，而不是只走模块的 glob
 *
 * 模块拿文件靠 `import.meta.glob`，如果那个 pattern 写错（比如漏了子目录、或者将来加牌时
 * 放错目录），只走模块的测试会拿到一份"自洽的少数派"照样全绿。磁盘是独立裁判，
 * 所以第 1 条用例把两边的清单逐字对齐 —— 这是其余各条有分辨力的前提。
 * （同一条教训在 M1 的 W7/W8 变异探针里踩过一次，见 DECISIONS.md D-022。）
 */

import { gzipSync } from 'node:zlib';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { RANKS, SUITS, rankLabel, type Card } from '@poker-room/shared/view';

import { CARD_FACE_FILES, cardFaceDataUri, cardFaceSvg } from '../src/assets/cardFaces';

/**
 * 资产目录。测试从**这里**读，跟模块的 glob 是两个独立来源。
 *
 * 用 cwd 而不是 `import.meta.url`：jsdom 环境下 vite 会把后者改写成 `self.location`
 * （实测变成 `new URL("/src/assets/cards", self.location)`），拿到的根本不是文件路径。
 * vitest 的 web 项目以 `packages/web` 为 root 跑，所以相对路径 `src/assets/cards` 就是它。
 */
const CARDS_DIR = resolve('src/assets/cards');

/** 磁盘上真实存在的牌面文件名 */
function filesOnDisk(): string[] {
  // 目录找不到时必须当场说清楚，否则下面 `toHaveLength(52)` 会报成"牌少了"，
  // 而真正的原因是测试跑在了错的目录下。
  if (!existsSync(CARDS_DIR)) throw new Error(`牌面目录不存在：${CARDS_DIR}（cwd=${process.cwd()}）`);
  return readdirSync(CARDS_DIR)
    .filter((name) => name.endsWith('.svg'))
    .sort();
}

/** 抽出 SVG 里所有可见文字（角标点数就藏在 `<tspan>` 里） */
function visibleText(svg: string): string {
  return [...svg.matchAll(/<tspan\b[\s\S]*?>([\s\S]*?)<\/tspan>/g)]
    .map((match) => match[1]?.replace(/<[^>]*>/g, '') ?? '')
    .join('');
}

function allCards(): Card[] {
  return RANKS.flatMap((rank) => SUITS.map((suit) => ({ rank, suit })));
}

describe('牌面资产映射', () => {
  it('模块认识的 52 张牌与磁盘上的文件逐字相等，且不含大小王与牌背', () => {
    const disk = filesOnDisk();
    // 独立裁判先证明"这批文件本身是完整的一副牌"，否则下面的对齐断言可能是两份同样的残缺。
    expect(disk).toHaveLength(52);
    expect(disk.filter((name) => /joker|back/i.test(name))).toEqual([]);
    expect([...CARD_FACE_FILES].sort()).toEqual(disk);
  });

  it('每张牌都取得到牌面，且 52 张两两不同（防住查表串号）', () => {
    const cards = allCards();
    expect(cards).toHaveLength(52);
    const byFile = new Map<string, string>();
    for (const card of cards) {
      const svg = cardFaceSvg(card);
      expect(svg.length, `${rankLabel(card.rank)}${card.suit} 拿不到牌面`).toBeGreaterThan(1000);
      byFile.set(svg, `${rankLabel(card.rank)}-${card.suit}`);
    }
    // 两张不同的牌解析到同一份 SVG = 玩起来就是"我的 A 和你的 A 长得不一样"或反过来。
    expect(byFile.size).toBe(52);
  });

  it('牌面上的角标文字就是这张牌的点数', () => {
    for (const card of allCards()) {
      const label = rankLabel(card.rank);
      const text = visibleText(cardFaceSvg(card));
      // 角标在左上与右下各印一次（后者旋转 180°），所以期望值至少出现两次；
      // `10` 在上游被拆成 `1` 和 `0` 两个 tspan，拼起来正好是 "1010"。
      expect(text, `角标里没有 ${label}，实际是 ${JSON.stringify(text)}`).toContain(label);
      expect(text.split(label).length - 1).toBeGreaterThanOrEqual(2);
    }
  });

  it('红黑两色按花色正确分组（这一条能抓出 suits 词表写反）', () => {
    for (const card of allCards()) {
      const isRed = card.suit === 'h' || card.suit === 'd';
      // 实测：这副牌的红字色值是 #df0000，26 张红牌全含、26 张黑牌全不含，无例外。
      expect(/df0000/i.test(cardFaceSvg(card)), `${rankLabel(card.rank)}${card.suit} 颜色不符`).toBe(
        isRed,
      );
    }
  });

  it('data URI 能原样解码回牌面源码，且同一张牌重复取到的是同一个字符串', () => {
    for (const card of allCards()) {
      const uri = cardFaceDataUri(card);
      expect(uri.startsWith('data:image/svg+xml,')).toBe(true);
      const encoded = uri.slice('data:image/svg+xml,'.length);
      // 裸 `#` 会被当成 fragment 分隔符，牌面里的 `fill:#FFFFFF` 一出现就截断整张图。
      expect(encoded).not.toContain('#');
      // 反过来，`%` 必须是合法转义的一部分：吃掉所有 `%XX` 之后不该还剩裸 `%`。
      expect(encoded.replace(/%[0-9A-F]{2}/g, '')).not.toContain('%');
      expect(decodeURIComponent(encoded)).toBe(cardFaceSvg(card));
      // 引用相等：渲染路径上每帧都会取牌，每次现造一条几十 KB 的串会直接打爆 GC。
      expect(cardFaceDataUri(card)).toBe(uri);
    }
  });

  it('牌面总体积在 M2.1 预算内（gzip 后 < 300KB）', () => {
    const total = filesOnDisk().reduce((sum, name) => {
      const svg = readFileSync(`${CARDS_DIR}/${name}`, 'utf8');
      return sum + gzipSync(svg, { level: 9 }).length;
    }, 0);
    // 逐张压缩再相加，比"整包一次 gzip"更保守（拿不到跨文件的字典收益），
    // 这样这条门测的是"资产本身有多重"，而不是"打包器顺手压了多少"。
    expect(total).toBeLessThan(300 * 1024);
  });
});
