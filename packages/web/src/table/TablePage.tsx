/**
 * 牌桌（路由 `/t/:code`）—— M1.6 的可玩界面。
 *
 * ## 这一页只做的事：把服务端的判断显示出来，把玩家的选择送回去
 *
 * SPEC §1.2 的铁律在这页体现得最直接。页面里**没有一处**自己算规则：
 *
 * - 按钮亮不亮 → `players[me].legal`（服务端用完整引擎算的提示位）
 *   + `isMyTurn` + 连接状态 + `actionPending`；
 * - 谁赢了、池怎么分 → `awards` / `results`（`pot:awarded` 事件与结算字段）；
 * - 还剩几秒 → `deadline` / `nextHandAt`（服务端的绝对时刻）+ `clockOffsetMs`；
 * - 我该看什么牌 → `holeCards`，它只可能来自发给我的定向 `deal` 消息。
 *
 * 所以这里刻意不写「筹码不够就把加注按钮禁掉」之类的本地判断：前端多一套规则，
 * 就多点一处和服务端不一致的地方，最后变成「界面说可以、服务端报错」的鬼故事。
 *
 * ## 断线期间整页禁操作
 *
 * `link !== 'online'` 时快照是**过期**的（重连窗口约 56 秒，见 `net/types.ts`）。
 * 过期快照上的「轮到我」很可能早就不是事实，所以这里把动作条、座位按钮、
 * 房主面板一起禁用，而不是让它们亮着等一个发不出去的操作。
 * 适配器那边本来也拒着发（`maxEnqueuedMessages = 0`），界面先禁是为了不骗人。
 *
 * ## 布局
 *
 * M2.2 起牌桌是一张**桌面**而不是一个列表：椭圆桌布 + 一圈按相对视角落位的座位
 * （`layout.ts` 算坐标，`TableStage.tsx` 摆放）。顺序按「玩家最该先看什么」排：
 * 桌面（局势 + 人一桌看全）→ 我的底牌 → 动作条 → 摊牌结算。
 * 底牌单独一条、不塞进 0 号座位框里，是因为竖屏满桌时那个框只有几十像素，
 * 而 SPEC §4.2 要它放大到屏宽 22%。
 *
 * ## 工具条：辅助控件默认收着（他看手机后的改动）
 *
 * 表情、房主设置、回等待室这些**不改局势**的控件，原先各自摊着一块（一整条表情排 +
 * 一整张房主卡），在手机上把桌面挤到要滚动才看得见。现在它们收成顶部工具条上的几颗钮，
 * 点着才展开对应的那一条 / 那一张。
 *
 * 三条口径：
 *
 * - **不分视口**：宽屏也收。他要的是「主要界面只有牌桌、底牌和操作」这一句话，
 *   给桌面端留一份「其实还摊着」的例外，等于让同一局里两个人的界面长得不一样。
 * - **点一个表情就自己收**：发送之后托盘消失，玩家不必回头再点一次关闭。
 * - **开局那一刻收起房主面板**：里面整块会被 `CONFIG_LOCKED` 锁住，继续摊着只是占地方。
 *
 * 展开状态是一段局部 UI state（`useState<'none'|'emote'|'host'>`，**互斥**，同屏只开一个）：
 * 不进 localStorage、不进快照，所以刷新就回到「只留钮」的默认形。读屏侧靠
 * `aria-expanded` + `aria-controls` 说清哪颗钮管着下面哪一块。
 */

import { isValidPairingCode, normalizePairingCode, type C2S } from '@poker-room/shared/view';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';

import { ANIM_SPEED_FAST, ANIM_SPEED_NORMAL, useAnimRig } from '../anim/rig';
import { useAnimDirector } from '../anim/useAnimDirector';
import type { LegalActionsView } from '../net/types';
import { useProfile } from '../state/ProfileContext';
import { useRoom } from '../state/RoomContext';
import { ActionPanel } from './components/ActionPanel';
import { AnimLayer } from './components/AnimLayer';
import { CardRow } from './components/CardView';
import { ChipStack } from './components/ChipStack';
import { EmoteBar } from './components/EmoteBar';
import { HostPanel } from './components/HostPanel';
import { ShowdownPanel } from './components/ShowdownPanel';
import { TableStage } from './components/TableStage';
import { phaseLabel } from './format';
import { useCountdown } from './useCountdown';
import { useSeatEmotes } from './useSeatEmotes';
import { useTableSounds } from './useTableSounds';

/** 快照里还没有我这一行时（刚进来、还没被服务端写入）用这份：什么都不亮 */
const NOTHING_LEGAL: LegalActionsView = {
  canFold: false,
  canCheck: false,
  callAmount: 0,
  canRaise: false,
  minRaiseTotal: 0,
  maxRaiseTotal: 0,
  canAllIn: false,
};

export function TablePage(): ReactNode {
  const params = useParams();
  const { profile } = useProfile();
  const { status, snapshot, link, failure, joinRoom, send } = useRoom();

  const code = normalizePairingCode(params['code'] ?? '');
  const codeIsValid = isValidPairingCode(code);

  useEffect(() => {
    if (!codeIsValid) return;
    void joinRoom(code, profile);
  }, [codeIsValid, code, profile, joinRoom]);

  // Hook 必须在任何提前 return 之前调完，所以这两行读的是「可能还没有快照」的值。
  const clockOffset = snapshot?.clockOffsetMs ?? 0;
  const actionSeconds = useCountdown(snapshot?.deadline ?? null, clockOffset);
  const nextHandSeconds = useCountdown(snapshot?.nextHandAt ?? null, clockOffset);

  /**
   * 动画：幽灵层 → 场景 → 渲染器 → 队列。零件在 `anim/rig.ts`，为什么场景不是 state
   * 写在 `useAnimRig` 那条注释里——这一页只需要把它接上：`renderer` 交给导演，
   * `setScene` 交给幽灵层。
   */
  const animRig = useAnimRig();
  /**
   * 没有快照时传 `null` 而不是 `[]`：那是「还没见过局面」，不是「局面里没人亮牌」。
   * 增量基线要记在第一份真快照上，读屏那条保证才成立（见 `anim/revealDelta.ts`）。
   * 引用稳定性也保住了——有快照时这个值就是快照里那个数组本身，只在 patch 时换。
   */
  const anim = useAnimDirector(animRig.renderer, snapshot?.reveals ?? null);
  const emoteSink = useSeatEmotes();
  // 音效走自己那两路订阅（事件 + 快照跃迁），不挂在动画队列上：减少动效时队列会跳过表演，
  // 而声音不该因此哑掉；`turn:change` 本来也不进队列。见 sound/cues.ts。
  useTableSounds();

  /**
   * 工具条的展开状态。`'none' | 'emote' | 'host'` 三值本身就写了「互斥」这件事：
   * 同屏最多开一块，开第二块时第一块自动收。不放进快照也不进 localStorage——
   * 刷新回到默认形是对的，玩家上一秒点开了什么不属于这一桌的事实。
   */
  const [openPanel, setOpenPanel] = useState<'none' | 'emote' | 'host'>('none');
  const emotePanelId = useId();
  const hostPanelId = useId();

  /**
   * 开局那一刻把房主面板收回去。
   *
   * 判据是「上一次看见的阶段还是等待，现在不是了」，不是 `phase !== 'IDLE'`：后者会把这扇门
   * 永久关死，而房主在牌局中途仍然要能打开它看一眼那份被 `CONFIG_LOCKED` 锁住的配置
   * （`开局之后开始按钮不亮` 那条用例钉的就是这个）。所以用 ref 记住上一份阶段，
   * 只在跃迁的那一次动 state。
   */
  const phase = snapshot?.phase ?? null;
  const lastPhase = useRef(phase);
  useEffect(() => {
    const previous = lastPhase.current;
    lastPhase.current = phase;
    if (previous === 'IDLE' && phase !== 'IDLE') {
      setOpenPanel((current) => (current === 'host' ? 'none' : current));
    }
  }, [phase]);

  /** 再点一次同一颗钮就是把它下面那块收回去——没有专门的「关闭」按钮要人找 */
  const togglePanel = (kind: 'emote' | 'host'): void => {
    setOpenPanel((current) => (current === kind ? 'none' : kind));
  };

  if (!codeIsValid) {
    return (
      <section className="card card--accent">
        <h2 className="card__title">这个链接里的配对码不对</h2>
        <Link className="btn btn--primary" to="/">
          回大厅重新输入
        </Link>
      </section>
    );
  }

  /**
   * 这一桌**确定**没了（服务端重启、牌局解散、进房链接过期）：再怎么等也不会连上，
   * 所以把话说死并给一条回大厅的路 —— M4.1 的验收项。
   * 「连不上服务端」不在这里：那一桌可能还好好的，说失效会把人赶去重开一桌。
   */
  const roomIsGone = failure !== null && (failure.kind === 'room-not-found' || failure.kind === 'link-expired');
  if (roomIsGone) {
    return (
      <section className="card card--accent">
        <h2 className="card__title">牌桌 {code} 已失效</h2>
        <p className="empty">{failure.hint}</p>
        <div className="btn-row">
          <Link className="btn btn--primary" to="/">
            回大厅
          </Link>
        </div>
      </section>
    );
  }

  if (status !== 'connected' || snapshot === null || snapshot.code !== code) {
    return (
      <section className="card card--accent">
        <h2 className="card__title">牌桌 {code}</h2>
        <p className="empty">{status === 'connecting' ? '正在进入房间…' : '还没连上这一桌。'}</p>
      </section>
    );
  }

  const offline = link !== 'online';
  const seatedPlayers = snapshot.players.filter((player) => player.seatIndex !== null);
  const self = snapshot.players.find((player) => player.isSelf);
  const legal = self?.legal ?? NOTHING_LEGAL;
  /**
   * 轮到我 + 连接活着 + 上一步已经被确认 + **动画队列空着**。
   *
   * 最后一条是 SPEC §3.1 消除割裂感的关键：牌还在飞、这一步已经发出去，
   * 玩家看到的就是「我还没看到自己的牌就做了决定」。队列那边同时提供「跳过」，
   * 所以按住不是把老玩家关在门外，只是把顺序摆正。
   */
  const canAct = snapshot.isMyTurn && !offline && !snapshot.actionPending && !anim.blocked;
  const fast = anim.speed !== ANIM_SPEED_NORMAL;
  /** 坐在位子上才有「我的余额」：旁观 / 还没入座时这一份是 null，底牌区不摆筹码叠 */
  const myChips = snapshot.mySeat === null ? null : (self?.chips ?? null);

  const sendCommand = (command: C2S): void => {
    // 返回值不接：发不出去只有两种情况（断线、这一步还悬着），
    // 前者由横幅说明、后者按钮本来就是灰的，不需要再多一条提示。
    send(command);
  };

  return (
    <div className="table-page">
      <section className="card card--wide">
        <div className="card__heading">
          <h2 className="card__title">牌桌 {code}</h2>
          <span className="player-count">
            {seatedPlayers.length}/{snapshot.config.maxPlayers}
          </span>
          <span className="badge">{phaseLabel(snapshot.phase)}</span>
          {snapshot.handNo > 0 && <span className="badge">第 {snapshot.handNo} 手</span>}
          <span className="pot-line">
            当前下注 <span className="pot-line__amount">{snapshot.currentBet}</span>
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
        {/*
          工具条：辅助控件各占一颗钮，点着才展开下面那一条 / 那一张。
          `回到等待室` 是路由、`加速` 是本地动画档，两件都不需要连接活着，所以不跟着灰；
          `表情` 和 `房主设置` 点开的是「发出去 / 存进去」的表单，断线时点开只能得到
          一屏灰按钮，所以直接禁用。
        */}
        <div className="table-toolbar" role="group" aria-label="牌桌工具">
          <Link className="btn btn--ghost" to={`/r/${code}`}>
            回到等待室
          </Link>
          {/* 动画控制：队列非空时才谈得上"跳过"，加速档则一直在（老玩家全程用 0.5×） */}
          <button
            className="btn btn--ghost"
            type="button"
            onClick={() => anim.setSpeed(fast ? ANIM_SPEED_NORMAL : ANIM_SPEED_FAST)}
          >
            {fast ? '原速' : '加速'}
          </button>
          {anim.blocked && (
            <button className="btn btn--ghost" type="button" onClick={anim.skip}>
              跳过动画
            </button>
          )}
          <button
            className="btn btn--ghost"
            type="button"
            disabled={offline}
            aria-expanded={openPanel === 'emote'}
            aria-controls={emotePanelId}
            onClick={() => togglePanel('emote')}
          >
            表情
          </button>
          {/* 判定还是服务端的 `isHost`（`chooseHost` 会把房主移给下一个人），这里只跟着它摆一颗钮 */}
          {snapshot.isHost && (
            <button
              className="btn btn--ghost"
              type="button"
              disabled={offline}
              aria-expanded={openPanel === 'host'}
              aria-controls={hostPanelId}
              onClick={() => togglePanel('host')}
            >
              房主设置
            </button>
          )}
        </div>
        {offline && <span className="table-page__warn">连接没跟上，暂时不能操作。</span>}
        {/* 服务端在最后 10 秒定向推 `timeoutWarning`；这里只转述，不自己掐表 */}
        {snapshot.timeoutWarning !== null && (
          <p className="table-page__warn">快超时了，服务端还有 {snapshot.timeoutWarning} 秒会替你决定。</p>
        )}
      </section>

      {/*
        展开的就是这两块，紧跟在按钮下面：点在上面的钮、变化发生在屏幕另一端，
        看着像没响应。收起时靠 JSX 上的 `hidden` 真正退出布局与 Tab 序
        （CSS 侧要配一条把 `display` 收回来的规则，见 global.css 里 `.card[hidden]` 那段）。
      */}
      <EmoteBar
        id={emotePanelId}
        hidden={openPanel !== 'emote'}
        disabled={offline}
        onEmote={(emoji) => {
          sendCommand({ t: 'emoji', emoji });
          // 点完一个就自己收起：表情是「发一条」，不是「留在这个界面里」
          setOpenPanel('none');
        }}
      />

      <HostPanel
        id={hostPanelId}
        hidden={openPanel !== 'host'}
        snapshot={snapshot}
        disabled={offline}
        onStart={() => sendCommand({ t: 'table:start' })}
        onSaveConfig={(config) => sendCommand({ t: 'table:setConfig', config })}
      />

      <TableStage
        snapshot={snapshot}
        disabled={offline}
        seatEmotes={emoteSink.emotes}
        onSit={(seatIndex) => sendCommand({ t: 'sit', seatIndex })}
        onStand={() => sendCommand({ t: 'stand' })}
        onRebuy={() => sendCommand({ t: 'rebuy' })}
      />

      <section className="card card--wide" role="region" aria-label="我的底牌">
        <h3 className="card__title">我的底牌</h3>
        <div className="hole-area">
          {snapshot.holeCards === null ? (
            <p className="empty">还没拿到你的底牌</p>
          ) : (
            /*
              `data-anim="hole-<我的座位号>"` 是发牌/亮牌动画的落点键，`data-self` 是
              「只翻我自己那两张」的判据（SPEC §3.2）。旁观时（`mySeat` 为 null）两个都不写：
              这一条不属于任何座位，动画找不到它才对。
            */
            <div
              className="hole-strip"
              data-anim={snapshot.mySeat === null ? undefined : `hole-${snapshot.mySeat}`}
              data-self={snapshot.mySeat === null ? undefined : ''}
            >
              <CardRow cards={snapshot.holeCards} />
            </div>
          )}
          {/*
            余额摆在牌旁边而不是座位里（D-038）。这一格必须在 `.hole-strip` **外面**：
            发牌动画遮 `hole-N` 时连它里面的 `.card-view` 一起遮，筹码跟着隐身就成了
            「钱也不见了」。没入座时没有「我的余额」这回事，旁观者那一格是空的。
          */}
          {myChips !== null && <ChipStack value={myChips} />}
        </div>
      </section>

      <section className="card card--wide">
        <h3 className="card__title">行动</h3>
        {canAct && <p className="action-hint">轮到你行动了。</p>}
        {anim.blocked && <p className="action-hint">正在播动画，操作稍等（可以点上面的「跳过动画」）。</p>}
        {snapshot.actionPending && <p className="action-hint">上一步已经发出去了，等服务端确认。</p>}
        <ActionPanel
          legal={legal}
          handId={snapshot.handId}
          turnVersion={snapshot.turnVersion}
          canAct={canAct}
          potTotal={snapshot.potTotal}
          currentBet={snapshot.currentBet}
          bigBlind={snapshot.config.bigBlind}
          onAction={(action) =>
            sendCommand({ t: 'action', action, handId: snapshot.handId, turnVersion: snapshot.turnVersion })
          }
        />
      </section>

      <ShowdownPanel snapshot={snapshot} />

      {/* 幽灵层必须是 `.table-page` 的直接子节点：`createAnimScene` 从父级往下找锚点 */}
      <AnimLayer onScene={animRig.setScene} />
    </div>
  );
}
