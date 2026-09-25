/**
 * @poker-room/server — Colyseus 服务端入口
 *
 * 分层职责（见 SPEC.md §1.2）：本包只做「权威判定 + 同步 + 房间生命周期」，
 * 游戏规则一律调用 @poker-room/shared/engine，禁止在这里重复实现。
 *
 * M0.1 阶段仅为占位，M0.3 才接入真实房间。
 */

export const SERVER_PACKAGE = '@poker-room/server' as const;
export const DEFAULT_PORT = Number(process.env['PORT'] ?? 2567);
