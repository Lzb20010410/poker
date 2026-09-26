#!/usr/bin/env node
/**
 * 架构守卫 —— 把 DECISIONS.md D-003 的铁律变成可执行的检查。
 *
 * 为什么是脚本而不是单元测试：这个检查需要读文件系统和 package.json，
 * 而 shared 包本身必须零 IO。把守卫放进 shared 的测试里会自相矛盾
 * （我在 M0.1 就真的犯了这个错，用 node:fs 写了个"纯逻辑包"的测试）。
 * 所以守卫放在仓库根，作为 `pnpm lint` 的一部分运行。
 *
 * 检查项：
 *   1. shared 的 dependencies / peerDependencies 不得含框架
 *   2. shared/src 源码不得 import react / colyseus / express / node:*
 *   3. shared/src 不得出现 Math.random（随机源必须注入）
 *   4. shared/src 不得出现 window / document / process
 *   5. 全仓库不得用 any / @ts-ignore / @ts-expect-error 绕过类型
 *   6. 全仓库不得留下 TODO / FIXME / not implemented / simplified 占位
 *   7. 前端的 shared 导入边界：web 只走 `shared/view`，且 view 的闭包不含 pokersolver
 *   8. server 测试的 `boot()` 端口互不冲突（`@colyseus/testing` 有个写死 2568 的重载）
 *   9. 全仓库源码不得出现真钱交易面（充值 / 提现 / 兑换 / payment / withdraw …）
 *
 * 关于注释的处理（这里踩过坑，别改坏）：
 *   - 规则 2/3/4 和 `: any` 检查针对的是**代码构造**，必须在「剥离注释后的源码」上跑。
 *     否则文档注释里写一句"不许调用 Math.random()"就会误报 —— M0.1 真的误报过。
 *   - 规则 5 的 `@ts-ignore` 和规则 6 的 `TODO` 本身**就活在注释里**，必须在原始源码上跑。
 *   - 规则 9 走的是注释剥离后的代码：项目里"微信分享""配对码回收""非真钱对赌"这些**注释与
 *     免责声明**是刻意写的，扫原始源码会全部误报。字符串字面量会被保留，所以 UI 文案里
 *     真写出「充值」照样能抓到。
 *   剥离时用等量空白/换行替换，以保持行号准确。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHARED_SRC = join(ROOT, 'packages', 'shared', 'src');

const failures = [];
const passes = [];

const fail = (rule, msg) => failures.push(`[${rule}] ${msg}`);
const pass = (rule, msg) => passes.push(`[${rule}] ${msg}`);

/**
 * 剥离注释，但保留行号与字符串字面量内容。
 * 逐字符状态机：正确处理 // 、块注释、以及字符串里出现的 "//"（如 URL）。
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let mode = 'code'; // code | line | block | str
  let quote = '';

  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];

    if (mode === 'block') {
      if (c === '*' && n === '/') {
        mode = 'code';
        out += '  ';
        i += 2;
      } else {
        out += c === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }

    if (mode === 'line') {
      if (c === '\n') {
        mode = 'code';
        out += '\n';
      } else {
        out += ' ';
      }
      i += 1;
      continue;
    }

    if (mode === 'str') {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === quote) mode = 'code';
      i += 1;
      continue;
    }

    // mode === 'code'
    if (c === '/' && n === '*') {
      mode = 'block';
      out += '  ';
      i += 2;
      continue;
    }
    if (c === '/' && n === '/') {
      mode = 'line';
      out += '  ';
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      mode = 'str';
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

const rel = (f) => relative(ROOT, f).replaceAll('\\', '/');

// ---------- 1. shared 包依赖 ----------
const sharedPkg = JSON.parse(readFileSync(join(ROOT, 'packages', 'shared', 'package.json'), 'utf8'));

const FORBIDDEN_DEPS = [
  'react',
  'react-dom',
  'react-router-dom',
  'colyseus',
  '@colyseus/core',
  '@colyseus/schema',
  '@colyseus/sdk',
  'express',
  'vite',
  'gsap',
];
// pokersolver 是纯 JS 手牌评估库，无 IO、无框架，允许
const ALLOWED_RUNTIME_DEPS = ['pokersolver'];

for (const field of ['dependencies', 'peerDependencies']) {
  const deps = Object.keys(sharedPkg[field] ?? {});
  const bad = deps.filter((d) => FORBIDDEN_DEPS.some((f) => d === f || d.startsWith(`${f}/`)));
  if (bad.length) fail('deps', `shared.${field} 含框架依赖: ${bad.join(', ')}`);
}
const runtime = Object.keys(sharedPkg.dependencies ?? {});
const unexpected = runtime.filter((d) => !ALLOWED_RUNTIME_DEPS.includes(d));
if (unexpected.length) {
  fail('deps', `shared.dependencies 出现未白名单的运行时依赖: ${unexpected.join(', ')}`);
}
pass('deps', `shared 运行时依赖 = [${runtime.join(', ') || '空'}]，无框架`);

// ---------- 2-4. shared/src 纯净度（在剥离注释后的源码上检查） ----------
const BANNED_IMPORT =
  /^\s*import\s[^;]*?from\s*['"](react|react-dom|colyseus|@colyseus\/[^'"]+|express|node:[^'"]+)['"]/;
const BANNED_GLOBAL = /(?<![.\w$])(window|document|process)(?![\w$])\s*[.[]/;
const BANNED_RANDOM = /Math\s*\.\s*random\s*\(/;

const sharedFiles = walk(SHARED_SRC);
for (const f of sharedFiles) {
  const code = stripComments(readFileSync(f, 'utf8'));
  code.split('\n').forEach((line, i) => {
    const at = `${rel(f)}:${i + 1}`;
    if (BANNED_IMPORT.test(line)) fail('purity', `${at} 引入了框架/IO 模块: ${line.trim()}`);
    if (BANNED_RANDOM.test(line)) fail('purity', `${at} 直接调用 Math.random()，随机源必须注入`);
    if (BANNED_GLOBAL.test(line)) fail('purity', `${at} 引用了环境全局: ${line.trim()}`);
  });
}
pass('purity', `扫描 shared/src 共 ${sharedFiles.length} 个文件，零 IO / 零框架 / 随机源可控`);

// ---------- 5-6. 全仓库源码质量 ----------
// 注意：ts-ignore 与 TODO 活在注释里，必须查原始源码；`: any` 是代码构造，查剥离后的源码。
const BANNED_DIRECTIVE = /@ts-(ignore|expect-error|nocheck)\b/;
const BANNED_PLACEHOLDER =
  /(TODO|FIXME|XXX\b|not implemented|notImplemented|\bsimplified\b|placeholder implementation|coming soon)/i;
const BANNED_ANY = /(:\s*any\b|<any>|as\s+any\b|\bany\[\])/;

const allFiles = walk(join(ROOT, 'packages'));
for (const f of allFiles) {
  const raw = readFileSync(f, 'utf8');
  const code = stripComments(raw);

  raw.split('\n').forEach((line, i) => {
    const at = `${rel(f)}:${i + 1}`;
    if (BANNED_DIRECTIVE.test(line)) fail('types', `${at} 使用了类型逃逸指令: ${line.trim()}`);
    if (BANNED_PLACEHOLDER.test(line)) fail('placeholder', `${at} 留下占位标记: ${line.trim()}`);
  });

  code.split('\n').forEach((line, i) => {
    const at = `${rel(f)}:${i + 1}`;
    if (BANNED_ANY.test(line)) fail('types', `${at} 使用了 any: ${line.trim()}`);
  });
}
pass('types', `扫描 packages 下 ${allFiles.length} 个 ts/tsx 文件，无 any / ts-ignore 逃逸`);
pass('placeholder', '无 TODO / FIXME / not implemented / simplified 占位');

// ---------- 7. 前端的 shared 导入边界（DECISIONS.md D-019） ----------
/**
 * 两头一起挡：
 *   7a. `packages/web/src` 必须从 `@poker-room/shared/view` 取东西。裸根入口会顺着
 *       `export * from './engine'` 把评估器（连带 CommonJS 的 pokersolver，摇不掉）拖进浏览器包。
 *   7b. `view.ts` 的**值导入闭包**里不许出现 pokersolver。只查 7a 不够：
 *       谁在 view 里补一句 `export * from './engine'`，边界就又漏了。
 */
const WEB_SRC = join(ROOT, 'packages', 'web', 'src');
const BANNED_WEB_IMPORT = /from\s*['"]@poker-room\/shared['"]/;
const webFiles = walk(WEB_SRC);
for (const f of webFiles) {
  const code = stripComments(readFileSync(f, 'utf8'));
  code.split('\n').forEach((line, i) => {
    if (BANNED_WEB_IMPORT.test(line)) {
      fail('boundary', `${rel(f)}:${i + 1} 前端从 shared 根入口导入，会连带打包规则引擎：改用 @poker-room/shared/view`);
    }
  });
}
pass('boundary', `扫描 web/src 共 ${webFiles.length} 个文件，前端只走 shared 的 view 入口`);

// import 语句抽取：`import ... from 'x'` / `export ... from 'x'`，以及裸 `import 'x'`。
// `import type` 与 `export type` 在编译后消失，不算把运行时拉进来的那一个。
const IMPORT_SPECIFIER =
  /(?:^|\s)(?:import|export)\b([^;]*?)\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;

function importedSpecifiers(src) {
  const out = [];
  for (const match of stripComments(src).matchAll(IMPORT_SPECIFIER)) {
    const clause = match[1] ?? '';
    const specifier = match[2] ?? match[3];
    // `import { type A, B } from ...` 里只要还有一个非 type 的值导入，就得跟进去；
    // 整条是 `import type` / `export type` 的才跳过。
    const isTypeOnly = /^\s*type\b/.test(clause.trim());
    if (!isTypeOnly) out.push(specifier);
  }
  return out;
}

/** 从某个入口文件出发，沿相对路径的值导入做闭包 */
function valueImportClosure(entryFile) {
  const seen = new Set();
  const queue = [entryFile];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of importedSpecifiers(readFileSync(file, 'utf8'))) {
      if (!specifier.startsWith('.')) continue;
      const target = join(file, '..', specifier);
      const candidates = [`${target}.ts`, `${target}/index.ts`];
      const resolved = candidates.find((c) => statSync(c, { throwIfNoEntry: false })?.isFile());
      if (resolved !== undefined && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return [...seen];
}

const VIEW_ENTRY = join(SHARED_SRC, 'view.ts');
if (!statSync(VIEW_ENTRY, { throwIfNoEntry: false })?.isFile()) {
  fail('boundary', 'packages/shared/src/view.ts 不存在，前端边界无从检查');
} else {
  const closure = valueImportClosure(VIEW_ENTRY);
  const leaked = [];
  for (const f of closure) {
    if (/(^|[\\/])pokersolver/.test(rel(f))) leaked.push(rel(f));
    for (const specifier of importedSpecifiers(readFileSync(f, 'utf8'))) {
      if (specifier === 'pokersolver' || specifier.startsWith('pokersolver/')) {
        leaked.push(`${rel(f)} 导入了 ${specifier}`);
      }
    }
  }
  if (leaked.length) {
    fail('boundary', `shared/view 的值导入闭包触碰了 pokersolver，前端包会被塞进规则引擎：\n        ${leaked.join('\n        ')}`);
  } else {
    pass('boundary', `shared/view 闭包 ${closure.length} 个文件（${closure.map((f) => rel(f).replace('packages/shared/src/', '')).join(', ')}），不含 pokersolver`);
  }
}

// ---------- 8. server 测试端口唯一（DECISIONS.md D-015 / PROGRESS 遗留问题） ----------
/**
 * `@colyseus/testing` 的 `boot(Server)` 重载**忽略**第二个参数，内部写死 2568。
 * 三个网络测试文件各占一个端口（2568/2569/2570）是靠注释和记忆维持的，
 * 而它们默认并行跑：第四个人一旦也吃 2568，就会在 `beforeAll` 里 EADDRINUSE，
 * 报的还不是端口问题。所以把这件事变成检查而不是注释。
 *
 * 端口来源两种：
 *   - `boot(config, 2569)` —— 显式数字字面量（只有字面量算数，变量在检查期没有值）
 *   - `boot(server)`      —— 隐含的 2568；用这条的文件必须**显式写出** 2568，
 *                            等于承认"我吃的是上游写死的默认端口"
 * 另外禁止占用 2567（dev 服务端）与 5173（vite dev）。
 */
const SERVER_TEST_DIR = join(ROOT, 'packages', 'server', 'test');
const IMPLICIT_TEST_PORT = 2568;
const FORBIDDEN_TEST_PORTS = [2567, 5173];

/** 取 `callName(` 之后配对括号内的实参文本，按顶层逗号切（嵌套括号/方括号/字符串不切） */
function callArguments(code, callName) {
  const out = [];
  const opener = new RegExp(`\\b${callName}\\(\\s*`, 'g');
  for (const match of code.matchAll(opener)) {
    let i = match.index + match[0].length;
    let depth = 1;
    let quote = '';
    let current = '';
    const args = [];
    while (i < code.length && depth > 0) {
      const c = code[i];
      if (quote !== '') {
        if (c === '\\') { current += c + (code[i + 1] ?? ''); i += 2; continue; }
        if (c === quote) quote = '';
        current += c;
      } else if (c === '"' || c === "'" || c === '`') {
        quote = c;
        current += c;
      } else if (c === '(' || c === '[' || c === '{') {
        depth += 1;
        current += c;
      } else if (c === ')' || c === ']' || c === '}') {
        depth -= 1;
        if (depth === 0 && (c === ')')) break;
        current += c;
      } else if (c === ',' && depth === 1) {
        args.push(current.trim());
        current = '';
      } else {
        current += c;
      }
      i += 1;
    }
    if (depth !== 0) {
      out.push({ incomplete: true, args: [] });
      continue;
    }
    if (current.trim() !== '') args.push(current.trim());
    out.push({ incomplete: false, args });
  }
  return out;
}

const portOwners = new Map();
if (!statSync(SERVER_TEST_DIR, { throwIfNoEntry: false })?.isDirectory()) {
  fail('ports', 'packages/server/test 目录不存在，端口守卫无从检查');
} else {
  const serverTestFiles = walk(SERVER_TEST_DIR).filter((f) => /\.test\.tsx?$/.test(f));
  const portFailuresBefore = failures.length;
  for (const f of serverTestFiles) {
    const code = stripComments(readFileSync(f, 'utf8'));
    for (const { incomplete, args } of callArguments(code, 'boot')) {
      const at = `${rel(f)}`;
      if (incomplete) {
        fail('ports', `${at} 有一个括号没配对的 boot() 调用，端口检查无法解析它`);
        continue;
      }
      const explicit = args.length >= 2 && /^\d+$/.test(args[1] ?? '');
      const port = explicit ? Number(args[1]) : IMPLICIT_TEST_PORT;
      if (!explicit && !/\b2568\b/.test(code)) {
        fail('ports', `${at} 用了 boot(<Server>) 这个**隐含 2568** 的重载，却没在文件里写出 2568；` +
          '要么改成 boot(config, <端口>)，要么显式承认默认端口（见 integration.test.ts 的写法）');
      }
      if (FORBIDDEN_TEST_PORTS.includes(port)) {
        fail('ports', `${at} 占用了 ${port}，那是${port === 2567 ? ' dev 服务端' : ' vite dev'}的端口`);
      }
      const seen = portOwners.get(port);
      if (seen !== undefined && seen !== at) {
        fail('ports', `端口 ${port} 被 ${seen} 和 ${at} 同时占用，并行跑会 EADDRINUSE —— 给它换一个`);
      }
      portOwners.set(port, at);
    }
  }
  const summary = [...portOwners.entries()].sort((a, b) => a[0] - b[0])
    .map(([port, at]) => `${port}→${at.split('/').pop()}`)
    .join(', ');
  // 只在真的零违规时说"互不冲突"：否则一边报违规一边打 OK 会误导人（探针实测过这个输出）
  if (failures.length === portFailuresBefore) {
    pass('ports', `扫描 ${serverTestFiles.length} 个 server 测试文件，boot() 端口互不冲突（${summary || '没有 boot() 调用'}）`);
  }
}

// ---------- 9. 真钱交易面零容忍（README 顶部铁律：纯虚拟筹码，不做充值/兑换/回收/提现，连接口都不留） ----------
/**
 * 这条铁律一旦破了，项目性质就从"朋友私局的虚拟筹码"变成"可被认定为真钱赌博的线上棋牌"，
 * 不是风格问题而是法律风险；而且它**只会被人遗忘**：某个后续任务顺手加一个"补筹码"按钮，
 * 或引入一个支付 SDK 的字段名，全绿的测试一个都不会红。所以让它必须红。
 *
 * 判定面：注释剥离后的代码（含字符串字面量）。因此
 *   - 命中 = 字段名 / 路由 / 函数名 / 依赖名 / **UI 文案**里写出真钱概念；
 *   - 不命中 = 注释与文档里陈述这条禁令本身（"不做充值"是必须能写的）。
 * `回收 / 现金 / 真钱 / 微信` 刻意**不在**名单里：它们在本项目的注释和免责声明里是正当用词
 * （配对码回收、非真钱对赌、微信分享链接），列进来只会训练人关掉守卫。
 */
const BANNED_MONEY =
  /(充值|提现|兑换|recharge|top[\s_-]?up|withdraw|deposit|cash[\s_-]?out|redeem|billing|invoice|payment|paypal|alipay|wechatpay|apple\s?pay|stripe)/i;

const moneyFailuresBefore = failures.length;
for (const f of allFiles) {
  const code = stripComments(readFileSync(f, 'utf8'));
  code.split('\n').forEach((line, i) => {
    if (!BANNED_MONEY.test(line)) return;
    const at = `${rel(f)}:${i + 1}`;
    const hits = [...new Set(line.match(new RegExp(BANNED_MONEY.source, 'gi')) ?? [])].join(', ');
    fail('no-real-money', `${at} 触碰真钱交易面（命中：${hits}）：${line.trim()}`);
  });
}
if (failures.length === moneyFailuresBefore) {
  pass('no-real-money', `扫描 packages 下 ${allFiles.length} 个 ts/tsx 文件的代码（含字符串字面量），无真钱交易面`);
}

// ---------- 自检：确认实参切分能认出两种 boot 写法 ----------
{
  const probe = [
    "const a = await boot({ rooms: { poker: defineRoom(PokerRoom) }, initializeExpress: true }, 2569);",
    'const b = await boot(createGameServer());',
    'const c = await boot(cfg, OTHER_PORT);',
  ].join('\n');
  const parsed = callArguments(probe, 'boot');
  if (parsed.length !== 3) fail('selftest', `boot() 解析出 ${parsed.length} 个调用，应为 3`);
  else if (parsed[0].args.length !== 2 || parsed[0].args[1] !== '2569')
    fail('selftest', '带嵌套对象/函数的 boot(config, 2569) 没有被正确切成两个实参');
  else if (parsed[1].args.length !== 1)
    fail('selftest', '单参数 boot(server) 重载被误认成带显式端口');
  else if (/^\d+$/.test(parsed[2].args[1] ?? ''))
    fail('selftest', '变量端口被当成数字字面量（检查期没有值，必须拒绝认它）');
  else pass('selftest', 'boot() 实参切分：显式字面量端口 / 单参数重载 / 变量端口各归其位');
}

// ---------- 自检：确认真钱名单"该抓的抓到、注释里的免责陈述不误伤" ----------
{
  const sample = [
    'const label = "充值"; // 按钮文案',
    'export interface RechargeRequest { }',
    'router.post("/withdraw", handler);',
    '// 本项目不做充值 / 提现 / 兑换，连接口都不留。',
    '/* 免责声明：私人朋友局用途，非商业运营，不涉及任何真实价值交换 */',
    'const chips = account.chips + amount; // 配对码回收，不是筹码回收',
  ].join('\n');
  const stripped = stripComments(sample).split('\n');
  const flagged = stripped.map((line, i) => (BANNED_MONEY.test(line) ? i + 1 : 0)).filter(Boolean);
  if (stripped.length !== 6) fail('selftest', `真钱自检的注释剥离破坏行数：${stripped.length}，应为 6`);
  else if (flagged.join(',') !== '1,2,3')
    fail('selftest', `真钱自检命中 ${flagged.join(', ') || '无'}，应为 1,2,3（代码里的 充值/Recharge/withdraw 各一条）`);
  else pass('selftest', '真钱名单：代码与 UI 文案命中，注释里的禁令与免责声明不命中');
}

// ---------- 自检：确认注释剥离没有把真代码也剥掉 ----------
{
  const probe = stripComments(
    ['/* 块注释', ' * 提到 Math.random() 不该报', ' */', 'const a = 1; // 行注释 http://x', 'Math.random();'].join(
      '\n',
    ),
  );
  const probeLines = probe.split('\n');
  if (probeLines.length !== 5) fail('selftest', `注释剥离破坏了行数: 得到 ${probeLines.length} 行，应为 5`);
  else if (!BANNED_RANDOM.test(probeLines[4] ?? ''))
    fail('selftest', '注释剥离把真实代码也剥掉了');
  else if (BANNED_RANDOM.test(probeLines[1] ?? ''))
    fail('selftest', '注释剥离没有生效，块注释内容仍被扫描');
  else pass('selftest', '注释剥离保持行号、保留字符串、只去注释');
}

// ---------- 输出 ----------
console.log('\n架构守卫 check-arch.mjs');
console.log('='.repeat(60));
for (const p of passes) console.log(`  OK  ${p}`);
if (failures.length) {
  console.log('\n  FAIL 违规：');
  for (const f of failures) console.log(`     ${f}`);
  console.log(`\n共 ${failures.length} 项违规。修完再提交。\n`);
  process.exit(1);
}
console.log(`\n  全部通过（${passes.length} 项检查）。\n`);
