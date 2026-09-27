/**
 * 部署用的结构化日志（M4.3 / SPEC §5.2「结构化 JSON 到 stdout，Docker 收走」）。
 *
 * ## 为什么是自己写这几行，而不是配 Colyseus 的 logger
 *
 * `import { logger } from 'colyseus'` 那个对象的**公开类型只有五个方法**：
 * `debug / error / info / trace / warn`（这条不是记忆，是编译器答复——
 * `Record<keyof typeof logger, 0> = {}` 报的缺失成员清单就是这五个）。
 * 里面没有格式开关，也没有等级开关。要把日志变成 JSON，只有两条路：
 * 伸手去改它内部的实现（读 `@colyseus/core` 源码 + monkey-patch，本仓库禁止），
 * 或者**我们自己这条进程的日志自己写**。选后者，代价写进 DECISIONS.md D-043：
 * Colyseus 自己那几行仍是它的格式。
 *
 * ## 为什么是注入而不是直接 `console.log`
 *
 * 时间戳和写出目标一旦写死，单测就只能靠 fake timers 和劫持 stdout 去掐——
 * 这条链路的价值恰恰是「一行一个能 `JSON.parse` 的对象」，把注入点摊开更好钉。
 */

import { describe, expect, it } from 'vitest';

import { createLogger, LOG_LEVELS, parseLogLevel, type LogSink } from '../src/logging';

/** 收住每一行，方便断言。生产里这个位置是 `process.stdout.write` */
function collectingSink(): { readonly lines: string[]; readonly sink: LogSink } {
  const lines: string[] = [];
  return { lines, sink: (line: string) => void lines.push(line) };
}

describe('parseLogLevel', () => {
  it('未设置或空白时默认 info', () => {
    expect(parseLogLevel(undefined)).toBe('info');
    expect(parseLogLevel('   ')).toBe('info');
  });

  it('大小写与首尾空白都不敏感', () => {
    expect(parseLogLevel(' WARN ')).toBe('warn');
  });

  it('认不出来的值不抛错，回落到默认并保留四档原样', () => {
    expect(parseLogLevel('verbose')).toBe('info');
    expect(LOG_LEVELS).toEqual(['debug', 'info', 'warn', 'error']);
  });
});

describe('createLogger', () => {
  it('一行一个 JSON 对象，结尾带换行，`JSON.parse` 得回来', () => {
    const { lines, sink } = collectingSink();
    const log = createLogger({ sink, level: 'info', now: () => Date.parse('2026-09-27T10:00:00.000Z') });

    log.info('服务端已启动', { port: 2567 });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith('\n')).toBe(true);
    expect(JSON.parse(lines[0] ?? '') as Record<string, unknown>).toEqual({
      time: '2026-09-27T10:00:00.000Z',
      level: 'info',
      msg: '服务端已启动',
      port: 2567,
    });
  });

  it('低于门槛的等级直接不写，一行都不产生', () => {
    const { lines, sink } = collectingSink();
    const log = createLogger({ sink, level: 'warn', now: () => 0 });

    log.debug('细碎');
    log.info('常规');
    log.warn('要留意');
    log.error('坏了');

    expect(lines).toHaveLength(2);
    expect(lines.map((line) => (JSON.parse(line) as { level: string }).level)).toEqual(['warn', 'error']);
  });

  it('没有附加字段时也只有三个键，不会挤出一个空对象', () => {
    const { lines, sink } = collectingSink();
    const log = createLogger({ sink, level: 'info', now: () => 0 });

    log.info('只有消息');

    expect(Object.keys(JSON.parse(lines[0] ?? '') as Record<string, unknown>)).toEqual(['time', 'level', 'msg']);
  });

  /**
   * `Error` 是部署时最常见的一种入参。`JSON.stringify(new Error('x'))` 得到 `{}`
   * ——message 和 stack 都是不可枚举属性——照原样塞进去等于把报错吞干净。
   */
  it('传 Error 时留下 message 与 stack，而不是一个空对象', () => {
    const { lines, sink } = collectingSink();
    const log = createLogger({ sink, level: 'error', now: () => 0 });

    log.error('启动失败', { cause: new Error('端口被占用') });

    const record = JSON.parse(lines[0] ?? '') as { cause: { message: string; stack: string } };
    expect(record.cause.message).toBe('端口被占用');
    expect(typeof record.cause.stack).toBe('string');
  });

  it('字段名与保留键撞车时，保留键赢——否则 `level` 会被业务字段顶掉', () => {
    const { lines, sink } = collectingSink();
    const log = createLogger({ sink, level: 'info', now: () => 0 });

    log.info('Room 状态', { level: 'debug', room: 'ABC123' });

    const record = JSON.parse(lines[0] ?? '') as { level: string; room: string };
    expect(record.level).toBe('info');
    expect(record.room).toBe('ABC123');
  });

  /** 日志本身不许把进程拖崩：循环引用之类的值降级成一行 error，而不是抛出 */
  it('字段里有循环引用时不抛，退化成一条能解析的记录', () => {
    const { lines, sink } = collectingSink();
    const log = createLogger({ sink, level: 'info', now: () => 0 });
    const cyclic: Record<string, unknown> = { name: '房间' };
    cyclic['self'] = cyclic;

    expect(() => {
      log.info('状态', { state: cyclic });
    }).not.toThrow();

    const record = JSON.parse(lines[0] ?? '') as { msg: string; error: string };
    expect(record.msg).toBe('状态');
    expect(typeof record.error).toBe('string');
  });
});
