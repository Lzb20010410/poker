/**
 * @poker-room/shared — 德州扑克纯规则逻辑
 *
 * 铁律（见 AGENTS.md / DECISIONS.md D-003）：
 * - 本包零 IO、零网络、零框架依赖（不许出现 react / colyseus / express）
 * - 不许直接调用 Math.random()，随机源必须通过 engine/random.ts 注入
 * - 所有金额一律用整数筹码，禁止浮点
 *
 * 对外唯一入口是 engine/table.ts 的 applyAction(state, seat, action) → { newState, events }
 */

export const PACKAGE_NAME = '@poker-room/shared' as const;
export const PACKAGE_VERSION = '0.1.0' as const;
