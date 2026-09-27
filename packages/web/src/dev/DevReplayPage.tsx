/**
 * `/dev/replay` —— M3.2 状态回放器：**不连服务端**，用硬编码的帧序列驱动整套动画。
 *
 * ## 为什么先有这一页才谈得上调动画
 *
 * `TASKS.md` 在 M3 开头写着「必须先做 M3.2 回放器再做后面的动画」。理由很实在：
 * 一手牌要凑齐两三个人、押注顺序对了才会出现「三人边池 + 河牌 all-in」那种最难的画面，
 * 而调时长要改十几次代码。没有这一页，每次看动画都得先攒一桌人。
 * 现在它是 M3.3~M3.5 全部验收的仪器：8 人发牌够不够利落、筹码飞得重不重、
 * 摊牌那几段顺序对不对，都是在这里一眼一眼看出来的。
 *
 * ## 这里没有任何规则
 *
 * 帧来自 `replayScript.ts`：那是一份**誊写**（谁下多少、谁赢哪个池，全是脚本作者填的数），
 * 本文件只做三件事——把这一帧的终态快照摆上画面、把同一批到达的事件交给导演、
 * 把节奏握在播放键上。AGENTS.md 的铁律（规则只住在 `shared/engine`）在这里同样成立：
 * 回放器不 import 引擎，也不 import 连接层。
 *
 * ## 一帧 = 一次 patch，不是若干个事件
 *
 * `snapshot` 一次到位、`events` 成批排队，和线上一条 patch 与其后的广播同形
 * （见 `replayScript.ts` 文件头）。所以这里的积压深度、按钮变灰的时长，
 * 与线上是同一件事——这正是回放器存在的意义。
 *
 * 坐标不在这个循环里：飞行落点是在动画开播那一刻从 DOM 量的（`anim/scene.ts`），
 * 而座位几何只随视口与人数变，不随筹码变，所以同批入队不会量到旧位置。
 *
 * ## 连播的节奏：等队列空，再走下一帧
 *
 * 见下面那条 effect。按固定毫秒数切帧是最初的写法，也是最坏的写法——牌还在飞就盖上
 * 下一份终态，玩家看到的是两帧叠在一起，那正是 SPEC §3.1 花整节消除的割裂感。
 *
 * ## 「队列 N 段」那个数字是给人盯的，不是装饰
 *
 * `ANIM_BACKLOG_LIMIT`（SPEC §3.1）是**按段**数的，所以这一行报的是**当前在队**的段数，
 * 它天生超不过上限：第 13 段一进来，整条队列当场清空、画面直接落终态（`queue.ts` 的 `push`）。
 * 上限从 5 抬到 12 是为了让"三个池依次派彩"真的播得出来——那份结算 patch 天生 6 段
 * （行动 1 + 亮牌 1 + 每池 1 + 本手结束 1），在 5 之下它会被整队作废。取舍记在 D-035 与 D-036。
 * 哪几帧最重，`test/devReplay.test.ts` 把它逐帧钉成了一份清单：改脚本时哪一帧变重了，那里当场变红。
 *
 * 所以这一页现在能替你回答一个问题：**积压十几秒你受不受得了**。三个池那一帧大概 7 秒
 * （派彩 1.2s ×3 + 亮牌 0.5s ×3 + 结算），这期间按钮是灰的，「跳过动画」一直可点。
 * 眼睛在这里判，不在代码里猜。
 *
 * ## 换场景 / 重来：整棵重挂，不写命令式的 reset
 *
 * 一帧一帧往回倒没有意义（动画已经播过了），而手动清队列 + 清气泡 + 清增量基线
 * 是三处容易漏一处的状态。所以这两颗按钮都只是换 React 的 `key`：
 * 新组件自带新导演、新队列、新基线，旧的在卸载时 `flush` 收摊。
 * 为什么是 `flush` 而不是 `destroy`，见 `anim/useAnimDirector.ts` 文件头。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { createAnimDirector } from '../anim/director';
import { readAnimEnv } from '../anim/env';
import { ANIM_BACKLOG_LIMIT } from '../anim/queue';
import { ANIM_SPEED_FAST, ANIM_SPEED_NORMAL, useAnimQueueState, useAnimRig, useRevealAnimation } from '../anim/rig';
import type { LegalActionsView, RoomSnapshot } from '../net/types';
import { ActionPanel } from '../table/components/ActionPanel';
import { AnimLayer } from '../table/components/AnimLayer';
import { CardRow } from '../table/components/CardView';
import { ShowdownPanel } from '../table/components/ShowdownPanel';
import { TableStage } from '../table/components/TableStage';
import { phaseLabel } from '../table/format';
import { useCountdown } from '../table/useCountdown';
import { useSeatEmoteSink } from '../table/useSeatEmotes';
import { compileScenario, stampClock, type ReplayFrame, type ReplayScenario } from './replayScript';
import { REPLAY_SCENARIOS } from './replayScenarios';

/** 一段动画播完到下一帧到达之间的呼吸。太短像幻灯片，太长像卡住 */
const FRAME_DWELL_MS = 320;

/** 这一页不接受操作：回放器没有服务端，点了也没人判 */
const noop = (): void => {
  /* 无连接可发 */
};

/** 没有「我」这一行时的兜底（编译层保证有，这里只为类型收窄） */
const NOTHING_LEGAL: LegalActionsView = {
  canFold: false,
  canCheck: false,
  callAmount: 0,
  canRaise: false,
  minRaiseTotal: 0,
  maxRaiseTotal: 0,
  canAllIn: false,
};

/** 下标 → 那一项。本页的下标只由本页推进，越界只可能是脚本本身空了——那是数据错误，抛出来给人看 */
function at<T>(rows: readonly T[], index: number, what: string): T {
  const row = rows[index];
  if (row === undefined) throw new Error(`回放${what}的下标 ${String(index)} 越界`);
  return row;
}

interface Position {
  readonly index: number;
  readonly snapshot: RoomSnapshot;
}

function ReplayPlayer({ scenario, onRestart }: { scenario: ReplayScenario; onRestart: () => void }): ReactNode {
  const { frames } = scenario;
  const rig = useAnimRig();
  const director = useMemo(() => createAnimDirector({ renderer: rig.renderer, env: readAnimEnv }), [rig.renderer]);
  const { queue } = director;
  const animState = useAnimQueueState(queue);
  /** 气泡走的是真接收端（`useSeatEmoteSink`），不是本页自己写的一套 TTL */
  const { emotes, emit } = useSeatEmoteSink();

  const [pos, setPos] = useState<Position>(() => ({ index: 0, snapshot: stampClock(at(frames, 0, '帧'), Date.now()) }));
  const [playing, setPlaying] = useState(false);
  const { snapshot, index } = pos;

  /**
   * 喂一帧的事件。
   *
   * 表情单独挑出来交给气泡，其余全给导演——和线上那条 `connection.onEvent` 同一处分流
   * （`useSeatEmotes` 认 `player:emoji`，`planEvent` 对它返回 `null`）。
   * 刻意不在编译层预先分组：那等于绕开总线，「某类事件在总线上被漏掉」这类错就再也看不见。
   */
  const feed = useCallback(
    (frame: ReplayFrame): void => {
      for (const event of frame.events) {
        if (event.t === 'player:emoji') {
          emit(event.seatIndex, event.emoji);
          continue;
        }
        director.handle(event);
      }
    },
    [emit, director],
  );

  /** 落到第 `target` 帧：终态一次到位，事件按那一批到达 */
  const goTo = useCallback(
    (target: number): void => {
      const frame = at(frames, target, '帧');
      // 截止时刻在这里换算，不在编译时：页面开着十分钟再播，倒计时仍然是满的
      setPos({ index: target, snapshot: stampClock(frame, Date.now()) });
      feed(frame);
    },
    [frames, feed],
  );

  /**
   * 挂载时把第一帧的事件走一遍。
   *
   * 只喂事件、不动 `pos`：初始那份 state 已经是「第 0 帧 + 当场换算好的时钟」，
   * 而 React 也不允许在 effect 体里同步 setState（会白多跑一轮渲染）。
   *
   * 现在这三个场景的第一帧都是「空桌」（没有事件），所以这道闸门今天挡不住任何事故。
   * 它挡的是**下一个脚本**：这一页对脚本内容不作任何假设，而 StrictMode 会把 effect 跑两遍，
   * 状态与 ref 在两次之间是同一份——第一帧要是带着 `shuffle` + `deal:start`，
   * 没有闸门就是发两轮牌，队列当场积压清空。
   */
  const bootedRef = useRef(false);
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    feed(at(frames, 0, '帧'));
  }, [frames, feed]);

  // 亮牌不在事件流里（D-002 / D-013），所以线上那条增量规则从这里复用
  useRevealAnimation(director, snapshot.reveals);

  /** 卸载即收摊：中止正在播的那段并撤掉看门狗，不然它会跟着活到 5 秒超时 */
  useEffect(() => () => queue.flush(), [queue]);

  const last = frames.length - 1;

  /** 连播：等这一段播完，停一下，再进下一帧 */
  useEffect(() => {
    if (!playing || animState.blocked) return;
    const timer = window.setTimeout(() => {
      /*
       * 到底了自己停下。这一步写在回调里而不是 effect 体里是有讲究的：effect 体里同步
       * `setPlaying` 等于「渲染刚结束就再排一轮渲染」，React 明令避免（`set-state-in-effect`），
       * 而回调这一侧本来就是异步的，没有任何一轮渲染被它拽着多跑。
       */
      if (index >= last) {
        setPlaying(false);
        return;
      }
      goTo(index + 1);
    }, FRAME_DWELL_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [playing, animState.blocked, index, last, goTo]);

  const frame = at(frames, index, '帧');
  const atEnd = index >= last;
  const fast = animState.speed !== ANIM_SPEED_NORMAL;
  /** 正在播 + 待播。跳终态那条线看的是这个数，不是 `pending.length` */
  const queued = animState.pending.length + (animState.active === null ? 0 : 1);
  const actionSeconds = useCountdown(snapshot.deadline, snapshot.clockOffsetMs);
  const nextHandSeconds = useCountdown(snapshot.nextHandAt, snapshot.clockOffsetMs);
  const self = snapshot.players.find((player) => player.isSelf);
  /**
   * `isMyTurn` 且**队列空着**才亮按钮（SPEC §3.1）。
   *
   * 这一页按了不会有反应（没有服务端），要看的正是「牌还在飞的时候这三颗是不是灰的」。
   */
  const canAct = snapshot.isMyTurn && !animState.blocked;

  const stepOnce = (): void => {
    setPlaying(false);
    if (!atEnd) goTo(index + 1);
  };

  return (
    <div className="table-page">
      <section className="card card--wide">
        <div className="card__heading">
          <h2 className="card__title">{scenario.title}</h2>
          <span className="badge">{phaseLabel(snapshot.phase)}</span>
          {snapshot.handNo > 0 && <span className="badge">第 {snapshot.handNo} 手</span>}
          <span className="pot-line">
            底池 <span className="pot-line__amount">{snapshot.potTotal}</span>
          </span>
          {actionSeconds !== null && (
            <span className="table-timer" role="timer">
              行动剩余 {actionSeconds} 秒
            </span>
          )}
          {actionSeconds === null && nextHandSeconds !== null && (
            <span className="table-timer" role="timer">
              下一手 {nextHandSeconds} 秒后开始
            </span>
          )}
        </div>
        <p className="dev-replay__summary">{scenario.summary}</p>

        <div className="btn-row">
          <button
            className="btn btn--primary"
            type="button"
            onClick={() => setPlaying((value) => !value)}
            disabled={atEnd && !playing}
          >
            {playing ? '暂停' : '播放'}
          </button>
          <button className="btn btn--ghost" type="button" onClick={stepOnce} disabled={atEnd}>
            单步
          </button>
          <button
            className="btn btn--ghost"
            type="button"
            onClick={() => queue.setSpeed(fast ? ANIM_SPEED_NORMAL : ANIM_SPEED_FAST)}
          >
            {fast ? '原速' : '加速'}
          </button>
          {animState.blocked && (
            <button className="btn btn--ghost" type="button" onClick={queue.skip}>
              跳过动画
            </button>
          )}
          <button className="btn btn--ghost" type="button" onClick={onRestart}>
            重来
          </button>
          {/* 当前在队的段数。它超不过上限——第 13 段一进来整条队列就被清空、画面直接落终态 */}
          <span className="dev-replay__queue">
            队列 {queued} 段 / 上限 {ANIM_BACKLOG_LIMIT}
          </span>
        </div>

        <div className="dev-replay__current">
          <span className="dev-replay__position">
            第 {index + 1} / {frames.length} 帧
          </span>
          <strong className="dev-replay__label">{frame.label}</strong>
          {frame.note !== '' && <span className="dev-replay__note">{frame.note}</span>}
        </div>

        <ol className="dev-replay__frames">
          {frames.map((row, position) => (
            <li key={`${String(position)}-${row.label}`}>
              <button
                className={`dev-replay__frame${position === index ? ' dev-replay__frame--current' : ''}`}
                type="button"
                aria-current={position === index}
                onClick={() => {
                  setPlaying(false);
                  goTo(position);
                }}
              >
                <span className="dev-replay__frame-no">{position + 1}</span>
                {row.label}
              </button>
            </li>
          ))}
        </ol>
      </section>

      <TableStage
        snapshot={snapshot}
        disabled={false}
        seatEmotes={emotes}
        onSit={noop}
        onStand={noop}
        onRebuy={noop}
      />

      <section className="card card--wide" role="region" aria-label="我的底牌">
        <h3 className="card__title">我的底牌</h3>
        {snapshot.holeCards === null ? (
          <p className="empty">这一手还没发到我头上</p>
        ) : (
          <div className="hole-strip" data-anim={`hole-${snapshot.mySeat}`} data-self="">
            <CardRow cards={snapshot.holeCards} />
          </div>
        )}
      </section>

      <section className="card card--wide">
        <h3 className="card__title">行动</h3>
        {canAct && <p className="action-hint">轮到你行动了（这一页点了不会有任何反应）。</p>}
        {animState.blocked && <p className="action-hint">正在播动画，按钮按 SPEC §3.1 按住。</p>}
        <ActionPanel
          legal={self?.legal ?? NOTHING_LEGAL}
          handId={snapshot.handId}
          turnVersion={snapshot.turnVersion}
          canAct={canAct}
          potTotal={snapshot.potTotal}
          currentBet={snapshot.currentBet}
          bigBlind={snapshot.config.bigBlind}
          onAction={noop}
        />
      </section>

      <ShowdownPanel snapshot={snapshot} />

      {/* 幽灵层必须是 `.table-page` 的直接子节点：`createAnimScene` 从父级往下找锚点 */}
      <AnimLayer onScene={rig.setScene} />
    </div>
  );
}

export function DevReplayPage(): ReactNode {
  /**
   * 编译一次就够：产物是纯数据（每帧一份终态快照 + 一批事件），
   * 重编译只会让「已经播到哪」凭空对不上。
   */
  const scenarios = useMemo(() => REPLAY_SCENARIOS.map((script) => compileScenario(script)), []);
  const [picked, setPicked] = useState(0);
  const [run, setRun] = useState(0);
  const scenario = at(scenarios, picked, '场景');

  return (
    <div className="dev-replay">
      <h1 className="dev-assets__title">状态回放器</h1>
      <p className="dev-assets__hint">
        M3.2。三手牌是<strong>誊写</strong>下来的服务端 patch 序列（见 <code>src/dev/replayScenarios.ts</code>），
        这里不连服务端、不算规则，只把「画面终态 + 一排待播动画」按线上那一拍重演一遍。
        播放/暂停看整套节奏，<strong>单步</strong>一帧一帧走（定位用），<strong>加速</strong>是线上的 0.5× 档，
        <strong>重来</strong>把整手牌连气泡带队列一起归零。底下的帧列表可以点，直接跳到任意一帧。
        牌桌、座位、动作面板、摊牌面板全是产品里的真组件、真样式，所以这里顺带能验两件事：
        <strong>队列非空时那三颗按钮是灰的</strong>（SPEC §3.1），以及
        <strong>表情气泡按座位去重、2.4 秒自己摘掉</strong>。
        窗口拖窄到 640px 以下再播一次，就是手机上那套时长（全表 ×0.8）；
        系统开了「减弱动态效果」则一段都不播，画面直接落终态。
        按钮行最右边的「队列 N 段 / 上限 5」报的是**当前在队**的段数，它天生超不过 5：
        第 6 段一进来整条队列当场清空、画面直接落终态。边池场景的最后一帧就是 6 段，
        点了它你会看到"牌没飞、数字还是 0"——那是当前设计的真实行为，
        取舍记在 <code>DECISIONS.md</code>。
      </p>

      <div className="dev-replay__picker" role="group" aria-label="场景">
        {scenarios.map((row, position) => (
          <button
            className={`btn dev-replay__pick${position === picked ? ' dev-replay__pick--on' : ''}`}
            type="button"
            key={row.id}
            aria-pressed={position === picked}
            onClick={() => setPicked(position)}
          >
            {row.title}
          </button>
        ))}
      </div>

      {/*
        换场景 / 重来都靠 `key` 整棵重挂：新组件自带一枚新队列、一份新亮牌基线、
        一个空的气泡表。命令式地清这三样是漏一处的最好写法，所以不写。
      */}
      <ReplayPlayer key={`${scenario.id}#${String(run)}`} scenario={scenario} onRestart={() => setRun((value) => value + 1)} />
    </div>
  );
}
