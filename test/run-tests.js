'use strict';

/**
 * NetScope 测试汇总入口（零第三方依赖）
 *
 * 用法：
 *   cd D:\DSH\NetScope
 *   node test/run-tests.js            # 单元测试 + 接口冒烟 +（可选）局域网/高德验收
 *   npm test                          # 等价（package.json scripts.test）
 *
 * 行为：
 *   1. 依次运行 test/unit.test.js（node:test）与 test/smoke-api.js（真实 HTTP 冒烟）；
 *   2. 冒烟测试需要 NetScope 服务在 127.0.0.1:8787（可用 NS_BASE 覆盖）运行；
 *      探测不到服务时打印提示并「跳过」，而不是判定失败；
 *   3. 需要浏览器的验收（局域网拓扑、高德底图）默认不跑，用 NS_WITH_BROWSER=1 打开；
 *   4. 输出总体结论，并以合适的 exit code 退出（0=全部通过/按需跳过，1=有失败）。
 *
 * 环境变量：
 *   NS_BASE=http://127.0.0.1:8787   服务地址（冒烟与浏览器验收共用）
 *   NS_SKIP_SMOKE=1                 强制跳过冒烟测试
 *   NS_WITH_BROWSER=1               额外运行局域网拓扑与高德底图验收（需 Chrome/Edge）
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

const BASE = process.env.NS_BASE || 'http://127.0.0.1:8787';
const SKIP_SMOKE = /^(1|true|yes|on)$/i.test(process.env.NS_SKIP_SMOKE || '');
const WITH_BROWSER = /^(1|true|yes|on)$/i.test(process.env.NS_WITH_BROWSER || '');

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
  const total = WITH_BROWSER ? 4 : 2;
  say('==================== NetScope 测试汇总 ====================');
  say(`Node: ${process.version}    项目: ${ROOT}`);
  say(`模式: ${WITH_BROWSER ? '含浏览器验收（局域网拓扑 + 高德底图）' : '仅单元测试 + 接口冒烟（NS_WITH_BROWSER=1 可开启浏览器验收）'}`);
  say('');

  /* ---------- 1. 单元测试 ---------- */
  say(`---------------- [1/${total}] 单元测试 (test/unit.test.js) ----------------`);
  if (!fs.existsSync(UNIT_FILE)) {
    results.push({ name: '单元测试', skipped: true, reason: 'test/unit.test.js 不存在' });
    say('！ 未找到 test/unit.test.js，跳过。');
  } else {
    const r = runTestFile(UNIT_FILE, UNIT_TIMEOUT_MS);
    results.push({ name: '单元测试 (test/unit.test.js)', ...r });
  }
  say('');

  /* ---------- 2. 接口冒烟 ---------- */
  say(`---------------- [2/${total}] 接口冒烟 (test/smoke-api.js) ----------------`);
  let serverReady = false;
  if (!fs.existsSync(SMOKE_FILE)) {
    results.push({ name: '接口冒烟', skipped: true, reason: 'test/smoke-api.js 不存在' });
    say('！ 未找到 test/smoke-api.js，跳过。');
  } else if (SKIP_SMOKE) {
    results.push({ name: '接口冒烟', skipped: true, reason: 'NS_SKIP_SMOKE 已开启' });
    say('⊘ 已通过 NS_SKIP_SMOKE 强制跳过冒烟测试。');
  } else {
    const probe = await checkServer(BASE);
    serverReady = probe.ok;
    if (!probe.ok) {
      results.push({ name: '接口冒烟', skipped: true, reason: probe.reason });
      say(`⊘ 跳过冒烟测试：${probe.reason}`);
      say('  冒烟测试需要 NetScope 服务处于运行状态，请先启动：');
      say('      node src/server.js            # 默认监听 127.0.0.1:8787');
      say('  或在其它端口启动后用 NS_BASE 指定，例如：');
      say("      $env:NS_BASE='http://127.0.0.1:9000'; node test/run-tests.js");
      say('  注意：冒烟测试会真实访问网络（DNS / ICMP / TCP），耗时可能较长。');
    } else {
      say(`✔ 检测到服务：${BASE}（${probe.detail}），开始冒烟测试…`);
      say('');
      const r = runTestFile(SMOKE_FILE, SMOKE_TIMEOUT_MS);
      results.push({ name: '接口冒烟 (test/smoke-api.js)', ...r });
    }
  }
  say('');

  /* ---------- 3/4. 浏览器验收（可选） ---------- */
  if (WITH_BROWSER) {
    const browserCases = [
      { index: 3, file: LAN_FILE, name: '局域网拓扑验收 (test/lan-topology-e2e.js)', args: [BASE] },
      {
        index: 4,
        file: AMAP_FILE,
        name: '高德底图验收 (test/amap-e2e.js)',
        args: [process.env.NS_AMAP_KEY || '', process.env.NS_AMAP_SECURITY || '', BASE],
      },
    ];
    for (const item of browserCases) {
      say(`---------------- [${item.index}/${total}] ${item.name} ----------------`);
      if (!fs.existsSync(item.file)) {
        results.push({ name: item.name, skipped: true, reason: '测试文件不存在' });
        say('！ 测试文件不存在，跳过。');
      } else if (!serverReady) {
        results.push({ name: item.name, skipped: true, reason: '服务未运行' });
        say('⊘ 服务未运行，跳过。');
      } else {
        const r = runScript(item.file, item.args, BROWSER_TIMEOUT_MS);
        if (r.status === 0) {
          results.push({ name: item.name, ...r });
        } else {
          // 高德未配置时脚本会自行打印 SKIP 并以 0 退出，所以非 0 即真实失败
          results.push({ name: item.name, ...r });
        }
      }
      say('');
    }
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
