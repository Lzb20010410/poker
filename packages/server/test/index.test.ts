import { describe, expect, it } from 'vitest';

import { FALLBACK_PORT, resolvePort, SERVER_PACKAGE } from '../src/index';

describe('server 包标识', () => {
  it('导出包名', () => {
    expect(SERVER_PACKAGE).toBe('@poker-room/server');
  });

  it('默认端口为 2567（Colyseus 惯例，web 包的 vite proxy 也指向它）', () => {
    expect(FALLBACK_PORT).toBe(2567);
  });
});

describe('resolvePort', () => {
  it('未设置或为空时回落到 FALLBACK_PORT', () => {
    expect(resolvePort(undefined)).toBe(FALLBACK_PORT);
    expect(resolvePort('')).toBe(FALLBACK_PORT);
    expect(resolvePort('   ')).toBe(FALLBACK_PORT);
  });

  it('合法端口原样返回，容忍首尾空白', () => {
    expect(resolvePort('3000')).toBe(3000);
    expect(resolvePort(' 8080 ')).toBe(8080);
    expect(resolvePort('1')).toBe(1);
    expect(resolvePort('65535')).toBe(65535);
  });

  it('非法端口显式抛错，而不是静默用默认值', () => {
    for (const bad of ['abc', '0', '-1', '70000', '2567.5', 'NaN']) {
      expect(() => resolvePort(bad)).toThrow(/PORT 不是合法端口号/);
    }
  });

  it('不传参数时读 process.env.PORT', () => {
    const saved = process.env['PORT'];
    try {
      process.env['PORT'] = '4321';
      expect(resolvePort()).toBe(4321);
      delete process.env['PORT'];
      expect(resolvePort()).toBe(FALLBACK_PORT);
    } finally {
      if (saved === undefined) delete process.env['PORT'];
      else process.env['PORT'] = saved;
    }
  });
});
