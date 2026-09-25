/**
 * 玩家资料规范化 —— 客户端与服务端共用同一套规则。
 *
 * 为什么要放在 shared：昵称长度和字符规则如果两端各写一份，一定会漂移
 * （前端限 16 字、后端限 20 字这种）。**前端做软提示，服务端做最终裁剪**，
 * 但两者必须引用同一个常量与同一个函数。
 *
 * 安全考量（不是洁癖，是真实攻击面）：
 * - 剥掉 C0/C1 控制字符：否则昵称里能塞终端转义序列，污染服务端日志
 * - 剥掉零宽字符与 BOM：否则两个"看起来一样"的昵称其实不同，玩家会认错人
 * - 剥掉 bidi 控制符（U+202A–U+202E、U+2066–U+2069）：RTL override 能把
 *   "admin.evil" 显示成 "live.nimda"，是经典的昵称伪装手法
 * - 按**码点**而不是 UTF-16 单元截断：否则会把 emoji 或代理对从中间劈开
 *
 * 实现上刻意用「码点谓词」而不是正则字符类：一来避免 no-control-regex，
 * 二来每个被剥掉的码点都能在这儿一行一个地读出来，改动时可评审。
 */

/** 昵称最大长度（码点数，不是字节数）。前端输入框的 maxLength 也用这个值 */
export const MAX_NICKNAME_LENGTH = 16;

/**
 * 必须剥掉的零宽 / 方向控制码点。
 *
 * **刻意不包含 ZWNJ(U+200C) 与 ZWJ(U+200D)**：它们是 emoji 组合序列
 * （👨‍👩‍👧、🏳️‍🌈）的必要成分，剥掉会把玩家昵称里的 emoji 拆散。
 * 代价是理论上可用 ZWJ 构造视觉混淆，但昵称经 React 转义渲染、
 * 且长度上限 16 码点，风险可接受。
 */
const STRIPPED_CODE_POINTS: ReadonlySet<number> = new Set([
  0x200b, // 零宽空格
  0x200e, // LRM
  0x200f, // RLM
  0x2060, // word joiner
  0xfeff, // BOM
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, // LRE RLE PDF LRO RLO
  0x2066, 0x2067, 0x2068, 0x2069, // LRI RLI FSI PDI
]);

/** 连续空白压成一个空格（含 \t \n \r 与 \u00A0 等 Unicode 空白） */
const WHITESPACE_RUN = /\s+/g;

/**
 * 把任意用户输入规范化成一个可安全展示的昵称。
 *
 * 永远返回非空字符串：清洗后为空时用 `fallback`。
 * 不抛错——昵称不合法不是致命错误，兜底比拒绝更合适（玩家不需要为了一个
 * 怪字符被挡在房间外）。
 *
 * @param raw      客户端传来的原始值，类型未知（服务端永远不能信任客户端）
 * @param fallback raw 清洗后为空时使用的名字，由调用方生成（例如 `玩家a1b2`）
 */
export function sanitizeNickname(raw: unknown, fallback: string): string {
  const cleaned = clean(raw);
  if (cleaned.length > 0) return cleaned;
  const cleanedFallback = clean(fallback);
  return cleanedFallback.length > 0 ? cleanedFallback : '玩家';
}

function clean(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  // 先压空白再剥控制字符：\t \n \r 属于 C0 控制区，但玩家是拿它当空格用的，
  // 顺序反过来会把 "A\t\tB" 变成 "AB" 而不是 "A B"。
  // 非空断言安全：对字符串做扩展运算符得到的一定是非空码点子串，codePointAt(0) 必有值。
  const text = [...String(value).replace(WHITESPACE_RUN, ' ')]
    .filter((ch) => !isStrippedCodePoint(ch.codePointAt(0)!))
    .join('')
    .trim();
  return truncateByCodePoint(text, MAX_NICKNAME_LENGTH);
}

/** C0 / DEL / C1 控制字符，加上 STRIPPED_CODE_POINTS 里的零宽与 bidi 控制符 */
function isStrippedCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    STRIPPED_CODE_POINTS.has(codePoint)
  );
}

/** 按码点截断，避免劈开代理对（emoji、部分 CJK 扩展字） */
export function truncateByCodePoint(text: string, maxCodePoints: number): string {
  if (maxCodePoints <= 0) return '';
  const points = [...text];
  if (points.length <= maxCodePoints) return text;
  return points.slice(0, maxCodePoints).join('');
}
