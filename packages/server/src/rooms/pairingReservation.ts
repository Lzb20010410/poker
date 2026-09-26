/**
 * 配对码的**本进程预留表**。
 *
 * ## 它挡的是哪一种竞态
 *
 * `onCreate` 里分配配对码要 `await matchMaker` 查一次重。两个房间同时创建时，
 * 它们会各自查到"这个码没人用"，然后第二个把第一个的缓存条目顶掉
 * （Colyseus 不拒绝重复 roomId，见 DECISIONS.md D-009）。
 * 把「占位」挪到 `await` 之前就没这个问题了：Node 单线程里对 `Set` 的同步读写是原子的，
 * 第二个分配器在生成码的那一刻就会拿到 `false`，直接换码，连 matchMaker 都不用问。
 *
 * ## 它挡不了什么
 *
 * 只有本进程。真做多进程/多机部署时这张表各自为政，得换成 Redis 的原子占位
 * （`SET key val NX`）。朋友私局是单台 VPS 单进程（D-000），所以到此为止，
 * 相关记录留在 PROGRESS.md 遗留问题里。
 */
import type { CodeReservation } from '@poker-room/shared';

/** 已被本进程占住、尚未随房间销毁归还的配对码 */
const reservedCodes = new Set<string>();

/** 同步占位。false 表示这个码本进程已经占着，调用方应换码重试 */
export function reservePairingCode(code: string): boolean {
  if (reservedCodes.has(code)) return false;
  reservedCodes.add(code);
  return true;
}

/** 归还占位。幂等：重复释放、释放没占过的码都不抛错 */
export function releasePairingCode(code: string): void {
  reservedCodes.delete(code);
}

/** 这个码是否被本进程占着（测试与排查用，不参与任何判定） */
export function isPairingCodeReserved(code: string): boolean {
  return reservedCodes.has(code);
}

/** 交给 shared 的 `allocatePairingCode` 用；同一张表的两个入口，不是第二套状态 */
export const PAIRING_RESERVATION: CodeReservation = {
  reserve: reservePairingCode,
  release: releasePairingCode,
};
