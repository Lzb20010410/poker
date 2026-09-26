/**
 * 操作面板的键盘快捷键（M2.4，SPEC §4.4）：F 弃牌、C 过牌/跟注、R 加注、↑↓ 调额度、Enter 确认。
 *
 * ## 为什么监听挂在 `window` 而不是某个容器上
 *
 * 快捷键要在**没聚焦到任何控件**的时候也生效——玩家点完一张牌、焦点还在座位上，
 * 这时候按 F 就该弃牌。挂在容器上就得先让人聚焦到面板，等于没有。
 *
 * ## 三条「不抢键」的规则，一条都不能少
 *
 * 1. **输入控件里不打字除外**：焦点在 `input / select / textarea / contenteditable` 时，
 *    字母和箭头都是内容的一部分。手机上软键盘吐出来的就是普通 `keydown`，
 *    没有这条规则，在额度框里改个数字就能把自己弃牌了。
 *    只留 Enter：数字框里的 Enter 本来就是「提交这个数」。
 * 2. **带修饰键不算**：`Ctrl+F` 是浏览器的查找，`Cmd+R` 是刷新，都不该被抢。
 * 3. **焦点在按钮上时 Enter 交给浏览器**：Enter 已经会激活那颗按钮，
 *    这里再送一次就是两笔动作。
 *
 * `enabled` 为 false（没轮到我、断线、上一步还悬着）时连监听都不挂：
 * 快捷键和按钮是同一个门，不能出现「按钮灰着但键盘还通」的第二个入口。
 */

import { useEffect, useRef } from 'react';

export interface ActionHotkeys {
  /** 轮到我 + 连接活着 + 没有悬着的动作 */
  readonly enabled: boolean;
  readonly onFold: () => void;
  readonly onCheckCall: () => void;
  readonly onOpenRaise: () => void;
  readonly onStep: (direction: 1 | -1) => void;
  readonly onConfirm: () => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target.isContentEditable;
}

function isButtonTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.tagName === 'BUTTON';
}

export function useActionHotkeys(hotkeys: ActionHotkeys): void {
  // 回调每帧都是新的（面板里那些 lambda），但监听只该在 enabled 变化时换一次。
  // 所以处理函数读的是 ref 里的最新一份，而不是闭包捕获的那一份。
  const latest = useRef(hotkeys);
  useEffect(() => {
    latest.current = hotkeys;
  });

  const { enabled } = hotkeys;
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const keys = latest.current;
      const typing = isTypingTarget(event.target);

      switch (event.key) {
        case 'f':
        case 'F':
          if (typing) return;
          keys.onFold();
          break;
        case 'c':
        case 'C':
          if (typing) return;
          keys.onCheckCall();
          break;
        case 'r':
        case 'R':
          if (typing) return;
          keys.onOpenRaise();
          break;
        case 'ArrowUp':
        case 'ArrowDown':
          // 数字框和滑杆自己认识方向键，让它们按原生步长走
          if (typing) return;
          event.preventDefault(); // 否则整页跟着上下滚
          keys.onStep(event.key === 'ArrowUp' ? 1 : -1);
          break;
        case 'Enter':
          if (isButtonTarget(event.target)) return;
          event.preventDefault();
          keys.onConfirm();
          break;
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [enabled]);
}
