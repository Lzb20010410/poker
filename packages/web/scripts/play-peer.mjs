#!/usr/bin/env node
/**
 * 本地联调用的「第二个玩家」—— 跑在终端里的自动牌手。
 *
 * ## 它解决什么问题
 *
 * 牌桌逻辑要两个人才跑得起来，而浏览器只给我一个。这个脚本用**真的 `@colyseus/sdk`**
 * 连到真的服务端（不是测试里那套假 client），所以它能验到 UI 单测验不到的东西：
 * 定向消息只发给了对的人、掉线重连、以及跨标签页刷新续座。
 *
 * ## 为什么放在 packages/web 下面
 *
 * Node 的模块解析按**导入方文件的位置**往上找 `node_modules`。`@colyseus/sdk` 是
 * web 包的依赖，pnpm 只把它链到 `packages/web/node_modules` 下；脚本放在仓库根会解析不到。
 *
 * ## 它不是应用代码
 *
 * 本仓库的边界约定是「应用代码里只有 `src/net/client.ts` 能 import `@colyseus/sdk`」，
 * 这个脚本是那条约定的唯一例外：它在 Node 里跑，不在 `vite build` 的图里，
 * 也不进 `dist`（入口只有 `index.html`），所以不会被打包进浏览器。
 * 它同样不受「不许信任客户端」约束的反向影响 —— 它只是个客户端，服务端该拒的照样拒。
 *
 * ## 用法
 *
 *   pnpm --filter @poker-room/web peer <配对码> [--url=...] [--play=solid|aggro|shove] [--name=...]
 *
 * - `--play` 省略时只旁观（打印状态和自己的底牌），动作由终端里读一行命令来决定；
 * - `--play=solid`：能过牌就过牌，跟注便宜才跟，贵就弃；
 * - `--play=aggro`：只要允许加注就加到最小加注额；
 * - `--play=shove`：轮到就打全下 —— 两三个人各打一次，边池就出来了，最适合快速看派彩。
 *
 * 注意底池派给谁是**服务端**算的，这个脚本只负责把收到的东西打印出来给人看。
 */

import { Client } from '@colyseus/sdk';

const DEFAULT_URL = 'http://localhost:2567';
const SUIT_CHAR = { s: '♠', h: '♥', d: '♦', c: '♣' };

function parseArgs(argv) {
  const args = { url: DEFAULT_URL, play: '', name: '终端牌手', code: '' };
  for (const entry of argv) {
    if (!entry.startsWith('--')) {
      if (args.code === '') args.code = entry.toUpperCase();
      continue;
    }
    const [flag, value = ''] = entry.slice(2).split('=');
    if (flag === 'url') args.url = value;
    else if (flag === 'play') args.play = value === '' ? 'solid' : value;
    else if (flag === 'name') args.name = value;
    else throw new Error(`未知参数：${entry}`);
  }
  if (!/^[A-Z0-9]{6}$/.test(args.code)) throw new Error('必须给一个 6 位配对码');
  if (!['', 'solid', 'aggro', 'shove'].includes(args.play)) throw new Error('--play 只认 solid / aggro / shove');
  return args;
}

function cards(list) {
  return list.map((card) => `${card.rank}${SUIT_CHAR[card.suit] ?? card.suit}`).join(' ');
}

/** 服务端 `serverTime` 是连接期间的近似时间，只用来算还剩几秒，不参与任何判定 */
function remaining(deadline, now) {
  if (!deadline) return '';
  const seconds = Math.max(0, Math.round((deadline - now) / 1000));
  return ` 剩余${seconds}s`;
}

function log(label, detail) {
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(`${stamp} ${label} ${detail}`);
}

const args = parseArgs(process.argv.slice(2));
const sdk = new Client(args.url);
const room = await sdk.joinById(args.code, { nickname: args.name, avatarSeed: `peer-${args.name}` });
room.reconnection.maxEnqueuedMessages = 0;
room.reconnection.minUptime = 0;

room.onMessage('deal', (payload) => log('底牌→我', `${cards(payload.cards)}（第 ${payload.handId} 手）`));
room.onMessage('showdown:reveal', (payload) => log('摊牌', `座位 ${payload.seatIndex} 亮出 ${cards(payload.cards)}`));
room.onMessage('error', (payload) => log('服务端拒绝', `[${payload.code}] ${payload.message}`));
room.onMessage('timeoutWarning', (payload) => log('超时提醒', `还剩 ${payload.remainingSec}s`));
room.onMessage('event', (payload) => log('事件', JSON.stringify(payload)));
room.onDrop(() => log('连接', '掉了，等 SDK 自动重连'));
room.onReconnect(() => log('连接', '重连上了'));
room.onLeave(() => log('连接', '离开房间'));

let actedKey = '';
let reboughtKey = '';
let lastLine = '';

function mySlot() {
  return room.state.players.get(room.sessionId);
}

/**
 * 轮到我了就按策略出牌。
 *
 * `turnVersion` 在服务端每推进一次决策就 +1，所以「同一个 `handId:turnVersion` 只发一次」
 * 天然把重复触发挡掉了；真发重了服务端也会按过期动作拒绝，那条拒绝会被 `error` 打出来。
 */
function maybeAct() {
  if (args.play === '') return;
  const state = room.state;
  const slot = mySlot();
  if (slot === undefined || slot.seatIndex !== state.currentTurn) return;
  if (!['PREFLOP', 'FLOP', 'TURN', 'RIVER'].includes(state.phase)) return;
  const key = `${state.handId}:${state.turnVersion}`;
  if (key === actedKey) return;
  actedKey = key;

  const cheap = slot.callAmount <= 2 * state.config.bigBlind;
  const action =
    args.play === 'shove' ? { type: 'allIn' }
      : slot.canCheck ? { type: 'check' }
      : args.play === 'aggro' && slot.canRaise ? { type: 'raise', totalBet: slot.minRaiseTotal }
      : cheap && slot.callAmount <= slot.maxRaiseTotal ? { type: 'call' }
      : { type: 'fold' };

  setTimeout(() => {
    room.send('command', { t: 'action', action, handId: state.handId, turnVersion: state.turnVersion });
    log('我出牌', `${JSON.stringify(action)}（第 ${state.handId} 手 v${state.turnVersion}）`);
  }, 400);
}

/**
 * 筹码打光了就重买。
 *
 * 服务端只允许在 `IDLE` / `HAND_END` 且筹码正好为 0 时重买，所以这里照抄那两条门槛，
 * 免得终端里刷一堆「服务端拒绝」。去重键用 `手号:阶段`，一手只会试一次。
 * 没有这一步的话，输光的人永远空坐着，三个人就凑不出真正的多层边池。
 */
function maybeRebuy() {
  if (args.play === '') return;
  const state = room.state;
  if (state.phase !== 'IDLE' && state.phase !== 'HAND_END') return;
  const slot = mySlot();
  if (slot === undefined || slot.chips !== 0) return;
  const key = `${state.handNo}:${state.phase}`;
  if (key === reboughtKey) return;
  reboughtKey = key;
  room.send('command', { t: 'rebuy' });
  log('我重买', `座位 ${slot.seatIndex}（第 ${state.handNo} 手后 ${state.phase}）`);
}

room.onStateChange((state) => {
  const seats = [];
  state.players.forEach((p) => seats.push(`${p.seatIndex}:${p.nickname}(${p.chips},${p.presence})`));
  const line = [
    state.phase,
    `手#${state.handNo}`,
    `v${state.turnVersion}`,
    `轮座位${state.currentTurn}`,
    `底池${state.potTotal}`,
    `牌面[${cards(state.board)}]`,
    remaining(state.deadline, state.serverTime),
    seats.join(' '),
  ].join(' | ');
  if (line !== lastLine) {
    lastLine = line;
    log('状态', line);
  }
  maybeAct();
  maybeRebuy();
});

log('已进房', `${args.code} @ ${args.url} · sessionId=${room.sessionId} · 策略=${args.play || '旁观'}`);
process.stdin.resume();
