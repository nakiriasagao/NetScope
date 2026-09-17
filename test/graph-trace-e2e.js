'use strict';
/**
 * 复现并回归：探测外网时的逻辑拓扑显示
 *
 * 场景（用户报告）：
 *   1. 先在「逻辑拓扑」视图下探测外网目标 → 拓扑必须按跳展开，不能塌成一条线
 *   2. 边收边画（增量推送）过程中也不能被重新按坐标合并
 *   3. 探测完成、切换一次视图后仍然正确
 *   4. 高德底图下的逻辑拓扑同样正确
 *
 * 用法：node test/graph-trace-e2e.js [baseUrl]
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const TARGET = process.argv[3] || '8.8.8.8';
const PORT = 9560 + Math.floor(Math.random() * 40);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-graphtrace-'));
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
  await send('Page.navigate', { url: BASE + '/?gt=' + Date.now() });
  for (let i = 0; i < 60; i += 1) {
    if ((await evaluate("Boolean(window.NetScopeApp && window.NetScopeApp.renderer().world)")) === true) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  await evaluate("document.getElementById('legend-panel').hidden = true; 'ok'");

  const failures = [];
  const snapshot = `JSON.stringify((function () {
    var app = window.NetScopeApp;
    var r = app.renderer();
    var hops = app.state.hops || [];
    var located = hops.filter(function (h) { return h.geo && typeof h.geo.lat === 'number'; }).length;
    var labels = Array.prototype.slice.call(document.querySelectorAll('#node-overlay g text')).map(function (t) { return t.textContent; });
    return {
      view: app.state.view,
      baseMap: app.state.baseMap,
      mode: r.mode,
      lanMode: r.lanMode === true,
      hops: hops.length,
      locatedHops: located,
      nodes: r.nodes.length,
      arcs: r.arcs.length,
      unlocated: r.unlocated ? r.unlocated.length : 0,
      labelCount: labels.length,
      labels: labels.slice(0, 6),
      canvasId: r.canvas ? r.canvas.id : null,
      inkSamples: (function () {
        try {
          var cv = r.canvas;
          var ctx = cv.getContext('2d');
          var img = ctx.getImageData(0, 0, r.width, r.height).data;
          var n = 0;
          for (var i = 0; i < img.length; i += 4 * 29) { if (img[i] + img[i+1] + img[i+2] + img[i+3] > 30) n += 1; }
          return n;
        } catch (e) { return -1; }
      })(),
    };
  })())`;

  const check = (label, s, opts) => {
    const o = opts || {};
    console.log(`\n【${label}】`);
    console.log('  ' + JSON.stringify(s));
    if (o.minNodes && s.nodes < o.minNodes) {
      failures.push(`${label}：逻辑拓扑节点过少（${s.nodes} < ${o.minNodes}）—— 同城跳点又被合并了`);
    }
    if (o.expectArcs && s.arcs < s.nodes - 1) {
      failures.push(`${label}：连线数 ${s.arcs} 少于节点数-1（${s.nodes - 1}）`);
    }
    if (o.mode && s.mode !== o.mode) failures.push(`${label}：渲染模式应为 ${o.mode}，实际 ${s.mode}`);
    if (o.lanMode === false && s.lanMode) failures.push(`${label}：仍处于局域网星型模式`);
    if (o.minLabels && s.labelCount < o.minLabels) failures.push(`${label}：标签过少（${s.labelCount}）`);
    if (o.minInk && s.inkSamples < o.minInk) failures.push(`${label}：画布内容过少（着墨 ${s.inkSamples}）`);
  };

  const outDir = path.join(__dirname, '..', 'data', 'screenshots');
  fs.mkdirSync(outDir, { recursive: true });
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, name), Buffer.from(s.data, 'base64'));
  };

  /* ---------- 场景 1：先在逻辑拓扑视图，再探测外网 ---------- */
  console.log('================ 场景 1：逻辑拓扑视图下探测外网 ================');
  console.log('目标：' + TARGET);
  await evaluate("document.querySelector('[data-view=\\\"graph\\\"]').click(); 'ok'");
  await new Promise((r) => setTimeout(r, 800));
  await evaluate(`window.NetScopeApp.trace(${JSON.stringify(TARGET)})`);

  // 边收边画：中途采样
  let mid = null;
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 1200));
    const st = JSON.parse(await evaluate(snapshot));
    const busy = await evaluate('String(window.NetScopeApp.state.busy)');
    if (st.hops >= 3 && st.nodes >= 2 && busy === 'true') {
      mid = st;
      break;
    }
    if (busy === 'false') break;
  }
  if (mid) {
    check('边收边画（增量）中途', mid, { mode: 'graph', lanMode: false });
    // 中途就应看到"节点数 ≥ 已定位跳数"，而不是被合并
    if (mid.locatedHops >= 2 && mid.nodes < mid.locatedHops) {
      failures.push(`边收边画：已定位 ${mid.locatedHops} 跳却只有 ${mid.nodes} 个节点（增量重绘未按跳展开）`);
    }
  } else {
    console.log('\n（未取到增量中途样本，跳过该断言）');
  }

  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    if ((await evaluate('String(window.NetScopeApp.state.busy)')) === 'false') break;
  }
  await new Promise((r) => setTimeout(r, 1200));
  const s1 = JSON.parse(await evaluate(snapshot));
  const expected1 = s1.locatedHops + 1;
  check('探测完成（逻辑拓扑）', s1, {
    mode: 'graph',
    lanMode: false,
    expectArcs: true,
    minLabels: Math.min(expected1, 3),
    minInk: 10,
  });
  if (s1.nodes < expected1) {
    failures.push(`场景1：按跳展开应有 ${expected1} 个节点（本机 + 已定位 ${s1.locatedHops} 跳），实际 ${s1.nodes}`);
  }
  await shot('graph-external-trace.png');

  /* ---------- 场景 2：切世界地图再切回逻辑拓扑 ---------- */
  console.log('\n================ 场景 2：世界地图 ⇄ 逻辑拓扑 ================');
  await evaluate("document.querySelector('[data-view=\\\"map\\\"]').click(); 'ok'");
  await new Promise((r) => setTimeout(r, 1500));
  const sMap = JSON.parse(await evaluate(snapshot));
  check('切到世界地图（按坐标合并）', sMap, { mode: 'map', lanMode: false, minInk: 10 });
  if (sMap.nodes > s1.nodes) failures.push('场景2：世界地图视图不应比逻辑拓扑节点更多');

  await evaluate("document.querySelector('[data-view=\\\"graph\\\"]').click(); 'ok'");
  await new Promise((r) => setTimeout(r, 1800));
  const s2 = JSON.parse(await evaluate(snapshot));
  check('切回逻辑拓扑', s2, { mode: 'graph', lanMode: false, expectArcs: true, minLabels: 3 });
  if (s2.nodes < s1.nodes) {
    failures.push(`场景2：切回逻辑拓扑后节点变少（${s1.nodes} → ${s2.nodes}）`);
  }

  /* ---------- 场景 3：高德底图下的逻辑拓扑 ---------- */
  if (KEY && SECURITY) {
    console.log('\n================ 场景 3：高德底图 ⇄ 逻辑拓扑 ================');
    await evaluate(`window.NetScopeAmap.saveLocalCredentials({ key: ${JSON.stringify(KEY)}, security: ${JSON.stringify(SECURITY)}, enabled: true }); 'ok'`);
    await evaluate("document.getElementById('opt-basemap').value = 'amap'; document.getElementById('opt-basemap').dispatchEvent(new Event('change')); 'ok'");
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      if ((await evaluate('window.NetScopeApp.state.baseMap')) === 'amap') break;
    }
    await new Promise((r) => setTimeout(r, 2500));
    const sAmap = JSON.parse(await evaluate(snapshot));
    check('高德 + 世界地图', sAmap, { mode: 'map', minInk: 10 });
    if (sAmap.canvasId !== 'overlay-canvas') failures.push(`场景3：高德模式应画在叠加层，实际 ${sAmap.canvasId}`);

    await evaluate("document.querySelector('[data-view=\\\"graph\\\"]').click(); 'ok'");
    await new Promise((r) => setTimeout(r, 1800));
    const sAmapGraph = JSON.parse(await evaluate(snapshot));
    check('高德 + 逻辑拓扑', sAmapGraph, { mode: 'graph', lanMode: false, expectArcs: true, minLabels: 3 });
    if (sAmapGraph.nodes < s1.nodes) {
      failures.push(`场景3：高德挂起后的逻辑拓扑节点变少（${s1.nodes} → ${sAmapGraph.nodes}）`);
    }
    if (sAmapGraph.baseMap !== 'amap') failures.push('场景3：逻辑拓扑不应改变用户的底图选择');
    await shot('graph-external-amap.png');

    await evaluate("document.querySelector('[data-view=\\\"map\\\"]').click(); 'ok'");
    await new Promise((r) => setTimeout(r, 2500));
    const sBack = JSON.parse(await evaluate(snapshot));
    check('切回世界地图（恢复高德）', sBack, { mode: 'map', minInk: 10 });
    if (sBack.baseMap !== 'amap') failures.push('场景3：切回世界地图后底图应仍为高德');
  } else {
    console.log('\n⊘ 未提供高德凭据，跳过场景 3');
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
