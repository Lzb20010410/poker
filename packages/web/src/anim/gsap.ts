/**
 * GSAP 的唯一入口：在这里注册插件，别处一律 `import { gsap } from './gsap'`。
 *
 * 为什么单独一个文件：`MotionPathPlugin` 是**注册过才生效**的全局副作用
 * （没注册时 `motionPath` 会被 GSAP 静默忽略，牌就变成直线飞）。
 * 这件事必须只发生一次、且发生在任何动画之前，所以把它放在模块顶层，
 * 而不是散在五个 `draw/` 文件里各注册一遍。
 */

import gsap from 'gsap';
import { MotionPathPlugin } from 'gsap/MotionPathPlugin';

gsap.registerPlugin(MotionPathPlugin);

export { gsap };
