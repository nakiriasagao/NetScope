'use strict';
/**
 * 高德 Key 持久化验收（exe / 新应用窗口场景）
 *
 * 复现的缺陷：exe 版每次都开一个新的应用窗口，浏览器 localStorage 为空，
 * 而前端只从 localStorage 读 Key ⇒ 表现成"Key 没被缓存，每次都要重填"。
 *
 * 本测试**故意不写入 localStorage**，只依赖服务端已保存的 data/amap-config.json，
 * 验证：
 *   1. 凭据解析能回落到服务端配置；
 *   2. 设置面板会回填服务端保存的 Key；
 *   3. 切到高德底图能成功加载 JS API（脚本 URL 用的是服务端那把 Key）；
 *   4. 回填后本地缓存被补齐（下次启动即使服务端不可达也能用）。
 *
 * 前置：服务已在 127.0.0.1:8787 运行，且已保存高德 Key。
 * 用法：node test/amap-persistence-e2e.js
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BASE = process.env.NS_BASE || 'http://127.0.0.1:8787';
const PORT = Number(process.env.NS_CDP_PORT || 9333);
const BROWSER = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const failures = [];
function ok(label, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`);
  if (!cond) failures.push(label + (detail ? '（' + detail + '）' : ''));
}

function getJSON(url, t = 8000) {
  return new Promise((res, rej) => {
    const q = http.get(url, { timeout: t }, (r) => {
      let s = '';
      r.on('data', (c) => (s += c));
      r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(new Error(s.slice(0, 120))); } });
    });
    q.on('timeout', () => { q.destroy(); rej(new Error('timeout')); });
    q.on('error', rej);
  });
}

(async () => {
  console.log('==================== 高德 Key 持久化验收 ====================');

  // 0) 服务端必须已保存 Key
  let serverCfg = null;
  try {
    const res = await getJSON(`${BASE}/api/amap/config?includePlain=1`);
    serverCfg = res && res.config ? res.config : null;
  } catch (error) {
    console.log('SKIP 无法访问服务端配置（' + error.message + '）');
    process.exit(0);
  }
  if (!serverCfg || !serverCfg.configured || !serverCfg.keyPlain) {
    console.log('SKIP 服务端未保存高德 Key，跳过本验收。');
    console.log('     先在界面「⚙ 地图设置」里保存一次 Key，或用环境变量 AMAP_KEY 启动服务。');
    process.exit(0);
  }
  console.log(`服务端已保存 Key：${serverCfg.keyMasked}（含安全密钥：${serverCfg.hasSecurity}）\n`);

  // 1) 全新浏览器 profile ⇒ localStorage 天然为空
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-amap-persist-'));
  const child = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`,
    '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--window-size=1680,950', 'about:blank'],
  { stdio: 'ignore', windowsHide: true });

  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    try { await getJSON(`http://127.0.0.1:${PORT}/json/version`, 2000); ready = true; } catch (e) { await new Promise((r) => setTimeout(r, 300)); }
  }
  if (!ready) { console.log('SKIP 浏览器未能启动调试端口'); child.kill(); process.exit(0); }

  const list = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
  const target = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl).pop();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const amapScripts = [];
  const consoleErrors = [];

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Network.requestWillBeSent') {
      const u = m.params.request.url;
      if (u.indexOf('webapi.amap.com/maps') >= 0) amapScripts.push(u);
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push(m.params.args.map((a) => a.value || a.description).join(' ').slice(0, 160));
    }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: myId, method, params }));
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error('CDP 超时 ' + method)); } }, 90000);
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Network.setCacheDisabled', { cacheDisabled: true });
    await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 950, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: BASE + '/?persist=' + Date.now() });
    for (let i = 0; i < 60; i += 1) {
      const loaded = await evaluate("Boolean(window.NetScopeApp && window.NetScopeApp.renderer && window.NetScopeApp.renderer())");
      if (loaded === true) break;
      await new Promise((r) => setTimeout(r, 400));
    }

    console.log('--- 1) 初始状态：本地必须没有凭据 ---');
    const initial = await evaluate(`JSON.stringify({
      local: window.NetScopeAmap.loadLocalCredentials(),
      hasApi: Boolean(window.NetScopeAPI && window.NetScopeAPI.amapConfig)
    })`);
    const init = JSON.parse(initial);
    ok('模拟新窗口：localStorage 中无 Key', !init.local.key,
      init.local.key ? '意外存在：' + init.local.key.slice(0, 6) + '…' : '（空，符合 exe 新窗口场景）');
    ok('前端可调用服务端配置接口', init.hasApi === true);

    console.log('\n--- 2) 凭据应能回落到服务端配置 ---');
    const resolved = await evaluate(`window.NetScopeAmap.resolveCredentials(false).then(function (c) {
      return JSON.stringify({ key: c.key, securityLen: (c.security || '').length, source: c.source });
    })`);
    let rv = null;
    try { rv = JSON.parse(resolved); } catch (_) { rv = { error: String(resolved) }; }
    ok('解析到可用 Key', Boolean(rv && rv.key && rv.key.length === 32),
      rv && rv.key ? `${rv.key.slice(0, 6)}…${rv.key.slice(-4)}（来源 ${rv.source}）` : String(resolved).slice(0, 120));
    ok('解析到安全密钥', Boolean(rv && rv.securityLen === 32), rv ? '长度 ' + rv.securityLen : '');
    ok('来源标记为 server', rv && rv.source === 'server', rv ? String(rv.source) : '');

    console.log('\n--- 3) 回填后写入本地缓存（下次启动可用）---');
    const localAfter = await evaluate(`JSON.stringify(window.NetScopeAmap.loadLocalCredentials())`);
    const la = JSON.parse(localAfter);
    ok('本地缓存已补齐', Boolean(la.key && la.security), la.key ? la.key.slice(0, 6) + '…' : '（空）');

    console.log('\n--- 4) 设置面板应回填服务端保存的 Key ---');
    await evaluate("window.localStorage.removeItem('netscope.amap.credentials'); 'cleared'");
    await evaluate("document.getElementById('btn-settings').click(); 'opened'");
    await new Promise((r) => setTimeout(r, 1200));
    const form = await evaluate(`JSON.stringify({
      key: (document.getElementById('amap-key') || {}).value || '',
      security: (document.getElementById('amap-security') || {}).value || ''
    })`);
    const fv = JSON.parse(form);
    ok('设置面板回填了 Key', fv.key && fv.key.length === 32, fv.key ? fv.key.slice(0, 6) + '…' + fv.key.slice(-4) : '（空）');
    ok('设置面板回填了安全密钥', fv.security && fv.security.length === 32,
      fv.security ? fv.security.slice(0, 6) + '…' : '（空）');
    await evaluate("document.getElementById('btn-settings-close') && document.getElementById('btn-settings-close').click(); 'closed'");

    console.log('\n--- 5) 切到高德底图：应能成功加载（不提示未配置 Key）---');
    await evaluate("window.localStorage.removeItem('netscope.amap.credentials'); 'cleared-again'");
    await evaluate("document.getElementById('opt-basemap').value = 'amap'; document.getElementById('opt-basemap').dispatchEvent(new Event('change')); 'switched'");

    let loaded = false;
    let sawKey = '';
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      const st = await evaluate(`JSON.stringify({
        hasAMap: typeof window.AMap !== 'undefined',
        mode: window.NetScopeApp.state.baseMap,
        status: (document.getElementById('basemap-status') || {}).textContent || ''
      })`);
      const parsed = JSON.parse(st);
      if (parsed.hasAMap && parsed.mode === 'amap') { loaded = true; break; }
    }
    ok('高德底图加载成功（无需手动重填 Key）', loaded);
    if (amapScripts.length) {
      const m = /[?&]key=([0-9a-fA-F]{32})/.exec(amapScripts[amapScripts.length - 1]);
      sawKey = m ? m[1] : '';
    }
    ok('加载脚本使用的是服务端保存的 Key',
      sawKey === serverCfg.keyPlain,
      sawKey ? sawKey.slice(0, 6) + '…' + sawKey.slice(-4) : '（未捕获到脚本 URL）');

    const notConfigured = await evaluate(
      "String((document.getElementById('basemap-status')||{}).textContent||'').indexOf('未配置') >= 0");
    ok('未出现"未配置 Key"提示', notConfigured !== true, String(notConfigured));

    const relevantErrors = consoleErrors.filter((e) => /未配置|尚未配置|Key/.test(e));
    ok('无与 Key 相关的控制台报错', relevantErrors.length === 0, relevantErrors.slice(0, 2).join(' | '));
  } finally {
    try { child.kill(); } catch (_) { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 }); } catch (_) { /* ignore */ }
  }

  console.log('\n==================== 结论 ====================');
  if (failures.length) {
    failures.forEach((f) => console.log('  ✘ ' + f));
    process.exit(1);
  }
  console.log('  ✔ 全部通过：本地无缓存时也能用服务端保存的 Key，不再需要重填');
  process.exit(0);
})().catch((error) => {
  console.error('验收失败：' + (error && error.message ? error.message : error));
  process.exit(1);
});
