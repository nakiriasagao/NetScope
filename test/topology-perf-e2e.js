'use strict';
/**
 * 复现并回归：
 *   A. 扫描局域网后（星型拓扑）的绘制性能 —— 输出每个绘制阶段耗时
 *   B. 「逻辑拓扑」视图在两种数据源下都要能显示：
 *        B1. 纯探测数据（未扫描局域网）
 *        B2. 局域网扫描之后
 *
 * 用法：node test/topology-perf-e2e.js [baseUrl]
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const PORT = 9620 + Math.floor(Math.random() * 40);
const BROWSER = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-topo-'));
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
  await send('Page.navigate', { url: BASE + '/?topo=' + Date.now() });
  for (let i = 0; i < 60; i += 1) {
    const ok = await evaluate("Boolean(window.NetScopeApp && window.NetScopeApp.renderer() && window.NetScopeApp.renderer().world)");
    if (ok === true) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  await evaluate("document.getElementById('legend-panel').hidden = true; 'ok'");

  const failures = [];

  /** 分阶段性能采样 */
  const perfProbe = (seconds) => `(async function () {
    const r = window.NetScopeApp.renderer();
    const stats = { draw: 0, arcs: 0, nodes: 0, overlay: 0, overlayCalls: 0, frames: [] };
    const oDraw = r.draw.bind(r);
    const oArcs = r.drawArcs.bind(r);
    const oNodes = r.drawNodes.bind(r);
    const oOverlay = r.drawOverlay.bind(r);
    r.drawArcs = function () { const t = performance.now(); const v = oArcs.apply(r, arguments); stats.arcs += performance.now() - t; return v; };
    r.drawNodes = function () { const t = performance.now(); const v = oNodes.apply(r, arguments); stats.nodes += performance.now() - t; return v; };
    r.drawOverlay = function () { stats.overlayCalls += 1; const t = performance.now(); const v = oOverlay.apply(r, arguments); stats.overlay += performance.now() - t; return v; };
    let last = performance.now();
    r.draw = function (now) {
      const t0 = performance.now();
      stats.frames.push(t0 - last);
      last = t0;
      const v = oDraw(now);
      stats.draw += performance.now() - t0;
      return v;
    };
    await new Promise(function (res) { setTimeout(res, ${seconds * 1000}); });
    r.draw = oDraw; r.drawArcs = oArcs; r.drawNodes = oNodes; r.drawOverlay = oOverlay;
    const f = stats.frames.slice().sort(function (a, b) { return a - b; });
    return JSON.stringify({
      mode: r.mode,
      lanMode: r.lanMode === true,
      nodes: r.nodes.length,
      arcs: r.arcs.length,
      seconds: ${seconds},
      drawFps: Math.round(stats.frames.length / ${seconds}),
      overlayRebuildsPerSec: Math.round(stats.overlayCalls / ${seconds}),
      msPerFrame: {
        total: Math.round((stats.draw / Math.max(1, stats.frames.length)) * 100) / 100,
        arcs: Math.round((stats.arcs / Math.max(1, stats.frames.length)) * 100) / 100,
        nodes: Math.round((stats.nodes / Math.max(1, stats.frames.length)) * 100) / 100,
        overlayPerFrame: Math.round((stats.overlay / Math.max(1, stats.frames.length)) * 100) / 100,
        overlayPerBuild: stats.overlayCalls ? Math.round((stats.overlay / stats.overlayCalls) * 100) / 100 : 0,
      },
      frameMedianMs: f.length ? Math.round(f[Math.floor(f.length / 2)] * 100) / 100 : 0,
      frameP95Ms: f.length ? Math.round(f[Math.floor(f.length * 0.95)] * 100) / 100 : 0,
      frameWorstMs: f.length ? Math.round(f[f.length - 1] * 100) / 100 : 0,
    });
  })()`;

  /* ---------------- B1：纯探测数据的逻辑拓扑 ---------------- */
  console.log('================ B1：探测后切逻辑拓扑 ================');
  await evaluate("window.NetScopeApp.trace('8.8.8.8')");
  for (let i = 0; i < 80; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    if ((await evaluate('String(window.NetScopeApp.state.busy)')) === 'false') break;
  }
  await new Promise((r) => setTimeout(r, 800));
  console.log('探测节点数:', await evaluate('window.NetScopeApp.renderer().nodes.length'));

  await evaluate("document.querySelector('[data-view=\\\"graph\\\"]').click(); 'ok'");
  await new Promise((r) => setTimeout(r, 1800));
  const b1 = JSON.parse(await evaluate(`JSON.stringify((function () {
    var r = window.NetScopeApp.renderer();
    return {
      view: window.NetScopeApp.state.view,
      mode: r.mode,
      lanMode: r.lanMode === true,
      nodes: r.nodes.length,
      arcs: r.arcs.length,
      labels: document.querySelectorAll('#node-overlay g').length,
      canvasBlank: false,
      inkSamples: (function () {
        var ctx = r.canvas.getContext('2d');
        var img = ctx.getImageData(0, 0, r.width, r.height).data;
        var n = 0;
        for (var i = 0; i < img.length; i += 4 * 29) { if (img[i] + img[i+1] + img[i+2] + img[i+3] > 30) n += 1; }
        return n;
      })(),
      unlocated: r.unlocated ? r.unlocated.length : 0,
    };
  })())`));
  console.log(JSON.stringify(b1));
  fs.mkdirSync(path.join(__dirname, '..', 'data', 'screenshots'), { recursive: true });
  let shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(__dirname, '..', 'data', 'screenshots', 'graph-from-trace.png'), Buffer.from(shot.data, 'base64'));
  if (b1.view !== 'graph') failures.push('B1：视图未切到逻辑拓扑');
  if (b1.mode !== 'graph') failures.push('B1：渲染器模式不是 graph');
  if (b1.lanMode) failures.push('B1：纯探测数据被误判为局域网模式');
  if (b1.nodes < 1) failures.push(`B1：逻辑拓扑没有节点（${b1.nodes}）`);
  if (b1.arcs < 1) failures.push(`B1：逻辑拓扑没有连线（${b1.arcs}）`);
  if (b1.labels < 1) failures.push(`B1：逻辑拓扑没有标签（${b1.labels}）`);
  if (b1.inkSamples < 10) failures.push(`B1：画布空白（着墨 ${b1.inkSamples}）`);

  /* ---------------- A：局域网星型拓扑性能 ---------------- */
  console.log('\n================ A：局域网星型拓扑性能 ================');
  await evaluate("document.getElementById('opt-deepscan').checked = false; document.getElementById('btn-lanscan').click(); 'ok'");
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    const st = await evaluate("JSON.stringify({ busy: window.NetScopeApp.state.busy, lan: Boolean(window.NetScopeApp.state.lan) })");
    const p = JSON.parse(st);
    if (p.lan && !p.busy) break;
  }
  await new Promise((r) => setTimeout(r, 1500));
  const lanState = JSON.parse(await evaluate(`JSON.stringify((function () {
    var r = window.NetScopeApp.renderer();
    return { mode: r.mode, lanMode: r.lanMode === true, nodes: r.nodes.length, arcs: r.arcs.length,
             labels: document.querySelectorAll('#node-overlay g').length, devices: window.NetScopeApp.state.lan ? window.NetScopeApp.state.lan.lan.devices.length : 0 };
  })())`));
  console.log('局域网拓扑:', JSON.stringify(lanState));
  // 星型拓扑当前会停掉动画（setLanTopology 里调用了 stopAnimation）。
  // 这里强制开一次，量出"如果开启动画"的真实开销，用于判断是否卡顿。
  await evaluate("window.NetScopeApp.renderer().startAnimation(); 'ok'");
  await new Promise((r) => setTimeout(r, 500));
  const perfLan = JSON.parse(await evaluate(perfProbe(2)));
  console.log(JSON.stringify(perfLan, null, 2));
  const lanAnimRunning = await evaluate('window.NetScopeApp.renderer().animation.running === true');
  console.log('星型拓扑下动画是否在运行:', lanAnimRunning);
  if (!lanAnimRunning) failures.push('A：局域网星型拓扑的动画没有运行（画面静止）');

  if (perfLan.overlayRebuildsPerSec > perfLan.drawFps * 0.6) {
    failures.push(`A：星型拓扑仍在每帧重建标签层（${perfLan.overlayRebuildsPerSec} 次/秒 vs ${perfLan.drawFps} fps）`);
  }
  if (perfLan.frameP95Ms > 33) failures.push(`A：星型拓扑帧时间过长（P95 ${perfLan.frameP95Ms} ms）`);
  if (perfLan.msPerFrame.total > 12) failures.push(`A：单帧绘制耗时过长（${perfLan.msPerFrame.total} ms）`);

  shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(__dirname, '..', 'data', 'screenshots', 'lan-star-topology.png'), Buffer.from(shot.data, 'base64'));

  /* ---------------- B2：扫描后再切逻辑拓扑 ---------------- */
  console.log('\n================ B2：扫描局域网后再切逻辑拓扑 ================');
  await evaluate("document.querySelector('[data-view=\\\"graph\\\"]').click(); 'ok'");
  await new Promise((r) => setTimeout(r, 1800));
  const b2a = JSON.parse(await evaluate(`JSON.stringify((function () {
    var r = window.NetScopeApp.renderer();
    return { view: window.NetScopeApp.state.view, mode: r.mode, lanMode: r.lanMode === true, nodes: r.nodes.length, arcs: r.arcs.length,
             labels: document.querySelectorAll('#node-overlay g').length };
  })())`));
  console.log('点击逻辑拓扑后:', JSON.stringify(b2a));

  // 再点一次世界地图，然后重新探测一个目标，最后切逻辑拓扑
  await evaluate("document.querySelector('[data-view=\\\"map\\\"]').click(); 'ok'");
  await new Promise((r) => setTimeout(r, 1200));
  await evaluate("window.NetScopeApp.trace('223.5.5.5')");
  for (let i = 0; i < 80; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    if ((await evaluate('String(window.NetScopeApp.state.busy)')) === 'false') break;
  }
  await new Promise((r) => setTimeout(r, 800));
  await evaluate("document.querySelector('[data-view=\\\"graph\\\"]').click(); 'ok'");
  await new Promise((r) => setTimeout(r, 1800));
  const b2 = JSON.parse(await evaluate(`JSON.stringify((function () {
    var r = window.NetScopeApp.renderer();
    return {
      view: window.NetScopeApp.state.view, mode: r.mode, lanMode: r.lanMode === true,
      nodes: r.nodes.length, arcs: r.arcs.length,
      labels: document.querySelectorAll('#node-overlay g').length,
      inkSamples: (function () {
        var ctx = r.canvas.getContext('2d');
        var img = ctx.getImageData(0, 0, r.width, r.height).data;
        var n = 0;
        for (var i = 0; i < img.length; i += 4 * 29) { if (img[i] + img[i+1] + img[i+2] + img[i+3] > 30) n += 1; }
        return n;
      })(),
    };
  })())`));
  console.log('重新探测后切逻辑拓扑:', JSON.stringify(b2));
  shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(__dirname, '..', 'data', 'screenshots', 'graph-after-lan.png'), Buffer.from(shot.data, 'base64'));

  if (b2.view !== 'graph') failures.push('B2：视图未切到逻辑拓扑');
  if (b2.lanMode) failures.push('B2：重新探测后仍被判定为局域网模式（星型拓扑未退出）');
  if (b2.nodes < 1) failures.push(`B2：逻辑拓扑没有节点（${b2.nodes}）`);
  if (b2.arcs < 1) failures.push(`B2：逻辑拓扑没有连线（${b2.arcs}）`);
  if (b2.inkSamples < 10) failures.push(`B2：画布空白（着墨 ${b2.inkSamples}）`);

  // 关键断言：逻辑拓扑必须按"跳"展开，不能把同城多跳合并成 1 个节点
  // （上海 6 跳全部 geo=Shanghai，合并后只剩"本机→目标"一条线，看起来像拓扑没显示）
  const b2Detail = JSON.parse(await evaluate(`JSON.stringify((function () {
    var r = window.NetScopeApp.renderer();
    var app = window.NetScopeApp;
    var hops = app.state.hops || [];
    var located = hops.filter(function (h) { return h.geo && typeof h.geo.lat === 'number'; }).length;
    var links = r.arcs.map(function (a) { return a.kind || 'trace'; });
    return {
      totalHops: hops.length,
      locatedHops: located,
      renderedNodes: r.nodes.length,
      renderedArcs: r.arcs.length,
      lanArcs: links.filter(function (k) { return k === 'lan'; }).length,
      unlocated: r.unlocated ? r.unlocated.length : 0,
      labels: r.nodes.map(function (n) { return n.label; }),
    };
  })())`));
  console.log('  逻辑拓扑明细:', JSON.stringify(b2Detail));
  if (b2Detail.lanArcs > 0) failures.push(`B2：逻辑拓扑里出现了 ${b2Detail.lanArcs} 条局域网星型连线（星型模式未复位）`);
  // 已定位跳点 + 起点（本机）都应各占一个节点
  const expectedNodes = b2Detail.locatedHops + 1;
  if (b2Detail.renderedNodes < expectedNodes) {
    failures.push(`B2：逻辑拓扑按跳展开应有 ${expectedNodes} 个节点（已定位 ${b2Detail.locatedHops} 跳 + 本机），实际仅 ${b2Detail.renderedNodes} 个 —— 同城跳点被合并了`);
  }
  if (b2Detail.renderedArcs < b2Detail.renderedNodes - 1) {
    failures.push(`B2：连线数 ${b2Detail.renderedArcs} 少于节点数-1（${b2Detail.renderedNodes - 1}）`);
  }

  if (errors.length) {
    console.log('\n页面错误：');
    errors.slice(0, 8).forEach((e) => console.log('  ' + e));
    failures.push(`${errors.length} 个页面脚本错误`);
  }

  console.log('\n已保存: graph-from-trace.png / lan-star-topology.png / graph-after-lan.png');
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
