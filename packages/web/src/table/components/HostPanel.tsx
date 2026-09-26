/**
 * 房主面板：牌桌配置 + 开始牌局。
 *
 * ## 只有房主能看到
 *
 * 判定读的是 `snapshot.isHost`（服务端算出来的房主，`chooseHost` 会在房主离开后
 * 顺位移交给下一个人），不是「我创建了这个房间所以永远是我」。
 *
 * ## 配置只在 IDLE 阶段能改
 *
 * 服务端在 `setTableConfig` 里用 `CONFIG_LOCKED` 挡非等待阶段，这里同样先把表单禁用：
 * 让玩家点一个注定被拒的按钮是坏体验，但**禁用不是判定**——真正的规则还在服务端。
 *
 * ## 大盲是从属字段
 *
 * `bigBlind` 恒等于 `2 × smallBlind`（RULES-SPEC 的定义），所以它显示成只读，
 * 上送时按当前小盲算出来一起发。留一个能各填各的框，等于留一个能填出非法组合的入口。
 * `minPlayersToStart` 本项目固定 2，同理不做输入框。
 *
 * ## 桌布是这一页唯一的纯展示项
 *
 * 它和盲注一样住在 `TableConfig` 里，为的是「房主挑一次，所有人的桌子一起变」：
 * 若做成各人本地偏好，同一局里两个人看到的桌面颜色就不一样了，而 SPEC §4.6 写的是房主可选。
 * 代价是它跟着配置一起被 `CONFIG_LOCKED` 锁住——**开一局之后要换桌布得等回到等待阶段**，
 * 中途换会让正在看的玩家在两手牌之间看到颜色跳掉。
 *
 * 输入框用 `defaultValue` 而不是受控 state：值由服务端确认后回流，
 * 保存失败时界面自然回到服务端的真相，不需要额外写「回滚」逻辑。
 */

import type { ReactNode } from 'react';

import { FELT_VALUES, type FeltColor, type MaxPlayers, type TableConfig } from '@poker-room/shared/view';

import { FELT_COLORS, FELT_LABELS } from '../../assets/pokerTable';
import type { RoomSnapshot } from '../../net/types';

export interface HostPanelProps {
  readonly snapshot: RoomSnapshot;
  /** 断线期间为 true */
  readonly disabled: boolean;
  readonly onStart: () => void;
  readonly onSaveConfig: (config: Partial<TableConfig>) => void;
}

function readInt(form: FormData, name: string): number {
  const raw = form.get(name);
  return typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
}

/**
 * `TableConfig.maxPlayers` 在协议里是 `2 | 3 | ... | 8` 而不是 `number`，
 * 所以从输入框读回来的数字必须先过这道收窄才能进 `C2S`。
 *
 * 越界时**不上送这个字段**（`Partial` 里少了它就表示「这项不改」），
 * 而不是替玩家把它改成别的值，也不是硬塞一个谎言进类型系统：
 * 输入框本身有 `min` / `max`，真浏览器里表单会被原生校验拦住；
 * 走到这里说明是绕过原生校验的路径（测试、辅助技术），那就不改这一项最安全。
 * 无论哪种情况，服务端都会再判一次——界面从不替它做决定。
 */
const MAX_PLAYERS_VALUES: readonly number[] = [2, 3, 4, 5, 6, 7, 8];

function readMaxPlayers(form: FormData): MaxPlayers | undefined {
  const value = readInt(form, 'maxPlayers');
  return MAX_PLAYERS_VALUES.includes(value) ? (value as MaxPlayers) : undefined;
}

/**
 * 桌布档位的名单直接抄 `@poker-room/shared` 的 `FELT_VALUES`——引擎 `setTableConfig`
 * 判的就是同一份，两边各列一遍迟早会漂。
 *
 * 读回来仍不在名单上时和 `maxPlayers` 一样**不上送这一项**（见上面那段），理由也一致：
 * 走到这里说明绕过了原生 radio 约束，那么「这项不改」比替房主挑一个颜色安全。
 */
function readFelt(form: FormData): FeltColor | undefined {
  const raw = form.get('felt');
  return typeof raw === 'string' && (FELT_VALUES as readonly string[]).includes(raw)
    ? (raw as FeltColor)
    : undefined;
}

export function HostPanel({ snapshot, disabled, onStart, onSaveConfig }: HostPanelProps): ReactNode {
  if (!snapshot.isHost) return null;

  const { config } = snapshot;
  const editable = snapshot.phase === 'IDLE' && !disabled;
  const seatedCount = snapshot.players.filter((player) => player.seatIndex !== null).length;

  return (
    <section className="card card--accent card--wide">
      <h3 className="card__title">房主设置</h3>

      <form
        className="host-form"
        aria-label="牌桌配置"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const smallBlind = readInt(form, 'smallBlind');
          const startingChips = readInt(form, 'startingChips');
          const actionTimeoutSec = readInt(form, 'actionTimeoutSec');
          const maxPlayers = readMaxPlayers(form);
          const felt = readFelt(form);
          onSaveConfig({
            smallBlind,
            // 大盲跟着小盲走，前端不给人填出 10 / 50 这种组合的机会
            bigBlind: smallBlind * 2,
            startingChips,
            actionTimeoutSec,
            ...(maxPlayers === undefined ? {} : { maxPlayers }),
            ...(felt === undefined ? {} : { felt }),
          });
        }}
      >
        <label className="field" htmlFor="config-small-blind">
          小盲
          <input className="field__input" id="config-small-blind" name="smallBlind" type="number" min={1} step={1} defaultValue={config.smallBlind} disabled={!editable} />
        </label>
        <label className="field" htmlFor="config-big-blind">
          大盲（自动 = 2 × 小盲）
          <input className="field__input" id="config-big-blind" type="number" value={config.smallBlind * 2} readOnly disabled />
        </label>
        <label className="field" htmlFor="config-starting-chips">
          起始筹码
          <input className="field__input" id="config-starting-chips" name="startingChips" type="number" min={1} step={1} defaultValue={config.startingChips} disabled={!editable} />
        </label>
        <label className="field" htmlFor="config-max-players">
          人数上限
          <input className="field__input" id="config-max-players" name="maxPlayers" type="number" min={2} max={8} step={1} defaultValue={config.maxPlayers} disabled={!editable} />
        </label>
        <label className="field" htmlFor="config-timeout">
          行动超时（秒）
          <input className="field__input" id="config-timeout" name="actionTimeoutSec" type="number" min={5} step={1} defaultValue={config.actionTimeoutSec} disabled={!editable} />
        </label>
        <fieldset className="field field--choices" disabled={!editable}>
          <legend className="field__label">桌布</legend>
          <div className="field__choices">
            {FELT_VALUES.map((felt) => (
              <label className="choice" htmlFor={`config-felt-${felt}`} key={felt}>
                <input
                  className="choice__input"
                  id={`config-felt-${felt}`}
                  name="felt"
                  type="radio"
                  value={felt}
                  defaultChecked={config.felt === felt}
                />
                <span className="choice__swatch" style={{ background: FELT_COLORS[felt] }} aria-hidden="true" />
                <span className="choice__text">{FELT_LABELS[felt]}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <button className="btn btn--ghost" type="submit" disabled={!editable}>
          保存配置
        </button>
      </form>

      <div className="btn-row">
        <button className="btn btn--primary" type="button" disabled={!editable} onClick={onStart}>
          开始牌局
        </button>
        <span className="card__subtitle">
          已入座 {seatedCount} 人，至少 {config.minPlayersToStart} 人才能开局。开局后配置会被锁住。
        </span>
      </div>
    </section>
  );
}
