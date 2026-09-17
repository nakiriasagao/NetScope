'use strict';
/**
 * 复现：高德地图模式下点「逻辑拓扑」，拓扑完全不显示
 *
 * 路径刻意区分：
 *   A. 先探测（内置地图）→ 切高德 → 再点「逻辑拓扑」   ← 用户报告的路径
 *   B. 先切高德 → 点「逻辑拓扑」→ 再探测
 *
 * 用法：node test/amap-graph-e2e.js [baseUrl]
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const TARGET = process.argv[3] || '8.8.8.8';
const PORT = 9540 + Math.floor(Math.random() * 30);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-amapgraph-'));
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
  await send('Page.navigate', { url: BASE + '/?ag=' + Date.now() });
  for (let i = 0; i < 60; i += 1) {
    if ((await evaluate("Boolean(window.NetScopeApp && window.NetScopeApp.renderer().world)")) === true) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  await evaluate("document.getElementById('legend-panel').hidden = true; 'ok'");

  const failures = [];
  // 三块画布都要看：内置画布、叠加层、可见性、着墨
  const snap = `JSON.stringify((function () {
    var app = window.NetScopeApp;
    var r = app.renderer();
    var inner = document.getElementById('map-canvas');
    var ovl = document.getElementById('overlay-canvas');
    var ink = function (cv) {
      if (!cv || !cv.width || !cv.height) return -1;
      try {
        var ctx = cv.getContext('2d');
        var img = ctx.getImageData(0, 0, Math.min(cv.width, 900), Math.min(cv.height, 700)).data;
        var n = 0;
        for (var i = 0; i < img.length; i += 4 * 29) { if (img[i] + img[i+1] + img[i+2] + img[i+3] > 30) n += 1; }
        return n;
      } catch (e) { return -1; }
    };
    var visible = function (el) {
      if (!el) return null;
      var st = getComputedStyle(el);
      var rect = el.getBoundingClientRect();
      return { hidden: el.hidden, display: st.display, visibility: st.visibility, opacity: st.opacity,
               size: [Math.round(rect.width), Math.round(rect.height)], zIndex: st.zIndex };
    };
    return {
      view: app.state.view,
      baseMap: app.state.baseMap,
      mode: r.mode,
      plain: r.plain === true,
      lanMode: r.lanMode === true,
      rendererCanvasId: r.canvas ? r.canvas.id : null,
      ctxMatches: r.ctx && r.canvas ? (r.ctx.canvas === r.canvas) : null,
      rendererSize: [r.width, r.height],
      nodes: r.nodes.length,
      arcs: r.arcs.length,
      labels: document.querySelectorAll('#node-overlay g').length,
      innerCanvas: visible(inner),
      overlayCanvas: visible(ovl),
      amapHost: visible(document.getElementById('amap-host')),
      innerInk: ink(inner),
      overlayInk: ink(ovl),
      rendererInk: ink(r.canvas),
      animRunning: r.animation && r.animation.running === true,
    };
  })())`;

  const show = (label, s) => {
    console.log(`\n【${label}】`);
    console.log('  view=' + s.view + ' baseMap=' + s.baseMap + ' mode=' + s.mode + ' plain=' + s.plain +
      ' 画布=' + s.rendererCanvasId + ' 上下文匹配=' + s.ctxMatches + ' 尺寸=' + JSON.stringify(s.rendererSize));
    console.log('  节点=' + s.nodes + ' 连线=' + s.arcs + ' 标签=' + s.labels + ' 动画=' + s.animRunning);
    console.log('  内置画布: ' + JSON.stringify(s.innerCanvas) + ' 着墨=' + s.innerInk);
    console.log('  叠加画布: ' + JSON.stringify(s.overlayCanvas) + ' 着墨=' + s.overlayInk);
    console.log('  渲染器画布着墨=' + s.rendererInk);
  };
  const assertVisible = (label, s, minInk) => {
    if (s.nodes < 1) failures.push(`${label}：渲染器没有节点`);
    if (s.arcs < 1) failures.push(`${label}：渲染器没有连线`);
    if (s.labels < 1) failures.push(`${label}：没有标签`);
    if (s.rendererInk < minInk) failures.push(`${label}：渲染器画布内容过少（着墨 ${s.rendererInk}，画布 ${s.rendererCanvasId}）`);
    // 渲染目标必须真实可见：不能是 hidden / display:none
    const target = s.rendererCanvasId === 'overlay-canvas' ? s.overlayCanvas : s.innerCanvas;
    if (target && (target.hidden || target.display === 'none')) {
      failures.push(`${label}：渲染目标 ${s.rendererCanvasId} 处于隐藏状态（画了但看不见）`);
    }
    if (target && (target.size[0] < 50 || target.size[1] < 50)) {
      failures.push(`${label}：渲染目标尺寸异常 ${JSON.stringify(target.size)}`);
    }
  };

  const outDir = path.join(__dirname, '..', 'data', 'screenshots');
  fs.mkdirSync(outDir, { recursive: true });
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, name), Buffer.from(s.data, 'base64'));
  };

  if (!KEY || !SECURITY) {
    console.log('SKIP 未提供高德凭据（NS_AMAP_KEY / NS_AMAP_SECURITY）');
    ws.close();
    child.kill();
    process.exit(0);
  }
  await evaluate(`window.NetScopeAmap.saveLocalCredentials({ key: ${JSON.stringify(KEY)}, security: ${JSON.stringify(SECURITY)}, enabled: true }); 'ok'`);
  const waitAmap = async () => {
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      if ((await evaluate('window.NetScopeApp.state.baseMap')) === 'amap') return true;
    }
    return false;
  };
  const traceTo = async (t) => {
    await evaluate(`window.NetScopeApp.trace(${JSON.stringify(t)})`);
    for (let i = 0; i < 80; i += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      if ((await evaluate('String(window.NetScopeApp.state.busy)')) === 'false') break;
    }
    await new Promise((r) => setTimeout(r, 1200));
  };

  /* ================= A：探测 → 切高德 → 点逻辑拓扑 ================= */
  console.log('================ A：探测 → 切高德 → 点「逻辑拓扑」================');
  await traceTo(TARGET);
  await evaluate("document.getElementById('opt-basemap').value = 'amap'; document.getElementById('opt-basemap').dispatchEvent(new Event('change')); 'ok'");
  const okA = await waitAmap();
  await new Promise((r) => setTimeout(r, 2500));
  if (!okA) failures.push('A：高德底图未能启用');
  show('A1 高德 + 世界地图', JSON.parse(await evaluate(snap)));
  await shot('amap-graph-a1-map.png');

  await evaluate("document.querySelector('[data-view=\\\"graph\\\"]').click(); 'ok'");
  await new Promise((r) => setTimeout(r, 700));
  console.log('  [切换后 0.7s] ' + await evaluate(`JSON.stringify({
    mode: window.NetScopeApp.renderer().mode,
    nodes: window.NetScopeApp.renderer().nodes.length,
    plain: window.NetScopeApp.renderer().plain === true,
    rendererCanvasId: window.NetScopeApp.renderer().canvas.id,
    suspended: window.NetScopeAmap ? null : null,
  })`));
  await new Promise((r) => setTimeout(r, 1800));
  console.log('  [切换后 2.5s] ' + await evaluate(`JSON.stringify({
    mode: window.NetScopeApp.renderer().mode,
    nodes: window.NetScopeApp.renderer().nodes.length,
    plain: window.NetScopeApp.renderer().plain === true,
    rendererCanvasId: window.NetScopeApp.renderer().canvas.id,
  })`));
  const a2 = JSON.parse(await evaluate(snap));
  show('A2 高德 + 逻辑拓扑（用户报告不显示的这一步）', a2);
  await shot('amap-graph-a2-graph.png');
  assertVisible('A2 高德逻辑拓扑', a2, 10);

  // 逻辑拓扑必须按"跳"展开：节点数应接近已定位跳点数 + 1（本机），
  // 若这里只剩几个点，说明又被按地理坐标合并了
  const a2Detail = JSON.parse(await evaluate(`JSON.stringify((function () {
    var app = window.NetScopeApp;
    var hops = app.state.hops || [];
    return {
      totalHops: hops.length,
      locatedHops: hops.filter(function (h) { return h.geo && typeof h.geo.lat === 'number'; }).length,
      graphNodes: app.renderer().nodes.length,
    };
  })())`));
  console.log('  A2 明细: ' + JSON.stringify(a2Detail));
  const expectA2 = a2Detail.locatedHops + 1;
  if (a2Detail.graphNodes < expectA2) {
    failures.push(`A2：高德逻辑拓扑未按跳展开（应有约 ${expectA2} 个节点，实际 ${a2Detail.graphNodes}）`);
  }

  // 再切回世界地图，确认高德恢复
  await evaluate("document.querySelector('[data-view=\\\"map\\\"]').click(); 'ok'");
  await new Promise((r) => setTimeout(r, 3000));
  const a3 = JSON.parse(await evaluate(snap));
  show('A3 切回世界地图', a3);
  if (a3.baseMap !== 'amap') failures.push('A3：切回世界地图后底图应仍为高德');
  if (a3.rendererCanvasId !== 'overlay-canvas') failures.push(`A3：应画在叠加层，实际 ${a3.rendererCanvasId}`);
  assertVisible('A3 高德世界地图', a3, 10);
  await shot('amap-graph-a3-back.png');

  /* ================= B：先切高德 → 点逻辑拓扑 → 探测 ================= */
  console.log('\n================ B：高德 + 逻辑拓扑 → 探测 ================');
  await evaluate("document.querySelector('[data-view=\\\"graph\\\"]').click(); 'ok'");
  await new Promise((r) => setTimeout(r, 1500));
  await traceTo('223.5.5.5');
  const b1 = JSON.parse(await evaluate(snap));
  show('B1 探测完成（应仍在逻辑拓扑）', b1);
  assertVisible('B1 高德逻辑拓扑探测后', b1, 10);

  if (errors.length) {
    console.log('\n页面错误：');
    errors.slice(0, 10).forEach((e) => console.log('  ' + e));
    failures.push(`${errors.length} 个页面脚本错误`);
  }

  console.log('\n已保存: amap-graph-a1-map.png / amap-graph-a2-graph.png / amap-graph-a3-back.png');
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
