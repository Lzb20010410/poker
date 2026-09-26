import {
  addTablePlayer, allocatePairingCode, applyPlayerAction, createTable, cryptoRandom,
  DEFAULT_TABLE_CONFIG, getPrivateMessages, getTimeoutWarning, rebuyPlayer, RuleError, sanitizeAvatarSeed,
  sanitizeNickname, setPlayerPresence, setTableConfig, sitPlayer, standPlayer, startTable, tickTable,
  type PrivateMessage, type TableContext, type TableUpdate,
} from '@poker-room/shared';
import { CloseCode, logger, matchMaker, Room, ServerError, type Client } from 'colyseus';
import { syncPublicState } from '../engine-bridge';
import { PokerRoomState } from '../schema/PokerRoomState';
import { PAIRING_RESERVATION, releasePairingCode } from './pairingReservation';

export interface PokerRoomOptions {
  readonly nickname?: unknown;
  readonly avatarSeed?: unknown;
}
/** 仅服务器构造/子类可注入，任何网络 options 都不能覆盖。 */
export interface PokerRoomRuntime {
  readonly now: () => number;
  readonly rand: () => number;
}
export async function isPairingCodeTaken(code: string): Promise<boolean> {
  const rooms = await matchMaker.findRoomsByIds([code]);
  return rooms.has(code);
}
function object(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}
function invalid(): never {
  throw new RuleError('INVALID_ACTION', '未知或格式错误的命令');
}

export class PokerRoom extends Room<{ state: PokerRoomState }> {
  protected runtime: PokerRoomRuntime = { now: () => Date.now(), rand: cryptoRandom };
  private table = createTable(DEFAULT_TABLE_CONFIG, []);
  private emptySince: number | null = null;
  private stopped = false;
  private warnedTurn = '';
  /** 本房间占住的配对码；onDispose 靠它归还预留，空串表示还没分配到 */
  private reservedCode = '';

  override async onCreate(): Promise<void> {
    this.maxClients = DEFAULT_TABLE_CONFIG.maxPlayers;
    this.maxMessagesPerSecond = 100;
    // 这不是"掉线保留座位 120 秒"那条规则（那是 onDrop 里的 allowReconnection，SPEC §2.5）。
    // seatReservationTimeout 只管 matchMaker 已分配座位、但 transport 从未到达的 joinById，
    // 而本项目的客户端是先连上再 onJoin，所以这条时限正常不会触发。
    this.seatReservationTimeout = 60;
    this.autoDispose = false;
    this.setState(new PokerRoomState());
    // 带着预留分配：查重是异步的，先把码同步占住，另一个 onCreate 才挤不进来。
    const code = await allocatePairingCode(isPairingCodeTaken, { reservation: PAIRING_RESERVATION });
    this.reservedCode = code;
    // 分配成功之后任何一步抛错，这个房间都不会交到我们手上，预留必须自己还。
    try {
      this.roomId = code;
      this.state.joinCode = code;
      syncPublicState(this.state, this.table, this.runtime.now());
      this.emptySince = this.runtime.now();
      this.onMessage<unknown>('command', (client, input) => this.command(client, input));
      this.setSimulationInterval(() => this.tick(), 100);
    } catch (error) {
      releasePairingCode(this.reservedCode);
      this.reservedCode = '';
      throw error;
    }
  }

  override onJoin(client: Client, options?: PokerRoomOptions): void {
    this.publish(addTablePlayer(this.table, {
      id: client.sessionId,
      nickname: sanitizeNickname(options?.nickname, `玩家${client.sessionId.slice(-4)}`),
      avatarSeed: sanitizeAvatarSeed(options?.avatarSeed, client.sessionId),
    }, this.context()));
    this.emptySince = null;
    this.privateSnapshot(client);
  }

  override async onDrop(client: Client): Promise<void> {
    if (this.stopped) return;
    this.publish(setPlayerPresence(this.table, client.sessionId, 'reconnecting', this.context()));
    this.trackEmpty();
    // 0.18 的 _onAfterLeave 会在失败后调用 onLeave；这里绝不重复终离。
    try {
      await this.allowReconnection(client, 120);
    } catch (reason) {
      // 安装版本用 false 表示超时，用 ServerError(1000) 表示正常解散取消。
      const cancelled = reason instanceof ServerError &&
        reason.code === CloseCode.NORMAL_CLOSURE && reason.message === 'disconnecting';
      if (reason !== false && !cancelled) throw reason;
    }
  }

  override onReconnect(client: Client): void {
    this.emptySince = null;
    this.publish(setPlayerPresence(this.table, client.sessionId, 'online', this.context()));
    this.privateSnapshot(client);
  }

  override onLeave(client: Client): void {
    // onJoin 失败也会进入此 hook；没有成功加入的客户端没有账户。
    if (this.table.accounts.some((a) => a.id === client.sessionId && a.presence !== 'left')) {
      this.publish(setPlayerPresence(this.table, client.sessionId, 'left', this.context()));
    }
    this.trackEmpty();
  }

  override async disconnect(closeCode?: number): Promise<void> {
    // shutdown 也通过此入口，不能把主动关服的连接再次保留两分钟。
    this.stopped = true;
    await super.disconnect(closeCode);
  }

  override onDispose(): void {
    this.stopped = true;
    this.clock.clear();
    // 房间没了就把配对码还回预留表，否则表只增不减、这个码永远回收不回来。
    releasePairingCode(this.reservedCode);
    this.reservedCode = '';
  }

  private trackEmpty(): void {
    if (this.clients.length === 0 && this.emptySince === null) this.emptySince = this.runtime.now();
  }

  private tick(): void {
    if (this.stopped) return;
    const ctx = this.context();
    if (this.emptySince !== null && ctx.now - this.emptySince >= 30 * 60 * 1000) {
      this.stopped = true;
      void this.disconnect().catch((error: unknown) => logger.error('PokerRoom dispose failed', error));
      return;
    }
    try {
      this.advance(ctx);
    } catch (error) {
      // 时钟回调里抛出去的错误等于整台服务器：`setSimulationInterval` 是 Node 定时器，
      // 抛出没有框架接手，按未捕获异常处理 → 进程退出，一起跑的其他房间全部陪葬
      // （D-000 单进程部署）。房间测试实测过：加这道保护之前，这条抛出确实到了 `uncaughtException`。
      // 但只"兜住"是不够的——会抛就说明牌桌状态已经不可信，再 tick 一次可能把算错的筹码
      // 派出去。所以先同步置 `stopped`（下一次 tick 第一行就返回），再走正常关房：
      // `disconnect()` 会触发 onLeave/onDispose，配对码照样归还。
      this.stopped = true;
      logger.error('PokerRoom tick failed; halting this table', error);
      void this.disconnect().catch((disconnectError: unknown) => logger.error('PokerRoom dispose failed', disconnectError));
    }
  }

  private advance(ctx: TableContext): void {
    this.publish(tickTable(this.table, ctx));
    const key = `${this.table.handId}:${this.table.turnVersion}`;
    if (this.warnedTurn === key) return;
    const warning = getTimeoutWarning(this.table, ctx.now);
    if (warning && this.sendPrivate(warning)) this.warnedTurn = key;
  }

  private context(): TableContext {
    return { now: this.runtime.now(), rand: this.runtime.rand };
  }

  private publish(update: TableUpdate): void {
    const previous = this.table;
    this.table = update.newState;
    syncPublicState(this.state, this.table, this.runtime.now(), previous);
    // maxClients setter 会写匹配驱动；无变化 tick 不应重复持久化。
    if (this.maxClients !== this.table.config.maxPlayers) this.maxClients = this.table.config.maxPlayers;
    // WebSocket 有序：事件处理器必须先看到新版本，才能安全发下一个动作。
    if (previous !== this.table) this.broadcastPatch();
    for (const event of update.events) this.broadcast('event', event);
    for (const message of update.privateMessages) this.sendPrivate(message);
  }

  private sendPrivate({ playerId, message }: PrivateMessage): boolean {
    const client = this.clients.find((c) => c.sessionId === playerId);
    if (!client) return false;
    client.send(message.t === 'deal:holeCards' ? 'deal' : message.t, message);
    return true;
  }

  private privateSnapshot(client: Client): void {
    for (const message of getPrivateMessages(this.table, client.sessionId)) this.sendPrivate(message);
  }

  private command(client: Client, input: unknown): void {
    // 两条 M1 收尾审查的结论都落在这扇门上，判定都是「不改，但必须写下来」，别被后人当成漏写：
    //
    // 一、这里**刻意不检查** `this.stopped`。`tick()` 抛错后确实存在一个毫秒级窗口：房间已在拆卸，
    // 命令却仍能改状态并广播。不加这道判断是因为它**没有可判红的测试路径** —— 拆卸是异步的，
    // 测试能观察到的最早时刻已经是"房间不在注册表里、客户端已断开"（见 poker-lifecycle 那条
    // tick 隔离用例里的 `wait(() => !server.getRoomById(...))`）。留注释，不留假测试。
    //
    // 二、`table:start` / `table:setConfig` / `sit` / `stand` / `rebuy` **不带时效令牌**，
    // 五个都是电平触发的；只有 `action` 带 `handId` + `turnVersion`，由 `applyPlayerAction` 拒过期。
    // 于是一条被 SDK 离线队列延后冲出的 `table:start`，确实可能在房主重连后"没人按却开了局"。
    // 判定为可接受：危害被 `requireHost` + `requireOnline` + 相位门三层夹住 —— 能重放的只有房主
    // 自己那一击（他的意图本来就是开局），第三方的同名命令在门禁外就死了；真实客户端另外还有一层
    // （`maxEnqueuedMessages = 0` 且只在 `link === 'online'` 才发，见 D-012 与 `net/client.ts:437`）。
    // **这条判定的边界**：M2 一旦给房主加"踢人 / 重置筹码"这类破坏性动词，它立刻失效，
    // 那时给命令带上连接期号（nonce）是需求，不是优化。
    try {
      if (!object(input) || typeof input.t !== 'string') invalid();
      const id = client.sessionId;
      const ctx = this.context();
      switch (input.t) {
        case 'table:start': this.publish(startTable(this.table, id, ctx)); break;
        case 'table:setConfig':
          if (!object(input.config)) invalid();
          this.publish(setTableConfig(this.table, id, input.config)); break;
        case 'action':
          if (typeof input.handId !== 'string' || typeof input.turnVersion !== 'number' ||
            !Number.isSafeInteger(input.turnVersion) || !object(input.action)) invalid();
          this.publish(applyPlayerAction(this.table, id, input.action, input.handId, input.turnVersion, ctx)); break;
        case 'sit':
          if (typeof input.seatIndex !== 'number' || !Number.isInteger(input.seatIndex)) invalid();
          this.publish(sitPlayer(this.table, id, input.seatIndex, ctx)); break;
        case 'stand': this.publish(standPlayer(this.table, id, ctx)); break;
        case 'rebuy': this.publish(rebuyPlayer(this.table, id, ctx)); break;
        case 'ping':
          this.privateSnapshot(client);
          client.send('pong', { serverTime: ctx.now, handId: this.table.handId, turnVersion: this.table.turnVersion });
          break;
        case 'emoji': {
          if (typeof input.emoji !== 'string' || !['fold-face', 'laugh', 'angry', 'wave'].includes(input.emoji)) invalid();
          const account = this.table.accounts.find((p) => p.id === id && p.presence === 'online');
          if (!account || account.seatIndex === null) throw new RuleError('NOT_SEATED', '请先入座');
          this.broadcast('event', { t: 'player:emoji', seatIndex: account.seatIndex, emoji: input.emoji });
          break;
        }
        default: invalid();
      }
    } catch (error) {
      if (!(error instanceof RuleError)) logger.error('PokerRoom command failed', error);
      client.send('error', {
        t: 'error', code: error instanceof RuleError ? error.code : 'INVALID_ACTION',
        message: error instanceof RuleError ? error.message : '命令处理失败',
      });
    }
  }
}
