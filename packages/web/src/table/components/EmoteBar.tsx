/**
 * 表情条。
 *
 * 只有四个固定表情，和服务端 `C2S` 里 `emoji` 允许的值一一对应——
 * 不是「任意文本聊天」：本项目刻意不做自由输入（SPEC §1.2 的边界，
 * 也省掉了审核、敏感词、跨语言这些不属于牌桌的东西）。
 *
 * 表情是广播事件，别人看到的是一条 `player:emoji`；这里只负责上送。
 */

import type { ReactNode } from 'react';

/** 服务端 `C2S` 里允许的四个表情 id。`protocol.ts` 没给它单独起名，这里镜像一份 */
export type EmoteKind = 'fold-face' | 'laugh' | 'angry' | 'wave';

type Emoji = EmoteKind;

const EMOTES: readonly { readonly emoji: Emoji; readonly label: string }[] = [
  { emoji: 'fold-face', label: '无奈' },
  { emoji: 'laugh', label: '大笑' },
  { emoji: 'angry', label: '生气' },
  { emoji: 'wave', label: '挥手' },
];

/**
 * 服务端那条 `player:emoji` 里的 id → 给人看的那句话。接收端（`useSeatEmotes`）和发送端
 * （下面这排按钮）共用这一张表，所以「我点大笑、别人看到无奈」这类错构造不出来。
 *
 * 参数是 `string` 而不是 `Emoji`：协议里 `emoji` 的类型就是 `string`（服务端只保证是文本，
 * `protocol.ts` 没有收窄），查不到就返回 `undefined`，由调用方当作"没收到"。
 * 这里刻意不做兜底显示原文：未知 id 落到牌桌上就是一段没人认领的文字。
 */
const LABELS = new Map<string, string>(EMOTES.map((entry) => [entry.emoji, entry.label]));

export function emoteLabel(emoji: string): string | undefined {
  return LABELS.get(emoji);
}

export interface EmoteBarProps {
  readonly disabled: boolean;
  readonly onEmote: (emoji: Emoji) => void;
  /** 工具条上那颗「表情」用 `aria-controls` 指到这里，所以这一条得有自己的 id */
  readonly id?: string;
  /**
   * 收起状态。给的是 `hidden` 属性而不是 `display: none` 的样式：
   * 压在下面的四颗钮不该还能被 Tab 聚焦、被读屏念到。
   * `.emote-bar` 自己声明了 `display: flex`，会把 UA 那条 `[hidden] { display: none }` 盖掉，
   * 所以 CSS 侧配了 `.emote-bar[hidden]` 把它收回来（见 global.css）。
   */
  readonly hidden?: boolean;
}

export function EmoteBar({ disabled, onEmote, id, hidden }: EmoteBarProps): ReactNode {
  return (
    <div className="emote-bar" id={id} hidden={hidden} role="group" aria-label="表情">
      {EMOTES.map((entry) => (
        <button
          className="btn btn--ghost emote-bar__item"
          type="button"
          key={entry.emoji}
          disabled={disabled}
          onClick={() => onEmote(entry.emoji)}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}
