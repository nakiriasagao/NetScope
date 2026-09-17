'use strict';
/**
 * 复现并回归：逻辑拓扑模式下切换底图
 *
 * 期望行为：
 *   - 切换底图（高德 ⇄ 内置世界地图）**不应改变当前视图**：
 *     逻辑拓扑仍应是逻辑拓扑，上方按钮与画面保持一致；
 *   - 切换后动画继续运行（不能被暂停）；
 *   - 切换回内置地图后节点仍按"跳"展开。
 *
 * 用法：node test/basemap-keep-view-e2e.js [baseUrl]
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const TARGET = process.argv[3] || '8.8.8.8';
const PORT = 9500 + Math.floor(Math.random() * 30);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-keepview-'));
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
  await send('Page.navigate', { url: BASE + '/?keepview=' + Date.now() });
  for (let i = 0; i < 60; i += 1) {
    if ((await evaluate("Boolean(window.NetScopeApp && window.NetScopeApp.renderer().world)")) === true) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  await evaluate("document.getElementById('legend-panel').hidden = true; 'ok'");

  const failures = [];
  // 画面状态 + UI 按钮状态一起取，专门用来抓"画面与按钮不一致"
  const snap = `JSON.stringify((function () {
    var app = window.NetScopeApp;
    var r = app.renderer();
    var activeBtn = document.querySelector('[data-view].is-active');
    return {
      stateView: app.state.view,
      buttonView: activeBtn ? activeBtn.getAttribute('data-view') : null,
      baseMap: app.state.baseMap,
      selectValue: document.getElementById('opt-basemap').value,
      mode: r.mode,
      plain: r.plain === true,
      nodes: r.nodes.length,
      arcs: r.arcs.length,
      labels: document.querySelectorAll('#node-overlay g').length,
      animRunning: r.animation && r.animation.running === true,
      rendererCanvasId: r.canvas ? r.canvas.id : null,
      suspended: window.__amapSuspended === undefined ? null : window.__amapSuspended,
      inkSamples: (function () {
        try {
          var cv = r.canvas;
          var ctx = cv.getContext('2d');
          var img = ctx.getImageData(0, 0, Math.min(r.width, 900), Math.min(r.height, 700)).data;
          var n = 0;
          for (var i = 0; i < img.length; i += 4 * 29) { if (img[i] + img[i+1] + img[i+2] + img[i+3] > 30) n += 1; }
          return n;
        } catch (e) { return -1; }
      })(),
    };
  })())`;

  const check = (label, s, o) => {
    const opts = o || {};
    console.log(`\n【${label}】`);
    console.log('  ' + JSON.stringify(s));
    if (opts.view && s.stateView !== opts.view) failures.push(`${label}：state.view 应为 ${opts.view}，实际 ${s.stateView}`);
    if (opts.view && s.buttonView !== opts.view) failures.push(`${label}：视图按钮显示 ${s.buttonView}，与状态 ${s.stateView} 不一致`);
    if (opts.mode && s.mode !== opts.mode) failures.push(`${label}：渲染模式应为 ${opts.mode}，实际 ${s.mode}`);
    if (opts.baseMap && s.baseMap !== opts.baseMap) failures.push(`${label}：底图应为 ${opts.baseMap}，实际 ${s.baseMap}`);
    if (opts.anim === true && !s.animRunning) failures.push(`${label}：动画被暂停了`);
    if (opts.minNodes && s.nodes < opts.minNodes) failures.push(`${label}：节点过少（${s.nodes} < ${opts.minNodes}）`);
    if (opts.minInk && s.inkSamples < opts.minInk) failures.push(`${label}：画布内容过少（着墨 ${s.inkSamples}）`);
  };

  const outDir = path.join(__dirname, '..', 'data', 'screenshots');
  fs.mkdirSync(outDir, { recursive: true });
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, name), Buffer.from(s.data, 'base64'));
  };

  // 探测
  console.log('================ 探测 ================');
  await evaluate(`window.NetScopeApp.trace(${JSON.stringify(TARGET)})`);
  for (let i = 0; i < 80; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    if ((await evaluate('String(window.NetScopeApp.state.busy)')) === 'false') break;
  }
  await new Promise((r) => setTimeout(r, 1200));

  // 切到逻辑拓扑
  await evaluate("document.querySelector('[data-view=\\\"graph\\\"]').click(); 'ok'");
  await new Promise((r) => setTimeout(r, 1800));
  const g0 = JSON.parse(await evaluate(snap));
  const expectedNodes = g0.nodes;
  check('基线：内置地图 + 逻辑拓扑', g0, {
    view: 'graph', mode: 'graph', baseMap: 'builtin', anim: true, minNodes: 2, minInk: 10,
  });

  if (!KEY || !SECURITY) {
    console.log('\n⊘ 未提供高德凭据，跳过底图切换部分');
  } else {
    await evaluate(`window.NetScopeAmap.saveLocalCredentials({ key: ${JSON.stringify(KEY)}, security: ${JSON.stringify(SECURITY)}, enabled: true }); 'ok'`);

    /* ---------- 在逻辑拓扑下切到高德 ---------- */
    console.log('\n================ 逻辑拓扑下：内置 → 高德 ================');
    await evaluate("document.getElementById('opt-basemap').value = 'amap'; document.getElementById('opt-basemap').dispatchEvent(new Event('change')); 'ok'");
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      if ((await evaluate('window.NetScopeApp.state.baseMap')) === 'amap') break;
    }
    await new Promise((r) => setTimeout(r, 2500));
    const g1 = JSON.parse(await evaluate(snap));
    check('逻辑拓扑下切到高德（应仍为逻辑拓扑）', g1, {
      view: 'graph', mode: 'graph', baseMap: 'amap', anim: true, minNodes: expectedNodes, minInk: 10,
    });
    if (g1.rendererCanvasId !== 'map-canvas') {
      failures.push(`切到高德后逻辑拓扑应画在内置画布，实际 ${g1.rendererCanvasId}`);
    }
    await shot('keepview-graph-amap.png');

    /* ---------- 在逻辑拓扑下切回内置 ---------- */
    console.log('\n================ 逻辑拓扑下：高德 → 内置 ================');
    await evaluate("document.getElementById('opt-basemap').value = 'builtin'; document.getElementById('opt-basemap').dispatchEvent(new Event('change')); 'ok'");
    await new Promise((r) => setTimeout(r, 2500));
    const g2 = JSON.parse(await evaluate(snap));
    check('逻辑拓扑下切回内置（应仍为逻辑拓扑）', g2, {
      view: 'graph', mode: 'graph', baseMap: 'builtin', anim: true, minNodes: expectedNodes, minInk: 10,
    });
    await shot('keepview-graph-builtin.png');

    /* ---------- 世界地图下切换底图（应保持世界地图） ---------- */
    console.log('\n================ 世界地图下切换底图 ================');
    await evaluate("document.querySelector('[data-view=\\\"map\\\"]').click(); 'ok'");
    await new Promise((r) => setTimeout(r, 2000));
    await evaluate("document.getElementById('opt-basemap').value = 'amap'; document.getElementById('opt-basemap').dispatchEvent(new Event('change')); 'ok'");
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      if ((await evaluate('window.NetScopeApp.state.baseMap')) === 'amap') break;
    }
    await new Promise((r) => setTimeout(r, 2500));
    const m1 = JSON.parse(await evaluate(snap));
    check('世界地图下切到高德（应仍为世界地图）', m1, {
      view: 'map', mode: 'map', baseMap: 'amap', anim: true, minInk: 10,
    });
    if (m1.rendererCanvasId !== 'overlay-canvas') {
      failures.push(`世界地图下高德应画在叠加层，实际 ${m1.rendererCanvasId}`);
    }
  }

  if (errors.length) {
    console.log('\n页面错误：');
    errors.slice(0, 8).forEach((e) => console.log('  ' + e));
    failures.push(`${errors.length} 个页面脚本错误`);
  }

  console.log('\n已保存: keepview-graph-amap.png / keepview-graph-builtin.png');
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
