/**
 * 前端专用的共享入口 —— 只放"看懂牌桌"要用的东西，不放规则引擎。
 *
 * 为什么要单独一个入口：根入口 `index.ts` 里 `export * from './engine'` 会把手牌评估器一起带出来，
 * 评估器依赖 `pokersolver`（CommonJS，打包器摇不掉），于是整个引擎顺着 barrel 进了浏览器包。
 * 前端真正需要的只有领域类型、牌面文案、配对码、昵称裁剪和协议类型 —— 评估是服务端的事。
 *
 * 这条边界由 `scripts/check-arch.mjs` 规则 7 双向强制：
 * - `packages/web/src` 里出现裸 `@poker-room/shared` 就是违规；
 * - 本文件的值导入闭包里不许出现 `pokersolver`（`engine/random` 是纯函数、零依赖，允许）。
 *
 * 服务端仍然走根入口，它确实要引擎。
 */
export * from './types';
export * from './profile';
export * from './pairing';
export * from './protocol';
// 随机源单独点名导出，不写 `export * from './engine'`：前端要生成默认昵称和头像种子，
// 那是 `engine/random.ts` 的纯函数；同目录下的评估器/边池/状态机属于服务端，一个都不许带。
// （`pairing.ts` 本来就依赖 random，所以这里导出它不会让包多长一字节。）
export { cryptoRandom, randomInt, type RandomSource } from './engine/random';
