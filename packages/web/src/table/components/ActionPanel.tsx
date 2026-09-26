/**
 * 操作面板（M2.4，SPEC §4.4）：三颗主按钮 + 加注滑杆 + 额度输入框 + 四个快捷档位。
 *
 * ## 每个按钮亮不亮，只看服务端给的提示位
 *
 * `legal` 是服务端用**完整规则引擎**算出来的（`engine-bridge.ts` 给每个在桌的账户
 * 都算了一份），这里只是把它翻译成 disabled 属性和文案。滑杆的范围同理：
 * `minRaiseTotal` / `maxRaiseTotal` 本身就是 `betting.ts` 里
 * `currentBet + lastRaiseSize` 与 `chips + committedThisStreet` 那两条，
 * 前端照抄即可——自己按盲注再推一遍，就多一处会和引擎漂移的地方。
 *
 * ## 三颗按钮，不是四颗
 *
 * SPEC 要的是「弃牌 / 过牌-跟注 N / 加注」。中间那颗按 `callAmount` 换文案：
 * 有量要跟就写「跟注 120」，没有就写「过牌」——同一颗位置干同一件事，
 * 比并排放两颗（其中一颗永远是灰的）少一次误点。
 * 第三颗在**加不动注**（短码，`canRaise` 关着）时整颗换成「全下」，
 * 因为这时候滑杆区间是空的，抽屉里摆一排刻度只会骗人。
 *
 * ## 非法额度：标红，但仍然发得出去
 *
 * M1.6 的旧做法是「越界就不亮」，SPEC §4.4 明确要的是软提示 + 服务端判定。
 * 差别不只在手感：前端多一套判定就多一处漂移，而且漂移的方向恰好是
 * 「玩家想下、界面不让点」——那种时候人只会以为程序坏了。
 * 输入非法时 `aria-invalid` 与那句带范围的说明会亮，按钮照旧能按。
 *
 * ## 竖屏抽屉
 *
 * 竖屏（<768px）时额度那一排收进底部抽屉，默认收起，按「调整加注额度」或 R 展开。
 * 收起用的是 `hidden` 属性而不是只把高度压成 0：压在下面的东西不该还能被
 * Tab 聚焦、被读屏念到。断点和 `global.css` 里那条媒体查询是同一个数，
 * 两处要一起改（JS 要知道自己在哪个视口，CSS 才知道画成什么样）。
 * 桌面端额度那一排一直摊着，切换按钮由 CSS 隐掉。
 *
 * 验收项「抽屉展开不遮挡公共牌区」是靠**结构**保证的，不是靠调 z-index 或高度：
 * 面板在页面正常的文档流里（`TablePage` 的「行动」那张卡片，位置在桌面与底牌之后），
 * 展开就是把下面的内容往下推，永远不会浮到公共牌上面。真机上要判的是它推下去之后
 * 首屏还剩多少——那需要你在手机上看着说。
 */

import { useId, useState, type ReactNode } from 'react';

import type { Action } from '@poker-room/shared/view';

import type { LegalActionsView } from '../../net/types';
import { formatChips } from '../format';
import { raiseBounds, raiseShortcuts, snapRaise } from '../raise';
import { useIsPortrait } from '../useIsPortrait';
import { useActionHotkeys } from '../useActionHotkeys';

export interface ActionPanelProps {
  readonly legal: LegalActionsView;
  readonly handId: string;
  readonly turnVersion: number;
  /** 轮到我 && 连接在线 && 没有悬着的动作。由 `TablePage` 一次算好传进来 */
  readonly canAct: boolean;
  readonly potTotal: number;
  readonly currentBet: number;
  readonly bigBlind: number;
  readonly onAction: (action: Action) => void;
}

/** 额度草稿连着「它是哪一步的」一起存，见下面的 `stepKey` */
interface RaiseDraft {
  readonly key: string;
  readonly text: string;
}

interface DrawerState {
  readonly key: string;
  readonly open: boolean;
}

export function ActionPanel({
  legal,
  handId,
  turnVersion,
  canAct,
  potTotal,
  currentBet,
  bigBlind,
  onAction,
}: ActionPanelProps): ReactNode {
  const portrait = useIsPortrait();
  // 三处 id 关联（抽屉、滑杆的名字、额度框）。写死成常量在本页只有一份面板时没事，
  // 但 `/dev/table` 会一次摆四份，同一个 id 出现四次就是无效 HTML，
  // `aria-controls` 也会指向别人的抽屉。
  const drawerId = useId();
  const sliderLabelId = useId();
  const amountId = useId();
  // 换了一步（新的一手、或同一手里轮到了别人再轮回来）就把额度当空白处理、抽屉收回去：
  // 不然上一手敲的 500 会留在这里，看起来像「这一手也能加到 500」。
  //
  // 关键是**在渲染时按 key 解释**，而不是在 `useEffect` 里 `setState('')`：后者要先用
  // 旧值渲染一轮才修正，而「在 effect 里同步改状态」是 React 现在明确禁掉的写法。
  const stepKey = `${handId}:${turnVersion}`;
  const [draft, setDraft] = useState<RaiseDraft>({ key: stepKey, text: '' });
  const [drawer, setDrawer] = useState<DrawerState>({ key: stepKey, open: false });

  const bounds = raiseBounds(legal, bigBlind);
  const typed = draft.key === stepKey ? draft.text : '';
  const open = drawer.key === stepKey ? drawer.open : false;

  const parsed = Number.parseInt(typed, 10);
  const raiseTotal = Number.isFinite(parsed) ? parsed : bounds.min;
  const outOfRange = raiseTotal < bounds.min || raiseTotal > bounds.max;

  const canCall = legal.callAmount > 0;
  const canCheck = legal.canCheck;
  const middleReady = canCall || canCheck;
  const middleLabel = canCall ? `跟注 ${formatChips(legal.callAmount)}` : '过牌';
  const thirdLabel = legal.canRaise
    ? `加注到 ${formatChips(raiseTotal)}`
    : legal.canAllIn
      ? '全下'
      : '加注';

  const setAmount = (value: number): void => {
    setDraft({ key: stepKey, text: String(snapRaise(value, bounds)) });
  };

  const sendFold = (): void => {
    if (canAct && legal.canFold) onAction({ type: 'fold' });
  };
  const sendMiddle = (): void => {
    if (!canAct || !middleReady) return;
    onAction(canCall ? { type: 'call' } : { type: 'check' });
  };
  const sendRaise = (): void => {
    if (canAct && legal.canRaise) onAction({ type: 'raise', totalBet: raiseTotal });
  };
  const openRaise = (): void => {
    if (canAct && legal.canRaise) setDrawer({ key: stepKey, open: true });
  };
  const confirm = (): void => {
    if (legal.canRaise) sendRaise();
    else sendMiddle();
  };

  /**
   * 第三颗按钮的两种身份：能加注时是「加注到 N」（N 就是马上要送出去的总额），
   * 加不动注（短码）时整颗换成「全下」。disabled 与 onClick 一起由这个对象给，
   * 免得两处分别判 `legal.canRaise`、日后只改了一半。
   */
  const third = legal.canRaise
    ? { disabled: !canAct, onClick: sendRaise }
    : { disabled: !canAct || !legal.canAllIn, onClick: (): void => onAction({ type: 'allIn' }) };

  useActionHotkeys({
    enabled: canAct,
    onFold: sendFold,
    onCheckCall: sendMiddle,
    onOpenRaise: openRaise,
    onStep: (direction) => {
      if (!legal.canRaise) return;
      setAmount(raiseTotal + direction * bounds.step);
    },
    onConfirm: confirm,
  });

  return (
    <div className={['action-panel', open ? 'action-panel--open' : ''].filter(Boolean).join(' ')}>
      <div className="action-panel__row">
        <button
          className="btn btn--fold"
          type="button"
          disabled={!canAct || !legal.canFold}
          onClick={sendFold}
        >
          弃牌
        </button>
        <button
          className="btn btn--call"
          type="button"
          disabled={!canAct || !middleReady}
          onClick={sendMiddle}
        >
          {middleLabel}
        </button>
        <button className="btn btn--raise" type="button" disabled={third.disabled} onClick={third.onClick}>
          {thirdLabel}
        </button>
      </div>

      {legal.canRaise && (
        <>
          <button
            className="action-panel__toggle"
            type="button"
            aria-expanded={open}
            aria-controls={drawerId}
            onClick={() => setDrawer({ key: stepKey, open: !open })}
          >
            {open ? '收起加注额度' : '调整加注额度'}
          </button>

          <div className="action-panel__raise" id={drawerId} hidden={portrait && !open}>
            <span className="field__label" id={sliderLabelId}>
              加注额度
            </span>
            <input
              aria-labelledby={sliderLabelId}
              className="action-panel__slider"
              max={bounds.max}
              min={bounds.min}
              step={bounds.step}
              type="range"
              value={raiseTotal}
              onChange={(event) => setAmount(Number(event.currentTarget.value))}
            />
            <label className="field action-panel__amount" htmlFor={amountId}>
              加注到（总额）
              <input
                aria-invalid={outOfRange}
                className={`field__input${outOfRange ? ' field__input--invalid' : ''}`}
                id={amountId}
                inputMode="numeric"
                max={bounds.max}
                min={bounds.min}
                step={bounds.step}
                type="number"
                value={raiseTotal}
                onChange={(event) => setDraft({ key: stepKey, text: event.currentTarget.value })}
              />
            </label>

            {outOfRange && (
              <p className="action-panel__warn">
                这个额度不在服务端允许的 {formatChips(bounds.min)} ~ {formatChips(bounds.max)} 之间。
                仍然会替你发出去，由服务端判定。
              </p>
            )}

            <div className="action-panel__quick">
              {raiseShortcuts(bounds, { potTotal, currentBet }).map((shortcut) => (
                <button
                  className="action-panel__chip"
                  key={shortcut.label}
                  type="button"
                  disabled={!canAct}
                  onClick={() => setAmount(shortcut.total)}
                >
                  {shortcut.label}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
