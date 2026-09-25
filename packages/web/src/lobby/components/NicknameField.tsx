/**
 * 昵称输入框。
 *
 * ## 故意不设 `maxLength` 属性
 *
 * 浏览器/手机键盘的 `maxLength` 数的是 **UTF-16 码元**，而我们的上限是**码点**
 * （`MAX_NICKNAME_LENGTH`，见 shared/profile.ts）。设了它会有两个坏处：
 *
 * 1. 一个带 ZWJ 的 emoji（👨‍👩‍👧 是 8 个码元）会被从中间切断，得到一个残缺字形；
 * 2. 截断发生在我们的处理器**之前**，代码点截断就再也拿不到完整输入了。
 *
 * 所以长度由 `truncateByCodePoint` 在 onChange 里收，`maxLength` 一个都不设。
 * 代价是手机键盘不会显示「x/16」的计数——那个由组件自己在下面渲染。
 */

import { MAX_NICKNAME_LENGTH, truncateByCodePoint } from '@poker-room/shared';
import type { ChangeEvent, ReactNode } from 'react';

export interface NicknameFieldProps {
  readonly id: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly disabled?: boolean;
}

export function NicknameField({ id, value, onChange, disabled = false }: NicknameFieldProps): ReactNode {
  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    onChange(truncateByCodePoint(event.target.value, MAX_NICKNAME_LENGTH));
  };

  // 计数也按码点算，跟截断口径一致；用 length 的话 emoji 会显示成 2
  const codePoints = [...value].length;

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        昵称
      </label>
      <input
        id={id}
        className="field__input"
        type="text"
        value={value}
        onChange={handleChange}
        disabled={disabled}
        placeholder="怎么称呼你"
        autoComplete="nickname"
        // 关掉自动大写和拼写检查：昵称不是自然语言，手机上弹出候选词只会挡视线
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      <p className="field__counter">
        {codePoints}/{MAX_NICKNAME_LENGTH}
      </p>
    </div>
  );
}
