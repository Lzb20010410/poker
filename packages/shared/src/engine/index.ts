/**
 * @poker-room/shared/engine —— 规则引擎对外入口。
 *
 * 分层铁律（AGENTS.md / DECISIONS.md D-003）：本目录下的所有模块都是纯函数或
 * 纯数据结构，零 IO、零框架依赖、随机源可注入。服务端与前端都可以直接 import，
 * 但**只有服务端有权用它的结果做判定**——前端只用它做展示，绝不用它决定合法性。
 */

export * from './betting';
export * from './deck';
export * from './errors';
export * from './evaluator';
export * from './random';
export * from './sidepot';
export * from './table';
