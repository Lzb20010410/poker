/**
 * 重连凭证（`reconnectionToken`）的存放。
 *
 * 只存**这一个标签页**的身份，所以用 `sessionStorage` 而不是 `localStorage`：
 * 朋友之间常干的事是把同一个配对码在两个标签页里各开一份（自己看一眼、
 * 或者拿手机扫码后电脑上留个参照）。存 `localStorage` 的话，第二个标签页
 * 刷新时会拿着第一个标签页的凭证去 reconnect，结果两个标签页变成同一个人，
 * 服务端那边只有一份座位和一份底牌。
 *
 * key 里带 `serverUrl`：本地 2567、局域网 IP、以后真机的域名会互相污染，
 * 换一个后端却拿着旧凭证重连，只会得到一个莫名其妙的失败。
 *
 * 所有读写都包在 `try` 里：隐私模式 / 存储被禁的浏览器里 `sessionStorage`
 * 一碰就抛。刷新恢复是**锦上添花**，不该成为进房的前置条件。
 */

/** 能存取字符串的最小形状。`sessionStorage` 满足它，测试用内存 Map 满足它 */
export interface RawTokenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function tokenKey(serverUrl: string, code: string): string {
  return `poker:reconnect:${serverUrl}:${code}`;
}

/** 没有仓库（`null`）和读失败都返回 null：调用方按「新玩家加入」处理 */
export function readToken(store: RawTokenStorage | null, key: string): string | null {
  if (store === null) return null;
  try {
    return store.getItem(key);
  } catch {
    // 存储被禁用。当作没有凭证，游戏照玩。
    return null;
  }
}

export function saveToken(store: RawTokenStorage | null, key: string, token: string): void {
  if (store === null) return;
  try {
    store.setItem(key, token);
  } catch {
    // 写不进去只影响「刷新后能否回到同一身份」，不值得把牌桌搞崩。
  }
}

export function clearToken(store: RawTokenStorage | null, key: string): void {
  if (store === null) return;
  try {
    store.removeItem(key);
  } catch {
    // 同上。
  }
}
