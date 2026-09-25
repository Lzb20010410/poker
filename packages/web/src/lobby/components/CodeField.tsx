/**
 * 配对码输入框 —— 对应验收项「配对码输入自动转大写，非法字符被过滤」。
 *
 * 收敛逻辑全在 shared 的 `filterPairingInput` 里（纯函数，能脱离 jsdom 单测），
 * 本组件只负责把它接到受控 input 上。
 *
 * ## 两个不能想当然的地方
 *
 * 1. **不设 `maxLength`。** 浏览器的 `maxLength` 在 onChange **之前**就把字符串剪短，
 *    而 `filterPairingInput` 的正确顺序是「先过滤非法字符、再截断」。
 *    如果先被浏览器剪成 6 个字符，粘贴 `IIIIIIABC` 就会先变成 `IIIIII`、
 *    再被过滤成空——玩家明明敲对了码，输入框里却什么都没有。
 *    shared 那边有一条专门的顺序回归测试盯着这件事。
 * 2. **`value` 永远是收敛后的结果。** 受控组件回填的是 state，
 *    所以非法字符不只是「提交时报错」，而是根本打不进去。
 */

import { filterPairingInput, isValidPairingCode, PAIRING_CODE_LENGTH } from '@poker-room/shared';
import type { ChangeEvent, KeyboardEvent, ReactNode } from 'react';

export interface CodeFieldProps {
  readonly id: string;
  readonly value: string;
  readonly onChange: (next: string) => void;
  /** 敲回车时触发。手机上「前往」键应该等价于点「加入」 */
  readonly onSubmit?: () => void;
  readonly disabled?: boolean;
}

export function CodeField({ id, value, onChange, onSubmit, disabled = false }: CodeFieldProps): ReactNode {
  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    onChange(filterPairingInput(event.target.value));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    onSubmit?.();
  };

  const complete = isValidPairingCode(value);

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        配对码
      </label>
      <input
        id={id}
        className={`field__input field__input--code${complete ? ' field__input--valid' : ''}`}
        type="text"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder="6 位，例如 K7QM3D"
        autoComplete="off"
        // 手机上弹出字母键盘并默认大写：配对码只有大写字母和数字
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        inputMode="text"
        aria-invalid={!complete && value.length > 0}
        aria-describedby={`${id}-hint`}
      />
      <p className="field__hint" id={`${id}-hint`}>
        {value.length === 0
          ? `不含易混淆的 I O 0 1，共 ${PAIRING_CODE_LENGTH} 位`
          : complete
            ? '配对码格式正确'
            : `还差 ${PAIRING_CODE_LENGTH - [...value].length} 位`}
      </p>
    </div>
  );
}
