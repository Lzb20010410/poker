/// <reference types="vite/client" />

/**
 * 扩充 vite 的 `ImportMetaEnv`，给自定义环境变量一个真实类型。
 *
 * vite 自己的定义是 `interface ImportMetaEnv extends Record<`VITE_${string}`, any>`，
 * 也就是**任何 `VITE_*` 都返回 `any`**。这在开了 `@typescript-eslint/no-unsafe-*`
 * 的仓库里是个坑：`import.meta.env.VITE_SERVER_URL` 会一路把 `any` 传染下去，
 * 拼 URL 时写错字段名编译器也不会拦。声明成具体类型之后，`any` 就不出现了。
 *
 * 本文件必须保持是「全局脚本」——不能有顶层 import/export，
 * 否则这个 interface 就变成模块内的局部声明，合并不到 vite 的全局定义上。
 */
interface ImportMetaEnv {
  /**
   * 覆盖 Colyseus 服务端的 origin，例如 `https://poker.example.com`。
   * 留空则按 DEV / PROD 自动推导，见 `net/serverUrl.ts`。
   */
  readonly VITE_SERVER_URL?: string;
}
