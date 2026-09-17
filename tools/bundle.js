'use strict';

/**
 * 极简 CommonJS 打包器（零第三方依赖）
 *
 * 为什么需要它：Node 的 SEA（单文件可执行程序）对入口脚本的 `require()`
 * **只支持内置模块** —— `require('./server')`、`require('../package.json')`
 * 都会抛 ERR_UNKNOWN_BUILTIN_MODULE。因此要生成可独立运行的 exe，
 * 必须先把 src/ 下的所有源码合并成一个自包含文件。
 *
 * 实现方式：把每个文件包成 `__define(id, factory)`，运行时用一张模块表
 * 实现 require 解析（含相对路径归一化与 node_modules 查找），
 * 内置模块直接交给 Node 的真实 require。
 *
 * 用法：
 *   const { bundle } = require('./tools/bundle');
 *   const code = bundle(path.join(ROOT, 'src'), path.join(ROOT, 'src', 'sea-entry.js'));
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');

/** Node 内置模块集合（含 node: 前缀） */
const BUILTINS = new Set(Module.builtinModules);

/** 判断是否为内置模块引用 */
function isBuiltin(request) {
  const bare = request.startsWith('node:') ? request.slice(5) : request;
  return BUILTINS.has(bare) || BUILTINS.has(request);
}

/** 解析 import 说明符：优先 .js，其次 /index.js，最后尝试 .json */
function resolveFile(fromFile, request) {
  const base = request.startsWith('.')
    ? path.resolve(path.dirname(fromFile), request)
    : null;
  if (!base) return null; // 第三方包：本项目零依赖，视为外部
  const candidates = [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (_) {
      /* 继续尝试 */
    }
  }
  return null;
}

/** 收集从 entry 可达的所有本地模块（含 .json） */
function collect(entry) {
  const files = new Map(); // 绝对路径 -> { source, isJson }
  const queue = [entry];

  while (queue.length) {
    const file = queue.shift();
    if (files.has(file)) continue;

    const raw = fs.readFileSync(file, 'utf8');
    const isJson = file.endsWith('.json');
    files.set(file, { source: raw, isJson });
    if (isJson) continue;

    // 提取 require('...') / require("...") 的说明符
    const re = /require\(\s*(['"])([^'"]+)\1\s*\)/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      const spec = m[2];
      if (isBuiltin(spec) || !spec.startsWith('.')) continue;
      const resolved = resolveFile(file, spec);
      if (!resolved) {
        throw new Error(`${path.relative(process.cwd(), file)} 中无法解析依赖 "${spec}"`);
      }
      if (!files.has(resolved)) queue.push(resolved);
    }
  }
  return files;
}

/**
 * 生成自包含代码
 * @param {string} rootDir 项目根（用于生成稳定的模块 id）
 * @param {string} entryFile 入口文件绝对路径
 * @returns {{ code: string, modules: number, bytes: number }}
 */
function bundle(rootDir, entryFile) {
  const files = collect(entryFile);
  const idOf = (file) => path.relative(rootDir, file).split(path.sep).join('/');

  const parts = [];
  parts.push('/* NetScope 打包产物 —— 由 tools/bundle.js 生成，请勿手工修改 */');
  parts.push("'use strict';");
  parts.push('(function () {');
  parts.push('  var __modules = {};');
  parts.push('  var __cache = {};');
  parts.push('  function __define(id, factory) { __modules[id] = factory; }');
  parts.push('  function __normalize(from, request) {');
  parts.push('    var parts = (from.split("/").slice(0, -1)).concat(request.split("/"));');
  parts.push('    var out = [];');
  parts.push('    for (var i = 0; i < parts.length; i += 1) {');
  parts.push('      var seg = parts[i];');
  parts.push('      if (seg === "" || seg === ".") continue;');
  parts.push('      if (seg === "..") { out.pop(); continue; }');
  parts.push('      out.push(seg);');
  parts.push('    }');
  parts.push('    return out.join("/");');
  parts.push('  }');
  parts.push('  function __resolve(from, request) {');
  parts.push('    var base = request.charAt(0) === "." ? __normalize(from, request) : request;');
  parts.push('    var tries = [base, base + ".js", base + ".json", base + "/index.js"];');
  parts.push('    for (var i = 0; i < tries.length; i += 1) {');
  parts.push('      if (Object.prototype.hasOwnProperty.call(__modules, tries[i])) return tries[i];');
  parts.push('    }');
  parts.push('    return null;');
  parts.push('  }');
  parts.push('  function __require(from, request) {');
  parts.push('    if (__isBuiltin(request)) return require(request);');
  parts.push('    var id = __resolve(from, request);');
  parts.push('    if (!id) throw new Error("模块未打包: " + request + " (来自 " + from + ")");');
  parts.push('    if (__cache[id]) return __cache[id].exports;');
  parts.push('    var factory = __modules[id];');
  parts.push('    var mod = { id: id, exports: {} };');
  parts.push('    __cache[id] = mod;');
  parts.push('    factory(mod, mod.exports, function (req) { return __require(id, req); }, id);');
  parts.push('    return mod.exports;');
  parts.push('  }');
  parts.push('  var __builtins = ' + JSON.stringify([...BUILTINS].sort()) + ';');
  parts.push('  var __builtinSet = {};');
  parts.push('  for (var __i = 0; __i < __builtins.length; __i += 1) __builtinSet[__builtins[__i]] = true;');
  parts.push('  function __isBuiltin(request) {');
  parts.push('    return request.indexOf("node:") === 0 || __builtinSet[request] === true;');
  parts.push('  }');
  parts.push('');

  for (const [file, info] of files) {
    const id = idOf(file);
    if (info.isJson) {
      parts.push(`  __define(${JSON.stringify(id)}, function (module) { module.exports = ${info.source.trim()}; });`);
    } else {
      parts.push(`  __define(${JSON.stringify(id)}, function (module, exports, require, __filename) {`);
      // 让源码里的 require 走打包器；__filename 保留原始 id 以便相对解析
      parts.push(info.source);
      parts.push('  });');
    }
    parts.push('');
  }

  const entryId = idOf(entryFile);
  parts.push(`  __require(${JSON.stringify(entryId)}, ${JSON.stringify('./' + path.basename(entryId))});`);
  parts.push('})();');

  const code = parts.join('\n');
  return { code, modules: files.size, bytes: Buffer.byteLength(code, 'utf8'), ids: [...files.keys()].map(idOf) };
}

module.exports = { bundle, collect, isBuiltin, resolveFile };

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const entry = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'src', 'sea-entry.js');
  const out = process.argv[3] ? path.resolve(process.argv[3]) : path.join(root, 'build', 'bundle.js');
  const result = bundle(root, entry);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, result.code, 'utf8');
  console.log('bundled modules: ' + result.modules);
  console.log('output: ' + out + ' (' + (result.bytes / 1024).toFixed(1) + ' KB)');
  console.log('files:');
  result.ids.forEach((id) => console.log('  ' + id));
}
