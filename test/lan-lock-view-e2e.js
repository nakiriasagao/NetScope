'use strict';
/**
 * 验收：扫描局域网后自动进入逻辑拓扑并锁定世界地图
 *
 * 期望行为：
 *   1. 扫描局域网后：state.view=graph、渲染器为星型拓扑、世界地图按钮被禁用；
 *   2. 强行切世界地图（模拟旧行为）无效 —— 仍显示星型拓扑；
 *   3. 切换底图（高德 / 内置）也不会切到世界地图，仍是星型拓扑；
 *   4. 下一次探测外网后：世界地图按钮恢复可用，且能正常切到世界地图。
 *
 * 用法：node test/lan-lock-view-e2e.js [baseUrl]
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const PORT = 9460 + Math.floor(Math.random() * 30);
const BROWSER = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const KEY = process.env.NS_AMAP_KEY || '';
const SECURITY = process.env.NS_AMAP_SECURITY || '';

function getJSON(url, t = 8000) {
  return new Promise((res, rej) => {
    const q = http.get(url, { timeout: t }, (r) => {
      let s = '';
      r.on('data', (c) => (s += c));
      r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(new Error(s.slice(0, 90))); } });
    });
    q.on('timeout', () => { q.destroy(); rej(new Error('timeout')); });
    q.on('error', rej);
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-lanlock-'));
  const child = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`,
    '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--window-size=1680,950', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    try { await getJSON(`http://127.0.0.1:${PORT}/json/version`, 2000); ready = true; } catch (e) { await new Promise((r) => setTimeout(r, 300)); }
  }
  const list = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
  const pageTarget = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl).pop();
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push('[异常] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('[console.error] ' + m.params.args.map((a) => a.value || a.description).join(' '));
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: myId, method, params }));
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error('CDP 超时 ' + method)); } }, 120000);
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 950, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: BASE + '/?lanlock=' + Date.now() });
  for (let i = 0; i < 60; i += 1) {
    if ((await evaluate("Boolean(window.NetScopeApp && window.NetScopeApp.renderer().world)")) === true) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  await evaluate("document.getElementById('legend-panel').hidden = true; 'ok'");

  const failures = [];
  const snap = `JSON.stringify((function () {
    var app = window.NetScopeApp;
    var r = app.renderer();
    var mapBtn = document.querySelector('[data-view="map"]');
    var graphBtn = document.querySelector('[data-view="graph"]');
    var active = document.querySelector('[data-view].is-active');
    return {
      view: app.state.view,
      viewLocked: app.state.viewLocked === true,
      activeBtn: active ? active.getAttribute('data-view') : null,
      mapDisabled: mapBtn ? (mapBtn.disabled === true) : null,
      graphDisabled: graphBtn ? graphBtn.disabled === true : null,
      lanMode: r.lanMode === true,
      mode: r.mode,
      baseMap: app.state.baseMap,
      nodes: r.nodes.length,
      arcs: r.arcs.length,
      labels: document.querySelectorAll('#node-overlay g').length,
      animRunning: r.animation && r.animation.running === true,
      // 世界地图是否真的画出来了：只有在 map 模式下才可能画出陆地，
      // 逻辑拓扑/星型拓扑模式下必然为 0
      landSamples: r.mode !== 'map' ? 0 : (function () {
        try {
          var img = r.ctx.getImageData(0, 0, Math.min(r.width, 900), Math.min(r.height, 700)).data;
          var n = 0;
          for (var i = 0; i < img.length; i += 4 * 29) {
            // 国土填色是 #16273f（22,39,63），严格匹配以避免误判
            if (Math.abs(img[i] - 22) <= 6 && Math.abs(img[i+1] - 39) <= 6 && Math.abs(img[i+2] - 63) <= 6) n += 1;
          }
          return n;
        } catch (e) { return -1; }
      })(),
    };
  })())`;

  const check = (label, s, o) => {
    const opts = o || {};
    console.log(`\n【${label}】`);
    console.log('  ' + JSON.stringify(s));
    if (opts.view && s.view !== opts.view) failures.push(`${label}：state.view 应为 ${opts.view}，实际 ${s.view}`);
    if (opts.locked === true && !s.viewLocked) failures.push(`${label}：世界地图应处于锁定状态`);
    if (opts.locked === false && s.viewLocked) failures.push(`${label}：世界地图应已解锁`);
    if (opts.mapDisabled === true && s.mapDisabled !== true) failures.push(`${label}：世界地图按钮应被禁用`);
    if (opts.mapDisabled === false && s.mapDisabled !== false) failures.push(`${label}：世界地图按钮应恢复可用`);
    if (opts.lanMode === true && !s.lanMode) failures.push(`${label}：应处于局域网星型拓扑模式`);
    if (opts.lanMode === false && s.lanMode) failures.push(`${label}：不应处于局域网星型拓扑模式`);
    if (opts.minNodes && s.nodes < opts.minNodes) failures.push(`${label}：节点过少（${s.nodes}）`);
    if (opts.maxLand !== undefined && s.landSamples > opts.maxLand) {
      failures.push(`${label}：不应显示世界地图（陆地抽样 ${s.landSamples}）`);
    }
    if (opts.minLand !== undefined && s.landSamples < opts.minLand) {
      failures.push(`${label}：世界地图应可见（陆地抽样 ${s.landSamples}）`);
    }
  };

  const outDir = path.join(__dirname, '..', 'data', 'screenshots');
  fs.mkdirSync(outDir, { recursive: true });
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, name), Buffer.from(s.data, 'base64'));
  };

  /* ---------- 1. 先探测外网，建立"上一次探测"的状态 ---------- */
  console.log('================ 步骤 1：先探测外网（建立旧数据）================');
  await evaluate("window.NetScopeApp.trace('8.8.8.8')");
  for (let i = 0; i < 80; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    if ((await evaluate('String(window.NetScopeApp.state.busy)')) === 'false') break;
  }
  await new Promise((r) => setTimeout(r, 1200));
  const sTrace = JSON.parse(await evaluate(snap));
  check('外网探测完成（世界地图可用）', sTrace, { mapDisabled: false, lanMode: false });
  if (sTrace.view !== 'map') failures.push('步骤1：探测后应显示世界地图');

  /* ---------- 2. 扫描局域网 → 应自动锁定 ---------- */
  console.log('\n================ 步骤 2：扫描局域网 ================');
  await evaluate("document.getElementById('opt-deepscan').checked = false; document.getElementById('btn-lanscan').click(); 'ok'");
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    const p = JSON.parse(await evaluate("JSON.stringify({ busy: window.NetScopeApp.state.busy, lan: Boolean(window.NetScopeApp.state.lan) })"));
    if (p.lan && !p.busy) break;
  }
  await new Promise((r) => setTimeout(r, 1500));
  const sLan = JSON.parse(await evaluate(snap));
  check('扫描局域网后（自动进入逻辑拓扑并锁定世界地图）', sLan, {
    view: 'graph', locked: true, mapDisabled: true, lanMode: true, minNodes: 2, maxLand: 60,
  });
  if (sLan.activeBtn !== 'graph') failures.push(`步骤2：高亮按钮应为 graph，实际 ${sLan.activeBtn}`);
  await shot('lanlock-star.png');

  /* ---------- 3. 强行点世界地图（应无效） ---------- */
  console.log('\n================ 步骤 3：强行点「世界地图」 ================');
  await evaluate("document.querySelector('[data-view=\\\"map\\\"]').click(); 'ok'");
  await new Promise((r) => setTimeout(r, 2000));
  const sForce = JSON.parse(await evaluate(snap));
  check('点了世界地图（应仍为星型拓扑）', sForce, {
    view: 'graph', locked: true, lanMode: true, maxLand: 60,
  });

  /* ---------- 4. 切换底图（应仍为星型拓扑） ---------- */
  if (KEY && SECURITY) {
    console.log('\n================ 步骤 4：切换底图 ================');
    await evaluate(`window.NetScopeAmap.saveLocalCredentials({ key: ${JSON.stringify(KEY)}, security: ${JSON.stringify(SECURITY)}, enabled: true }); 'ok'`);
    await evaluate("document.getElementById('opt-basemap').value = 'amap'; document.getElementById('opt-basemap').dispatchEvent(new Event('change')); 'ok'");
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      if ((await evaluate('window.NetScopeApp.state.baseMap')) === 'amap') break;
    }
    await new Promise((r) => setTimeout(r, 2500));
    const sAmap = JSON.parse(await evaluate(snap));
    check('切到高德（应仍为星型拓扑、仍锁定）', sAmap, {
      view: 'graph', locked: true, lanMode: true, minNodes: 2, maxLand: 60,
    });

    await evaluate("document.getElementById('opt-basemap').value = 'builtin'; document.getElementById('opt-basemap').dispatchEvent(new Event('change')); 'ok'");
    await new Promise((r) => setTimeout(r, 2500));
    const sBack = JSON.parse(await evaluate(snap));
    check('切回内置（应仍为星型拓扑、仍锁定）', sBack, {
      view: 'graph', locked: true, lanMode: true, minNodes: 2, maxLand: 60,
    });
  } else {
    console.log('\n⊘ 未提供高德凭据，跳过步骤 4');
  }

  /* ---------- 5. 再探测外网 → 解锁 ---------- */
  console.log('\n================ 步骤 5：再探测外网（应解锁）================');
  await evaluate("window.NetScopeApp.trace('223.5.5.5')");
  for (let i = 0; i < 80; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    if ((await evaluate('String(window.NetScopeApp.state.busy)')) === 'false') break;
  }
  await new Promise((r) => setTimeout(r, 1500));
  const sUnlock = JSON.parse(await evaluate(snap));
  check('探测后（世界地图应恢复可用）', sUnlock, { locked: false, mapDisabled: false, lanMode: false });
  // 视图保持由用户决定（可能仍是逻辑拓扑），关键是世界地图已解锁且能正常显示
  if (sUnlock.mode !== 'map' && sUnlock.mode !== 'graph') failures.push(`步骤5：渲染模式异常 ${sUnlock.mode}`);

  // 显式切到世界地图，确认可用
  await evaluate("document.querySelector('[data-view=\\\"map\\\"]').click(); 'ok'");
  await new Promise((r) => setTimeout(r, 2000));
  const sMap = JSON.parse(await evaluate(snap));
  check('切到世界地图（应可用）', sMap, { view: 'map', locked: false, minLand: 200 });
  if (sMap.mode !== 'map') failures.push(`步骤5：切到世界地图后渲染模式应为 map，实际 ${sMap.mode}`);
  await shot('lanlock-unlocked-map.png');

  if (errors.length) {
    console.log('\n页面错误：');
    errors.slice(0, 8).forEach((e) => console.log('  ' + e));
    failures.push(`${errors.length} 个页面脚本错误`);
  }

  console.log('\n已保存: lanlock-star.png / lanlock-unlocked-map.png');
  console.log('\n================ 结论 ================');
  if (failures.length) {
    failures.forEach((f) => console.log('  ✘ ' + f));
    ws.close();
    child.kill();
    process.exit(1);
  }
  console.log('  ✔ 全部通过');
  ws.close();
  child.kill();
  process.exit(0);
})().catch((e) => { console.error('验收失败：', e.message); process.exit(1); });
