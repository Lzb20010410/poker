/**
 * 牌桌上的显示口径（M2.3）：昵称怎么省略、筹码怎么打逗号、阶段叫什么名字。
 *
 * ## 为什么单拎一个文件
 *
 * 这几条都不是"组件的事"而是"给人读成什么样的事"：整屏有八格座位在同时用它们，
 * 而 `table.test.tsx` / `seatContent.test.tsx` / `/dev/table` 三处都要按同一口径断言。
 * 写在各组件里就会长成几份略有出入的实现。
 */

import { truncateByCodePoint, type Phase } from '@poker-room/shared/view';

/** SPEC §4.3「昵称最多 8 字，超出省略」 */
const NICKNAME_MAX_VISIBLE = 8;

/**
 * 省略到 8 个字码，超出补一个省略号。
 *
 * 按**码点**数而不是 `String.length`：昵称里一个 👨‍👩‍👧 是 8 个 UTF-16 单元，
 * 用 `slice` 会从代理对中间劈开，屏幕上出现一个豆腐块。共享层那个截断函数就是为
 * 这件事写的（`profile.ts`），这里复用而不是再来一遍。
 *
 * 窄座位框（竖屏满桌）连 8 个字码也放不下，那一层由 CSS 的 `text-overflow` 兜住，
 * 完整名字始终在 `title` 里。
 */
export function displayNickname(nickname: string): string {
  const shown = truncateByCodePoint(nickname, NICKNAME_MAX_VISIBLE);
  return shown === nickname ? nickname : `${shown}…`;
}

/**
 * 千分位。写死 `en-US` 而不是跟随设备：德语环境会把 1234567 排成 `1.234.567`，
 * 而牌桌上 `1,234,567` 是通用写法，逗号也不容易被看成小数点。
 */
export function formatChips(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * 阶段的中文名。牌桌页与回放器都要在角标上写一次，写两遍就会有一遍漏掉新阶段。
 *
 * 只用于显示：阶段该怎么走是引擎的事，这里不参与任何判定。
 */
const PHASE_LABELS: Record<Phase, string> = {
  IDLE: '等待开局',
  DEALING: '发牌中',
  PREFLOP: '翻牌前',
  FLOP: '翻牌圈',
  TURN: '转牌圈',
  RIVER: '河牌圈',
  SHOWDOWN: '摊牌',
  HAND_END: '本手结束',
};

export function phaseLabel(phase: Phase): string {
  return PHASE_LABELS[phase];
}
