/**
 * 静音档的持久化（M4.2 验收：「静音开关状态存 localStorage，刷新后保持」）。
 *
 * 这一档和身份**故意分开存**：`state/profile.ts` 存的是「我是谁」，
 * 这里存的是「这台设备要不要响」。后者要跨标签页、跨刷新一直跟着浏览器走，
 * 所以是 localStorage 而不是 sessionStorage——开两个窗口自测联机时两边都出声，
 * 也正是想要的效果（那边窗口里别人的动作有声音，才分得清是谁在操作）。
 *
 * ## 默认值是一条裁定
 *
 * 「静音开关默认开启」这句话有两种读法：开关拨到"静音"，还是音效默认开着。
 * 这里取**默认有声**，理由记在 `DECISIONS.md` D-041。要反过来，改本文件里
 * `DEFAULT_MUTED` 那一个常量就够，其余各层都不动。
 *
 * 读写一律包 try/catch：Safari 无痕模式与「阻止站点数据」下**读**也会抛 `SecurityError`，
 * 不接住就是白屏（`state/profile.ts` 同一个理由）。存不下就这一局记住，刷新回到默认。
 */

export const SOUND_MUTED_KEY = 'poker-room:sound-muted:v1';

/** 默认不静音（见文件头那条裁定） */
const DEFAULT_MUTED = false;

/** 只认这两个字面值：别的（手改的、上一版留下的、垃圾）一律回落默认 */
const MUTED_VALUE = 'muted';
const AUDIBLE_VALUE = 'audible';

export function loadMuted(storage: Storage = window.localStorage): boolean {
  try {
    const raw = storage.getItem(SOUND_MUTED_KEY);
    if (raw === MUTED_VALUE) return true;
    if (raw === AUDIBLE_VALUE) return false;
    return DEFAULT_MUTED;
  } catch {
    return DEFAULT_MUTED;
  }
}

/** 存失败不当回事：静音档丢了不影响这一局能不能打 */
export function saveMuted(muted: boolean, storage: Storage = window.localStorage): void {
  try {
    storage.setItem(SOUND_MUTED_KEY, muted ? MUTED_VALUE : AUDIBLE_VALUE);
  } catch {
    /* 无痕模式下写不进去，这一档就只活在本页 */
  }
}
