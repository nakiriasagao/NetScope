'use strict';
/**
 * 复现并回归：局域网扫描后的地图/拓扑显示链路
 *
 * 场景：
 *   1. 探测一个目标 → 内置地图应正常（陆地 + 拓扑）
 *   2. 扫描局域网 → 应切到星型拓扑视图
 *   3. 切到高德再切回内置 → 应恢复内置画布
 *   4. 再探测另一个目标 → 地图与拓扑都应正常
 *
 * 用法：node test/lan-then-trace-e2e.js [baseUrl]
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const PORT = 9690 + Math.floor(Math.random() * 40);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-lantrace-'));
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

  /** 采集当前渲染状态 */
  const probeState = `JSON.stringify((function () {
    var app = window.NetScopeApp;
    var r = app.renderer();
    var canvas = document.getElementById('map-canvas');
    var overlayCv = document.getElementById('overlay-canvas');
    var host = document.getElementById('amap-host');
    var land = 0, ink = 0;
    try {
      var ctx = (r.canvas || canvas).getContext('2d');
      var img = ctx.getImageData(0, 0, Math.min(r.width, 900), Math.min(r.height, 700)).data;
      for (var i = 0; i < img.length; i += 4 * 23) {
        var R = img[i], G = img[i + 1], B = img[i + 2], A = img[i + 3];
        if (R + G + B + A > 30) ink += 1;
        if (Math.abs(R - 22) < 14 && Math.abs(G - 39) < 14 && Math.abs(B - 63) < 16) land += 1;
      }
    } catch (e) { return JSON.stringify({ readError: e.message }); }
    return {
      baseMap: app.state.baseMap,
      plain: r.plain === true,
      lanMode: r.lanMode === true,
      rendererCanvasId: r.canvas ? r.canvas.id : null,
      ctxMatches: r.ctx && r.canvas ? (r.ctx.canvas === r.canvas) : null,
      canvasHidden: canvas.hidden,
      overlayHidden: overlayCv ? overlayCv.hidden : null,
      amapHostHidden: host ? host.hidden : null,
      rendererSize: [r.width, r.height],
      nodes: r.nodes.length,
      arcs: r.arcs.length,
      labels: document.querySelectorAll('#node-overlay g').length,
      landSamples: land,
      inkSamples: ink,
    };
  })())`;

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 950, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: BASE + '/?lantrace=' + Date.now() });
  for (let i = 0; i < 60; i += 1) {
    const ok = await evaluate("Boolean(window.NetScopeApp && window.NetScopeApp.renderer() && window.NetScopeApp.renderer().world)");
    if (ok === true) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  await evaluate("document.getElementById('legend-panel').hidden = true; 'ok'");

  const failures = [];
  const report = (title, state) => {
    console.log(`\n【${title}】`);
    console.log('  ' + JSON.stringify(state));
    return state;
  };

  /* ---------- 1. 基线：探测一个目标 ---------- */
  console.log('================ 步骤 1：内置地图探测 ================');
  await evaluate("window.NetScopeApp.trace('223.5.5.5')");
  for (let i = 0; i < 80; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    if ((await evaluate('String(window.NetScopeApp.state.busy)')) === 'false') break;
  }
  await new Promise((r) => setTimeout(r, 800));
  let s1 = JSON.parse(await evaluate(probeState));
  report('探测 223.5.5.5 后', s1);
  if (s1.landSamples < 20) failures.push(`步骤1：内置地图不可见（陆地 ${s1.landSamples}）`);
  if (s1.nodes < 1) failures.push('步骤1：没有拓扑节点');

  /* ---------- 2. 扫描局域网 ---------- */
  console.log('\n================ 步骤 2：扫描局域网 ================');
  await evaluate("document.getElementById('opt-deepscan').checked = false; document.getElementById('btn-lanscan').click(); 'ok'");
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    const st = await evaluate("JSON.stringify({ busy: window.NetScopeApp.state.busy, lan: Boolean(window.NetScopeApp.state.lan) })");
    const p = JSON.parse(st);
    if (p.lan && !p.busy) break;
  }
  await new Promise((r) => setTimeout(r, 1500));
  const s2 = JSON.parse(await evaluate(probeState));
  report('局域网扫描后', s2);
  if (s2.baseMap !== 'builtin') failures.push(`步骤2：扫描局域网后底图应为内置地图，实际 ${s2.baseMap}`);
  if (s2.rendererCanvasId !== 'map-canvas') failures.push(`步骤2：渲染画布错误（${s2.rendererCanvasId}）`);
  if (s2.plain) failures.push('步骤2：仍处于叠加模式（会画到隐藏的叠加层上）');
  if (!s2.lanMode) failures.push('步骤2：未进入局域网星型拓扑模式');
  if (s2.nodes < 2) failures.push(`步骤2：星型拓扑节点不足（${s2.nodes}）`);
  if (s2.arcs < 1) failures.push(`步骤2：星型拓扑连线不足（${s2.arcs}）`);
  if (s2.inkSamples < 20) failures.push(`步骤2：拓扑画布没有内容（着墨 ${s2.inkSamples}）`);

  // 局域网模式下截图
  let shot = await send('Page.captureScreenshot', { format: 'png' });
  const outDir = path.join(__dirname, '..', 'data', 'screenshots');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'lan-after-fix.png'), Buffer.from(shot.data, 'base64'));

  /* ---------- 3. 高德 → 切回内置 ---------- */
  if (KEY && SECURITY) {
    console.log('\n================ 步骤 3：高德 → 切回内置 ================');
    await evaluate(`window.NetScopeAmap.saveLocalCredentials({ key: ${JSON.stringify(KEY)}, security: ${JSON.stringify(SECURITY)}, enabled: true }); 'ok'`);
    await evaluate("document.getElementById('opt-basemap').value = 'amap'; document.getElementById('opt-basemap').dispatchEvent(new Event('change')); 'ok'");
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      if ((await evaluate('window.NetScopeApp.state.baseMap')) === 'amap') break;
    }
    await new Promise((r) => setTimeout(r, 2000));
    const sAmapKeep = JSON.parse(await evaluate(probeState));
    report('高德模式（当前视图为逻辑拓扑，高德应被挂起）', sAmapKeep);
    // 局域网扫描后视图是"逻辑拓扑"，此时切高德必须挂起高德、保持逻辑拓扑
    if (sAmapKeep.plain) failures.push('步骤3：逻辑拓扑视图下切高德不应启用叠加绘制（应挂起）');
    if (sAmapKeep.rendererCanvasId !== 'map-canvas') {
      failures.push(`步骤3：逻辑拓扑视图下应画在内置画布，实际 ${sAmapKeep.rendererCanvasId}`);
    }

    // 显式切到世界地图：此时高德才真正接管
    await evaluate("document.querySelector('[data-view=\\\"map\\\"]').click(); 'ok'");
    await new Promise((r) => setTimeout(r, 2500));
    const sAmap = JSON.parse(await evaluate(probeState));
    report('切到世界地图后的高德模式', sAmap);
    if (!sAmap.plain) failures.push('步骤3：世界地图视图下高德未启用叠加绘制');
    if (sAmap.rendererCanvasId !== 'overlay-canvas') {
      failures.push(`步骤3：世界地图下高德应画在叠加层，实际 ${sAmap.rendererCanvasId}`);
    }

    await evaluate("document.getElementById('opt-basemap').value = 'builtin'; document.getElementById('opt-basemap').dispatchEvent(new Event('change')); 'ok'");
    await new Promise((r) => setTimeout(r, 2500));
    const s3 = JSON.parse(await evaluate(probeState));
    report('切回内置地图后', s3);
    if (s3.plain) failures.push('步骤3：切回后仍处于叠加模式');
    if (s3.rendererCanvasId !== 'map-canvas') failures.push(`步骤3：切回后渲染画布未复原（${s3.rendererCanvasId}）`);
    if (s3.ctxMatches !== true) failures.push('步骤3：渲染上下文与画布不匹配');
    if (s3.overlayHidden !== true) failures.push('步骤3：叠加层未隐藏');
    if (s3.canvasHidden) failures.push('步骤3：内置画布仍被隐藏');
    if (s3.inkSamples < 20) failures.push(`步骤3：切回后画布没有内容（着墨 ${s3.inkSamples}）`);

    // 回到逻辑拓扑，供步骤 4 验证"再次探测后星型模式已退出"
    await evaluate("document.querySelector('[data-view=\\\"graph\\\"]').click(); 'ok'");
    await new Promise((r) => setTimeout(r, 1000));
  } else {
    console.log('\n⊘ 未提供高德凭据，跳过步骤 3');
  }

  /* ---------- 4. 再次探测另一个目标 ---------- */
  console.log('\n================ 步骤 4：再次探测 ================');
  await evaluate("window.NetScopeApp.trace('8.8.8.8')");
  for (let i = 0; i < 80; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    if ((await evaluate('String(window.NetScopeApp.state.busy)')) === 'false') break;
  }
  await new Promise((r) => setTimeout(r, 1200));
  const s4 = JSON.parse(await evaluate(probeState));
  report('再次探测 8.8.8.8 后', s4);
  if (s4.landSamples < 20) failures.push(`步骤4：世界地图不可见（陆地 ${s4.landSamples}）`);
  if (s4.nodes < 2) failures.push(`步骤4：拓扑节点不足（${s4.nodes}）`);
  if (s4.arcs < 1) failures.push(`步骤4：拓扑连线不足（${s4.arcs}）`);
  if (s4.lanMode) failures.push('步骤4：仍标记为局域网模式，星型拓扑未复位');

  shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, 'retrace-after-lan.png'), Buffer.from(shot.data, 'base64'));
  console.log('\n已保存: data/screenshots/lan-after-fix.png, retrace-after-lan.png');

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
  console.log('  ✔ 全流程正常');
  ws.close();
  child.kill();
  process.exit(0);
})().catch((e) => { console.error('验收失败：', e.message); process.exit(1); });
