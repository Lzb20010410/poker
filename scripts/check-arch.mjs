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
 *
 * 关于注释的处理（这里踩过坑，别改坏）：
 *   - 规则 2/3/4 和 `: any` 检查针对的是**代码构造**，必须在「剥离注释后的源码」上跑。
 *     否则文档注释里写一句"不许调用 Math.random()"就会误报 —— M0.1 真的误报过。
 *   - 规则 5 的 `@ts-ignore` 和规则 6 的 `TODO` 本身**就活在注释里**，必须在原始源码上跑。
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
