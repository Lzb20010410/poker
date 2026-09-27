/**
 * 页头那个音效开关（M4.2 验收①的可见部分）。
 *
 * 文案直接写状态（`音效：开` / `音效：关`），不靠图标：玩家扫一眼就知道现在响不响，
 * 也不必再配 `aria-pressed`——那会让读屏软件把同一件事说两遍（"音效：开，已按下"）。
 *
 * 为什么在页头而不是设置页：这是**这一局**要用的开关，牌桌右上角（页头）是手机上
 * 唯一不用离开牌桌就够得着的地方。而它放在 `AppShell` 里，大厅和等待室也一并有了——
 * 玩家可以在进桌之前先试一声。
 */

import type { ReactNode } from 'react';

import { useSound } from '../state/SoundContext';

export function SoundToggle(): ReactNode {
  const { muted, toggleMuted } = useSound();
  return (
    <button type="button" className="btn app__sound" onClick={toggleMuted}>
      {muted ? '音效：关' : '音效：开'}
    </button>
  );
}
