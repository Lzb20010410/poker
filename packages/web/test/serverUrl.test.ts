import { describe, expect, it } from 'vitest';

import { DEFAULT_SERVER_PORT, resolveServerUrl, type ServerUrlEnv } from '../src/net/serverUrl';

/** 造一个环境。默认值取自「vite dev + 手机同局域网访问电脑 IP」这个真实场景 */
function env(patch: Partial<ServerUrlEnv> = {}): ServerUrlEnv {
  return {
    isDev: true,
    protocol: 'http:',
    hostname: '192.168.1.20',
    origin: 'http://192.168.1.20:5173',
    ...patch,
  };
}

describe('resolveServerUrl（D-010：直连 Colyseus origin）', () => {
  it('dev 下用 location.hostname 拼 2567，而不是写死 localhost', () => {
    expect(resolveServerUrl(env())).toBe('http://192.168.1.20:2567');
  });

  it('本机开发时拼出来就是 localhost:2567', () => {
    const url = resolveServerUrl(env({ hostname: 'localhost', origin: 'http://localhost:5173' }));
    expect(url).toBe('http://localhost:2567');
  });

  it('端口可以被覆盖（部署时把 Colyseus 放别的端口）', () => {
    expect(resolveServerUrl(env(), 8080)).toBe('http://192.168.1.20:8080');
  });

  it('默认端口常量和服务端约定一致', () => {
    expect(DEFAULT_SERVER_PORT).toBe(2567);
  });

  it('生产构建（非 dev）回落到同源 origin，不带端口', () => {
    const url = resolveServerUrl(env({ isDev: false, origin: 'https://poker.example.com' }));
    expect(url).toBe('https://poker.example.com');
  });

  it('VITE_SERVER_URL 优先级最高，dev 与 prod 都盖得过', () => {
    const devUrl = resolveServerUrl(env({ override: 'https://ws.example.com' }));
    const prodUrl = resolveServerUrl(env({ isDev: false, override: 'https://ws.example.com' }));
    expect(devUrl).toBe('https://ws.example.com');
    expect(prodUrl).toBe('https://ws.example.com');
  });

  it('override 前后的空白和结尾斜杠都被吃掉', () => {
    expect(resolveServerUrl(env({ override: '  https://ws.example.com/  ' }))).toBe('https://ws.example.com');
  });

  it('override 是空串或纯空白时视为没配，继续走 dev/prod 推导', () => {
    expect(resolveServerUrl(env({ override: '' }))).toBe('http://192.168.1.20:2567');
    expect(resolveServerUrl(env({ override: '   ' }))).toBe('http://192.168.1.20:2567');
    expect(resolveServerUrl(env({ isDev: false, override: ' ' }))).toBe(env().origin);
  });

  it('prod 的 origin 带尾斜杠也会被收敛', () => {
    const url = resolveServerUrl(env({ isDev: false, origin: 'https://poker.example.com/' }));
    expect(url).toBe('https://poker.example.com');
  });
});
