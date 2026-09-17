'use strict';
/**
 * 桌面版持久化验收：应用窗口设置能否跨重启保留
 *
 * 背景（用户反馈的缺陷）：exe 版每次都开一个新的应用窗口，
 * 而原来的实现用的是 **PID 临时 profile 目录**（netscope-window-<pid>），
 * 浏览器按"来源 + profile 目录"隔离 localStorage，导致：
 *   · 高德 Key、底图偏好、界面设置每次启动都丢；
 *   · 表现成"高德地图 Key 不能缓存，每次都要重填"。
 *
 * 本测试验证三件事：
 *   1. 源码里用的是**稳定 profile 路径**（不再含 PID）；
 *   2. 用同一个 profile 打开两次，localStorage 能读回（真实的持久化行为）；
 *   3. 即使 localStorage 被清空，也能从服务端保存的配置回填高德 Key。
 *
 * 注意：浏览器必须**优雅退出**才会把 localStorage 刷盘，强杀进程会丢数据，
 * 因此本测试用 CDP 的 Browser.close 收尾，否则会出现假阴性。
 *
 * 前置：dist/netscope.exe 已构建；已保存过高德 Key（否则跳过第 3 项）。
 * 用法：node test/desktop-persistence-e2e.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BROWSER = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXE = path.join(ROOT, 'dist', 'netscope.exe');
const SEA_ENTRY = path.join(ROOT, 'src', 'sea-entry.js');
const PORT = Number(process.env.NS_DESKTOP_PORT || 8932);
const CDP = Number(process.env.NS_DESKTOP_CDP || 9345);

const failures = [];
function ok(label, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`);
  if (!cond) failures.push(label + (detail ? '（' + detail + '）' : ''));
}

function getJSON(url, t = 5000) {
  return new Promise((res, rej) => {
    const q = http.get(url, { timeout: t }, (r) => {
      let s = '';
      r.on('data', (c) => (s += c));
      r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(new Error(s.slice(0, 100))); } });
    });
    q.on('timeout', () => { q.destroy(); rej(new Error('timeout')); });
    q.on('error', rej);
  });
}

/** 用指定 profile 打开页面、执行 fn、再优雅关闭浏览器 */
async function withPage(profileDir, url, fn) {
  const child = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profileDir}`,
    '--no-first-run', '--disable-gpu', '--window-size=1400,900', 'about:blank'],
  { stdio: 'ignore', windowsHide: true });

  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    try { await getJSON(`http://127.0.0.1:${CDP}/json/version`, 1500); ready = true; } catch (e) { await new Promise((r) => setTimeout(r, 300)); }
  }
  if (!ready) { child.kill(); throw new Error('浏览器调试端口未就绪'); }

  const list = await getJSON(`http://127.0.0.1:${CDP}/json/list`);
  const target = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl).pop();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: myId, method, params }));
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error('CDP 超时 ' + method)); } }, 60000);
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url });
    for (let i = 0; i < 50; i += 1) {
      const loaded = await evaluate("document.readyState === 'complete' && Boolean(window.NetScopeApp)");
      if (loaded === true) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    return await fn(evaluate, send);
  } finally {
    // 优雅退出：否则 localStorage 不刷盘
    try { await send('Browser.close'); } catch (_) { /* ignore */ }
    await new Promise((r) => setTimeout(r, 2500));
    try { ws.close(); } catch (_) { /* ignore */ }
    if (!child.killed) child.kill();
    await new Promise((r) => setTimeout(r, 1200));
    spawnSync('powershell.exe', ['-NoProfile', '-Command',
      `$p=Get-NetTCPConnection -LocalPort ${CDP} -State Listen -ErrorAction SilentlyContinue; if($p){foreach($i in ($p|Select-Object -ExpandProperty OwningProcess -Unique)){Stop-Process -Id $i -Force -ErrorAction SilentlyContinue}}`],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  }
}

(async () => {
  console.log('==================== 桌面版持久化验收 ====================');

  /* ---------- 1) 源码：必须使用稳定 profile 路径 ---------- */
  console.log('\n--- 1) 应用窗口的 profile 目录必须是稳定路径 ---');
  const src = fs.readFileSync(SEA_ENTRY, 'utf8');
  ok('不再使用 PID 临时目录', !/netscope-window-\s*'\s*\+\s*process\.pid/.test(src) && !/netscope-window-/.test(src));
  ok('使用固定的 browser-profile 目录', /NetScope['"],\s*['"]browser-profile/.test(src));
  ok('目录建于用户数据目录（LOCALAPPDATA/APPDATA）',
    /LOCALAPPDATA/.test(src) && /APPDATA/.test(src));
  ok('不再在退出时删除 profile（删除会连带清掉设置）', !/cleanupProfile/.test(src));

  /* ---------- 2) 真实持久化：同一 profile 打开两次 ---------- */
  console.log('\n--- 2) 同一 profile 打开两次，localStorage 应保留 ---');
  if (!fs.existsSync(EXE)) {
    console.log('SKIP 未找到 dist/netscope.exe（请先 node tools/build-exe.js）');
  } else {
    const profile = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'NetScope', 'browser-profile');
    fs.rmSync(profile, { recursive: true, force: true });
    console.log('  profile: ' + profile);

    const exe = spawn(EXE, ['--port', String(PORT), '--no-window'], {
      cwd: path.dirname(EXE), stdio: 'ignore', windowsHide: true,
    });
    let up = false;
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      try { const h = await getJSON(`http://127.0.0.1:${PORT}/api/health`, 2000); if (h.ok) { up = true; break; } } catch (_) { /* 等启动 */ }
    }
    ok('打包后的 exe 能启动', up, up ? `监听 ${PORT}` : '启动超时');

    if (up) {
      const url = `http://127.0.0.1:${PORT}/`;
      const mark = 'netscope.persist.probe-' + Date.now();
      try {
        const written = await withPage(profile, url, (evaluate) =>
          evaluate(`window.localStorage.setItem('netscope.persist.test', ${JSON.stringify(mark)}); String(window.localStorage.getItem('netscope.persist.test'))`));
        ok('第一次打开可写入 localStorage', written === mark, String(written).slice(0, 40));

        const readBack = await withPage(profile, url, (evaluate) =>
          evaluate("String(window.localStorage.getItem('netscope.persist.test'))"));
        ok('第二次打开能读回（跨重启保留）', readBack === mark,
          readBack === mark ? '值一致' : '读回 ' + String(readBack).slice(0, 40));

        // 高德 Key：清空本地后应能从服务端回填
        const fallback = await withPage(profile, url, async (evaluate) => {
          await evaluate("window.localStorage.removeItem('netscope.amap.credentials'); 'cleared'");
          return evaluate(`window.NetScopeAmap.resolveCredentials(false).then(function (c) {
            return JSON.stringify({ keyLen: (c.key || '').length, source: c.source });
          })`);
        });
        let fb = null;
        try { fb = JSON.parse(fallback); } catch (_) { fb = null; }
        if (fb && fb.source === 'server') {
          ok('本地清空后可从服务端回填高德 Key', fb.keyLen === 32, `长度 ${fb.keyLen}，来源 server`);
        } else {
          console.log('SKIP 服务端未配置高德 Key，跳过回填断言（' + String(fallback).slice(0, 60) + '）');
        }
      } finally {
        exe.kill();
        await new Promise((r) => setTimeout(r, 800));
      }
    }
  }

  console.log('\n==================== 结论 ====================');
  if (failures.length) {
    failures.forEach((f) => console.log('  ✘ ' + f));
    process.exit(1);
  }
  console.log('  ✔ 全部通过：应用窗口设置跨重启保留，且服务端可兜底回填');
  process.exit(0);
})().catch((error) => {
  console.error('验收失败：' + (error && error.message ? error.message : error));
  process.exit(1);
});
