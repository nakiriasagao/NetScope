'use strict';
/**
 * 复现并回归：
 *   1. 高德底图 + 逻辑拓扑 → 切回世界地图，应恢复为高德底图（不能被改成内置地图）
 *   2. 逻辑拓扑模式下的绘制性能（帧时间 / 每帧 DOM 重建次数）
 *
 * 用法：node test/view-switch-basemap-e2e.js [baseUrl]
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const PORT = 9650 + Math.floor(Math.random() * 40);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-view-'));
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
  await send('Page.navigate', { url: BASE + '/?view=' + Date.now() });
  for (let i = 0; i < 60; i += 1) {
    const ok = await evaluate("Boolean(window.NetScopeApp && window.NetScopeApp.renderer() && window.NetScopeApp.renderer().world)");
    if (ok === true) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  await evaluate("document.getElementById('legend-panel').hidden = true; 'ok'");

  const failures = [];

  // 探测一个跨洲目标，得到多节点拓扑
  console.log('================ 探测 ================');
  await evaluate("window.NetScopeApp.trace('8.8.8.8')");
  for (let i = 0; i < 80; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    if ((await evaluate('String(window.NetScopeApp.state.busy)')) === 'false') break;
  }
  await new Promise((r) => setTimeout(r, 800));
  console.log('节点数:', await evaluate('window.NetScopeApp.renderer().nodes.length'));

  /* ---------------- 问题 2：逻辑拓扑性能 ---------------- */
  console.log('\n================ 问题 2：逻辑拓扑绘制性能 ================');
  // 统计 1 秒内 drawOverlay 的重建次数（通过 hook 计数）
  const perf = JSON.parse(await evaluate(`(async function () {
    const r = window.NetScopeApp.renderer();
    // 切到逻辑拓扑
    r.setMode('graph');
    await new Promise(function (res) { setTimeout(res, 300); });

    let overlayCalls = 0;
    const originalOverlay = r.drawOverlay.bind(r);
    r.drawOverlay = function () { overlayCalls += 1; return originalOverlay(); };

    let drawCalls = 0;
    const originalDraw = r.draw.bind(r);
    const frames = [];
    let last = performance.now();
    r.draw = function (now) {
      drawCalls += 1;
      const t = performance.now();
      frames.push(t - last);
      last = t;
      return originalDraw(now);
    };

    await new Promise(function (res) { setTimeout(res, 1500); });
    r.draw = originalDraw;
    r.drawOverlay = originalOverlay;

    frames.sort(function (a, b) { return a - b; });
    const median = frames.length ? frames[Math.floor(frames.length / 2)] : 0;
    const p95 = frames.length ? frames[Math.floor(frames.length * 0.95)] : 0;
    const worst = frames.length ? frames[frames.length - 1] : 0;

    return JSON.stringify({
      mode: r.mode,
      seconds: 1.5,
      drawFps: Math.round(drawCalls / 1.5),
      overlayRebuilds: overlayCalls,
      overlayRebuildsPerSecond: Math.round(overlayCalls / 1.5),
      frameMedianMs: Math.round(median * 100) / 100,
      frameP95Ms: Math.round(p95 * 100) / 100,
      frameWorstMs: Math.round(worst * 100) / 100,
      nodes: r.nodes.length,
      labels: document.querySelectorAll('#node-overlay g').length,
    });
  })()`));
  console.log(JSON.stringify(perf, null, 2));
  if (perf.overlayRebuildsPerSecond > perf.drawFps * 0.6) {
    failures.push(`问题2：每帧都在重建 SVG 标签层（${perf.overlayRebuildsPerSecond} 次/秒 ≈ 绘制 ${perf.drawFps} fps）`);
  }
  if (perf.frameP95Ms > 40) failures.push(`问题2：帧时间过长（P95 ${perf.frameP95Ms} ms，> 40ms 会明显卡顿）`);

  /* ---------------- 问题 1：高德 + 逻辑拓扑 → 切回世界地图 ---------------- */
  if (!KEY || !SECURITY) {
    console.log('\n⊘ 未提供高德凭据，跳过问题 1 验收');
  } else {
    console.log('\n================ 问题 1：高德 → 逻辑拓扑 → 世界地图 ================');
    await evaluate(`window.NetScopeAmap.saveLocalCredentials({ key: ${JSON.stringify(KEY)}, security: ${JSON.stringify(SECURITY)}, enabled: true }); 'ok'`);
    await evaluate("document.getElementById('opt-basemap').value = 'amap'; document.getElementById('opt-basemap').dispatchEvent(new Event('change')); 'ok'");
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      if ((await evaluate('window.NetScopeApp.state.baseMap')) === 'amap') break;
    }
    await new Promise((r) => setTimeout(r, 2500));
    const stateOf = `JSON.stringify({
      baseMap: window.NetScopeApp.state.baseMap,
      stored: window.localStorage.getItem('netscope.basemap'),
      selectValue: document.getElementById('opt-basemap').value,
      view: window.NetScopeApp.state.view,
      amapHostHidden: document.getElementById('amap-host').hidden,
      canvasHidden: document.getElementById('map-canvas').hidden,
      overlayHidden: document.getElementById('overlay-canvas').hidden,
      mode: window.NetScopeApp.renderer().mode,
      plain: window.NetScopeApp.renderer().plain === true,
      rendererCanvasId: window.NetScopeApp.renderer().canvas ? window.NetScopeApp.renderer().canvas.id : null,
    })`;
    const sAmap = JSON.parse(await evaluate(stateOf));
    console.log('① 高德 + 世界地图:', JSON.stringify(sAmap));
    if (sAmap.baseMap !== 'amap') failures.push('问题1：未能启用高德底图');

    // 切到逻辑拓扑
    await evaluate("document.querySelector('[data-view=\\\"graph\\\"]').click(); 'ok'");
    await new Promise((r) => setTimeout(r, 2000));
    const sGraph = JSON.parse(await evaluate(stateOf));
    console.log('② 高德 + 逻辑拓扑:', JSON.stringify(sGraph));
    if (sGraph.mode !== 'graph') failures.push('问题1：未能切到逻辑拓扑');

    // 切回世界地图 —— 这里应恢复为高德底图
    await evaluate("document.querySelector('[data-view=\\\"map\\\"]').click(); 'ok'");
    await new Promise((r) => setTimeout(r, 3000));
    const sBack = JSON.parse(await evaluate(stateOf));
    console.log('③ 切回世界地图:', JSON.stringify(sBack));
    if (sBack.view !== 'map') failures.push('问题1：视图未切回世界地图');
    if (sBack.baseMap !== 'amap') {
      failures.push(`问题1：切回世界地图后底图被改成了「${sBack.baseMap}」，应保持用户选择的高德地图`);
      console.log('✘ 复现：切回世界地图后显示的是内置地图，而不是高德地图');
    } else {
      console.log('✔ 切回世界地图后仍为高德底图');
    }
    if (sBack.selectValue !== 'amap') failures.push('问题1：底图下拉框的值未保持为高德');
    if (sBack.stored !== 'amap') failures.push('问题1：localStorage 中的底图选择被改写');

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const outDir = path.join(__dirname, '..', 'data', 'screenshots');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'view-switch-amap.png'), Buffer.from(shot.data, 'base64'));
    console.log('已保存: data/screenshots/view-switch-amap.png');
  }

  if (errors.length) {
    console.log('\n页面错误：');
    errors.slice(0, 8).forEach((e) => console.log('  ' + e));
    failures.push(`${errors.length} 个页面脚本错误`);
  }

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
