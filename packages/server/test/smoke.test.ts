import { describe, expect, it } from 'vitest';
import { DEFAULT_PORT, SERVER_PACKAGE } from '../src/index.js';

describe('server 包冒烟', () => {
  it('导出包名', () => {
    expect(SERVER_PACKAGE).toBe('@poker-room/server');
  });

  it('默认端口为 2567（Colyseus 惯例）', () => {
    expect(DEFAULT_PORT).toBe(2567);
  });
});
