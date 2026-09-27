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

  /**
   * 以 `/` 开头的 override 是「同源的某个前缀」，不是完整地址。
   *
   * 存在的理由只有一个：nginx 把静态产物和游戏服放在同一个域名下，游戏服挂在
   * `/ws` 前缀后面（SPEC §5.1）。构建镜像时写死 `https://poker.example.com/ws`
   * 就把域名烧进了产物——换域名、加测试环境都要重新 build。所以配置里只写 `/ws`，
   * 域名交给浏览器在运行时补。
   */
  it('override 以单个斜杠开头时按同源补全，不写死域名', () => {
    expect(resolveServerUrl(env({ isDev: false, origin: 'https://poker.example.com', override: '/ws' }))).toBe(
      'https://poker.example.com/ws',
    );
  });

  it('同源前缀在 dev 下也照补（拿本机页面地址去连同一台机器的代理）', () => {
    expect(resolveServerUrl(env({ override: '/ws' }))).toBe('http://192.168.1.20:5173/ws');
  });

  it('同源前缀的尾斜杠与空白同样收敛', () => {
    expect(
      resolveServerUrl(env({ isDev: false, origin: 'https://poker.example.com', override: '  /ws/  ' })),
    ).toBe('https://poker.example.com/ws');
  });

  it('origin 自带端口时补全不会把端口丢掉', () => {
    expect(resolveServerUrl(env({ isDev: false, origin: 'http://192.168.1.20:8080', override: '/ws' }))).toBe(
      'http://192.168.1.20:8080/ws',
    );
  });

  /**
   * `//host/path` 在 URL 语法里是「协议相对」的另一个地址，不是同源前缀。
   * 把它当路径拼会变成 `https://本页//host/ws` 这种谁都不指的东西，
   * 所以这一条走原样返回（和绝对 override 同一处理），让它去 SDK 里显式失败。
   */
  it('双斜杠开头不当作同源前缀', () => {
    expect(resolveServerUrl(env({ isDev: false, origin: 'https://poker.example.com', override: '//other/ws' }))).toBe(
      '//other/ws',
    );
  });
});
