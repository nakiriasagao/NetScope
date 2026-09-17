'use strict';

/**
 * NetScope 测试汇总入口（零第三方依赖）
 *
 * ⚠ 默认请用「增量测试」：只运行与本次改动相关的用例，几秒到几十秒即可完成。
 *
 * 用法：
 *   node test/run-tests.js --only=unit          # 只跑单元测试（最快，改纯逻辑必备）
 *   node test/run-tests.js --only=unit,color    # 跑多个
 *   node test/run-tests.js --list               # 列出所有可用的测试名
 *   node test/run-tests.js --only=map           # 按分组跑（map=地图/底图/拓扑类）
 *   node test/run-tests.js --all                # 全量测试（含浏览器验收，耗时较长，仅在发布前跑）
 *   node test/run-tests.js                      # 默认：单元测试 + 接口冒烟（不跑浏览器）
 *
 * 测试名（--only= 可用的值）：
 *   unit      单元测试                     smoke     接口冒烟
 *   lan       局域网拓扑验收               color     节点着色规则
 *   amap      高德底图验收                 switch    底图切换与跳数标签
 *   style     图例与样式一致性             lantrace  局域网扫描后再探测
 *   viewswitch 视图切换与底图保持          topoperf  两种拓扑显示与性能
 *   graphtrace 探测外网的逻辑拓扑          amapgraph 高德底图的逻辑拓扑
 *   keepview  切底图保持视图               lanlock   局域网锁定世界地图
 *   map       地图/底图/拓扑类（以上浏览器用例的合集）
 *   all       全部
 *
 * 环境变量：
 *   NS_BASE=http://127.0.0.1:8787   服务地址（冒烟与浏览器验收共用）
 *   NS_SKIP_SMOKE=1                 强制跳过冒烟测试
 *   NS_WITH_BROWSER=1               等价于 --only=all
 *   NS_AMAP_KEY / NS_AMAP_SECURITY  高德凭据（不传则从服务端配置读取，读不到则跳过）
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const UNIT_FILE = path.join(__dirname, 'unit.test.js');
const SMOKE_FILE = path.join(__dirname, 'smoke-api.js');
const LAN_FILE = path.join(__dirname, 'lan-topology-e2e.js');
const AMAP_FILE = path.join(__dirname, 'amap-e2e.js');
const COLOR_FILE = path.join(__dirname, 'node-color-check.js');
const SWITCH_FILE = path.join(__dirname, 'map-switch-e2e.js');
const STYLE_FILE = path.join(__dirname, 'style-consistency-e2e.js');
const LAN_TRACE_FILE = path.join(__dirname, 'lan-then-trace-e2e.js');
const VIEW_SWITCH_FILE = path.join(__dirname, 'view-switch-basemap-e2e.js');
const TOPO_PERF_FILE = path.join(__dirname, 'topology-perf-e2e.js');
const GRAPH_TRACE_FILE = path.join(__dirname, 'graph-trace-e2e.js');
const AMAP_GRAPH_FILE = path.join(__dirname, 'amap-graph-e2e.js');
const KEEP_VIEW_FILE = path.join(__dirname, 'basemap-keep-view-e2e.js');
const LAN_LOCK_FILE = path.join(__dirname, 'lan-lock-view-e2e.js');
const ADMIN1_FILE = path.join(__dirname, 'admin1-map-e2e.js');
const CACHE_FILE = path.join(__dirname, 'map-cache-e2e.js');

/**
 * 测试注册表：name → { file, title, kind, group }
 * kind: 'node' 用 node --test 运行；'script' 直接运行（退出码即结论）
 */
const REGISTRY = {
  unit: { file: UNIT_FILE, title: '单元测试', kind: 'node', group: 'core' },
  smoke: { file: SMOKE_FILE, title: '接口冒烟', kind: 'node', group: 'core' },
  lan: { file: LAN_FILE, title: '局域网拓扑验收', kind: 'script', group: 'map', browser: true },
  color: { file: COLOR_FILE, title: '节点着色规则', kind: 'script', group: 'map', browser: true },
  amap: { file: AMAP_FILE, title: '高德底图验收', kind: 'script', group: 'map', browser: true, amap: true },
  switch: { file: SWITCH_FILE, title: '底图切换与跳数标签', kind: 'script', group: 'map', browser: true, amap: true },
  style: { file: STYLE_FILE, title: '图例与样式一致性', kind: 'script', group: 'map', browser: true, amap: true },
  lantrace: { file: LAN_TRACE_FILE, title: '局域网扫描后再探测', kind: 'script', group: 'map', browser: true, amap: true },
  viewswitch: { file: VIEW_SWITCH_FILE, title: '视图切换与底图保持', kind: 'script', group: 'map', browser: true, amap: true },
  topoperf: { file: TOPO_PERF_FILE, title: '两种拓扑显示与性能', kind: 'script', group: 'map', browser: true },
  graphtrace: { file: GRAPH_TRACE_FILE, title: '探测外网的逻辑拓扑', kind: 'script', group: 'map', browser: true, amap: true },
  amapgraph: { file: AMAP_GRAPH_FILE, title: '高德底图的逻辑拓扑', kind: 'script', group: 'map', browser: true, amap: true },
  keepview: { file: KEEP_VIEW_FILE, title: '切底图保持视图', kind: 'script', group: 'map', browser: true, amap: true },
  lanlock: { file: LAN_LOCK_FILE, title: '局域网锁定世界地图', kind: 'script', group: 'map', browser: true },
  admin1: { file: ADMIN1_FILE, title: '世界地图地区划分', kind: 'script', group: 'map', browser: true },
  cache: { file: CACHE_FILE, title: '地图数据缓存行为', kind: 'script', group: 'core' },
};

const GROUPS = {
  core: ['unit', 'smoke', 'cache'],
  map: ['lan', 'color', 'admin1', 'amap', 'switch', 'style', 'lantrace', 'viewswitch', 'topoperf', 'graphtrace', 'amapgraph', 'keepview', 'lanlock'],
  all: ['unit', 'smoke', 'cache', 'lan', 'color', 'admin1', 'amap', 'switch', 'style', 'lantrace', 'viewswitch', 'topoperf', 'graphtrace', 'amapgraph', 'keepview', 'lanlock'],
};

/** 解析 --only= / --list / --all */
function parseSelection(argv) {
  if (argv.includes('--list')) return { list: true, names: [] };
  const onlyArg = argv.find((a) => a.startsWith('--only='));
  if (onlyArg) {
    const raw = onlyArg.slice('--only='.length).trim();
    const names = [];
    for (const token of raw.split(/[,+\s]+/).filter(Boolean)) {
      if (GROUPS[token]) names.push(...GROUPS[token]);
      else if (REGISTRY[token]) names.push(token);
      else {
        console.error(`未知测试名：「${token}」`);
        console.error('可用名称：' + Object.keys(REGISTRY).join(', '));
        console.error('可用分组：' + Object.keys(GROUPS).join(', '));
        process.exit(2);
      }
    }
    return { list: false, names: [...new Set(names)] };
  }
  if (argv.includes('--all')) return { list: false, names: GROUPS.all };
  if (/^(1|true|yes|on)$/i.test(process.env.NS_WITH_BROWSER || '')) return { list: false, names: GROUPS.all };
  // 默认：核心两项（快）
  return { list: false, names: GROUPS.core };
}

const SELECTION = parseSelection(process.argv.slice(2));

const BASE = process.env.NS_BASE || 'http://127.0.0.1:8787';
const SKIP_SMOKE = /^(1|true|yes|on)$/i.test(process.env.NS_SKIP_SMOKE || '');

// 单文件最长执行时间（毫秒）：防止极端情况下挂死
const UNIT_TIMEOUT_MS = 5 * 60 * 1000;
const SMOKE_TIMEOUT_MS = 15 * 60 * 1000;
const BROWSER_TIMEOUT_MS = 10 * 60 * 1000;

const results = [];

function say(line = '') {
  process.stdout.write(`${line}\n`);
}

/** 用 node --test 运行单个测试文件，输出直接透传 */
function runTestFile(absFile, timeoutMs) {
  const rel = path.relative(ROOT, absFile) || absFile;
  const startedAt = Date.now();
  const res = spawnSync(process.execPath, ['--test', rel], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    status: res.status,
    signal: res.signal,
    error: res.error,
    durationMs: Date.now() - startedAt,
  };
}

/** 用 node 直接运行脚本（退出码即结论） */
function runScript(absFile, args, timeoutMs) {
  const rel = path.relative(ROOT, absFile) || absFile;
  const startedAt = Date.now();
  const res = spawnSync(process.execPath, [rel, ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    status: res.status,
    signal: res.signal,
    error: res.error,
    durationMs: Date.now() - startedAt,
  };
}

/** 探测 NetScope 服务是否可用：GET /api/health 并校验 ok === true */
function checkServer(base, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL('/api/health', base);
    } catch (error) {
      resolve({ ok: false, reason: `NS_BASE 不是合法 URL：${base}` });
      return;
    }

    const req = http.request(
      {
        host: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'GET',
        timeout: timeoutMs,
        headers: { Accept: 'application/json' },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (text.length < 8192) text += chunk;
        });
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_) {
            json = null;
          }
          if (res.statusCode === 200 && json && json.ok === true) {
            resolve({ ok: true, detail: `${json.name || 'service'} ${json.version || ''}`.trim() });
            return;
          }
          resolve({ ok: false, reason: `${url.origin}/api/health 返回异常（HTTP ${res.statusCode}）` });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, reason: `${url.host} 连接超时` });
    });
    req.on('error', (error) => {
      resolve({ ok: false, reason: `${url.host} 无法连接（${error.code || error.message}）` });
    });
    req.end();
  });
}

function describeOutcome(item) {
  if (item.skipped) return '跳过';
  if (item.status === 0) return '通过';
  if (item.signal) return `失败（被信号 ${item.signal} 终止）`;
  if (item.error) return `失败（${item.error.message}）`;
  return `失败（exit=${item.status}）`;
}

(async () => {
  if (SELECTION.list) {
    say('==================== 可用测试 ====================');
    for (const [name, meta] of Object.entries(REGISTRY)) {
      const exists = fs.existsSync(meta.file) ? '' : '  （文件不存在）';
      say(`  ${name.padEnd(11)} ${meta.title}${meta.browser ? '  [需浏览器]' : ''}${exists}`);
    }
    say('');
    say('分组：');
    for (const [name, members] of Object.entries(GROUPS)) {
      if (name === 'all') continue;
      say(`  ${name.padEnd(6)} = ${members.join(', ')}`);
    }
    say('');
    say('示例：node test/run-tests.js --only=unit,color');
    process.exitCode = 0;
    return;
  }

  const names = SELECTION.names;
  const total = names.length;
  const isFull = names.length === GROUPS.all.length;
  say('==================== NetScope 测试 ====================');
  say(`Node: ${process.version}    项目: ${ROOT}`);
  say(`范围: ${isFull ? '全量（发布前使用）' : '增量（' + names.join(', ') + '）'}`);
  say('');

  // 是否需要探测服务（冒烟或浏览器用例）
  const needServer = names.some((n) => n === 'smoke' || (REGISTRY[n] && REGISTRY[n].browser));
  let serverReady = false;
  if (needServer) {
    const probe = await checkServer(BASE);
    serverReady = probe.ok;
    if (!probe.ok) {
      if (names.includes('smoke')) {
        say(`⊘ 服务未运行（${probe.reason}），冒烟测试将跳过。`);
        say('  启动服务：node src/server.js        # 默认 127.0.0.1:8787');
      } else {
        say(`⊘ 服务未运行（${probe.reason}），浏览器验收无法执行 —— 请先启动服务。`);
      }
      say('');
    } else {
      say(`✔ 服务可用：${BASE}（${probe.detail}）`);
      say('');
    }
  }

  let step = 0;
  for (const name of names) {
    step += 1;
    const meta = REGISTRY[name];
    const label = `${meta.title} (${path.relative(ROOT, meta.file)})`;
    say(`---------------- [${step}/${total}] ${label} ----------------`);

    if (!fs.existsSync(meta.file)) {
      results.push({ name: label, skipped: true, reason: '测试文件不存在' });
      say('！ 测试文件不存在，跳过。');
      say('');
      continue;
    }
    if (name === 'smoke' && SKIP_SMOKE) {
      results.push({ name: label, skipped: true, reason: 'NS_SKIP_SMOKE 已开启' });
      say('⊘ 已通过 NS_SKIP_SMOKE 强制跳过。');
      say('');
      continue;
    }
    if (meta.browser && !serverReady) {
      results.push({ name: label, skipped: true, reason: '服务未运行' });
      say('⊘ 服务未运行，跳过。');
      say('');
      continue;
    }
    if (name === 'smoke' && !serverReady) {
      results.push({ name: label, skipped: true, reason: '服务未运行' });
      say('⊘ 服务未运行，跳过。');
      say('');
      continue;
    }

    let args = [];
    if (name === 'amap') args = [process.env.NS_AMAP_KEY || '', process.env.NS_AMAP_SECURITY || '', BASE];
    else if (meta.browser) args = [BASE];

    const r = meta.kind === 'node'
      ? runTestFile(meta.file, name === 'smoke' ? SMOKE_TIMEOUT_MS : UNIT_TIMEOUT_MS)
      : runScript(meta.file, args, BROWSER_TIMEOUT_MS);
    results.push({ name: label, ...r });
    say('');
  }

  /* ---------- 汇总 ---------- */
  say('==================== 总体结论 ====================');
  for (const item of results) {
    const ms = item.skipped ? '' : `  ${(item.durationMs / 1000).toFixed(1)}s`;
    const extra = item.skipped ? `  （${item.reason}）` : '';
    say(`  ${describeOutcome(item)}  ${item.name}${ms}${extra}`);
  }

  const failed = results.filter((r) => !r.skipped && r.status !== 0);
  const skipped = results.filter((r) => r.skipped);
  const passed = results.filter((r) => !r.skipped && r.status === 0);

  say('');
  if (failed.length) {
    say(`结论：${passed.length} 项通过，${failed.length} 项失败，${skipped.length} 项跳过 —— 测试未通过。`);
    for (const f of failed) say(`  ✗ ${f.name} → ${describeOutcome(f)}`);
    process.exitCode = 1;
    return;
  }

  say(`结论：${passed.length} 项通过，0 项失败，${skipped.length} 项跳过 —— 全部通过。`);
  if (skipped.length) {
    for (const s of skipped) say(`  ⊘ ${s.name} 已跳过：${s.reason}`);
  }
  process.exitCode = 0;
})().catch((error) => {
  say(`测试入口自身异常：${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
