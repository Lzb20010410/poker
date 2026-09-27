/**
 * 部署日志：一行一个 JSON 对象，写到 stdout。
 *
 * SPEC §5.2 要的是「结构化 JSON 到 stdout，Docker 收走」。Colyseus 的 `logger`
 * 帮不上这个忙——它的公开类型只有 `debug / error / info / trace / warn` 五个方法，
 * 没有格式开关也没有等级开关（`Record<keyof typeof logger, 0>` 的缺失成员清单就是证据）。
 * 所以这条进程自己的日志在这里写。Colyseus 内部那几行仍是它原本的格式，
 * 代价与理由记在 DECISIONS.md D-043。
 *
 * 写出目标和时间是注入的：单测因此不需要劫持 `process.stdout`，也不用 fake timers
 * 去掐一个时间戳。
 */

/** 从低到高。门槛的含义是「这一档及以上才写」 */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** 一行的去处。生产是 `process.stdout.write` */
export type LogSink = (line: string) => void;

export interface LogFields {
  readonly [key: string]: unknown;
}

export interface LoggerEnv {
  readonly sink: LogSink;
  readonly level: LogLevel;
  /** 毫秒时间戳。注入它是为了让时间戳可断言 */
  readonly now: () => number;
}

export interface Logger {
  readonly debug: (msg: string, fields?: LogFields) => void;
  readonly info: (msg: string, fields?: LogFields) => void;
  readonly warn: (msg: string, fields?: LogFields) => void;
  readonly error: (msg: string, fields?: LogFields) => void;
}

/**
 * `LOG_LEVEL` 认不出来时**回落而不是抛错**：日志门槛写错不该让服务起不来，
 * 那等于把一个能玩的夜晚换成一条启动失败。
 */
export function parseLogLevel(raw: string | undefined): LogLevel {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === '') return 'info';
  return LOG_LEVELS.find((level) => level === value) ?? 'info';
}

export function createLogger(env: LoggerEnv): Logger {
  const threshold = LOG_LEVELS.indexOf(env.level);

  const emit = (level: LogLevel, msg: string, fields?: LogFields): void => {
    if (LOG_LEVELS.indexOf(level) < threshold) return;
    env.sink(formatLine(level, msg, fields, env.now));
  };

  return {
    debug: (msg, fields) => void emit('debug', msg, fields),
    info: (msg, fields) => void emit('info', msg, fields),
    warn: (msg, fields) => void emit('warn', msg, fields),
    error: (msg, fields) => void emit('error', msg, fields),
  };
}

function formatLine(level: LogLevel, msg: string, fields: LogFields | undefined, now: () => number): string {
  const time = new Date(now()).toISOString();
  const record: LogFields = { ...serializeFields(fields), time, level, msg };
  try {
    return `${JSON.stringify(record)}\n`;
  } catch (error) {
    /**
     * 日志不许把进程弄死。传进来的字段里有一个循环引用（游戏状态里真造得出来：
     * 座位指玩家、玩家指座位）时 `JSON.stringify` 会抛，这里退化成一行还能解析的记录，
     * 把原因放进 `error` 字段。
     */
    return `${JSON.stringify({ time, level, msg, error: String(error) })}\n`;
  }
}

function serializeFields(fields: LogFields | undefined): LogFields {
  if (fields === undefined) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value;
  }
  return out;
}
