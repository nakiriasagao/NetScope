'use strict';
/**
 * 穷举「视图 × 底图」的所有切换组合，找出世界地图不显示的那一条路径。
 *
 * 状态：视图 ∈ {map, graph}，底图 ∈ {builtin, amap}
 * 对每条切换路径都检查：渲染模式、渲染画布、画布可见性、陆地像素、节点数、动画。
 *
 * 用法：node test/basemap-matrix-e2e.js [baseUrl]
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const PORT = 9280 + Math.floor(Math.random() * 30);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-matrix-'));
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
  await send('Page.navigate', { url: BASE + '/?matrix=' + Date.now() });
  for (let i = 0; i < 60; i += 1) {
    if ((await evaluate("Boolean(window.NetScopeApp && window.NetScopeApp.renderer().world)")) === true) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  await evaluate("document.getElementById('legend-panel').hidden = true; window.localStorage.setItem('netscope.basemap','builtin'); 'ok'");

  const snap = `JSON.stringify((function () {
    var app = window.NetScopeApp;
    var r = app.renderer();
    var cv = r.canvas;
    var ovlCv = document.getElementById('overlay-canvas');
    var host = document.getElementById('amap-host');
    var st = cv ? getComputedStyle(cv) : null;
    var box = cv ? cv.getBoundingClientRect() : { width: 0, height: 0 };
    var land = 0;
    try {
      if (r.mode === 'map' && cv && cv.width) {
        var g = r.ctx.getImageData(0, 0, Math.min(r.width, 900), Math.min(r.height, 700)).data;
        for (var i = 0; i < g.length; i += 4 * 29) {
          if (Math.abs(g[i] - 22) <= 6 && Math.abs(g[i+1] - 39) <= 6 && Math.abs(g[i+2] - 63) <= 6) land += 1;
        }
      }
    } catch (e) { land = -1; }
    var amapInk = -1;
    try {
      if (ovlCv && ovlCv.width) {
        var g2 = ovlCv.getContext('2d').getImageData(0, 0, Math.min(ovlCv.width, 900), Math.min(ovlCv.height, 700)).data;
        amapInk = 0;
        for (var j = 0; j < g2.length; j += 4 * 29) if (g2[j] + g2[j+1] + g2[j+2] + g2[j+3] > 30) amapInk += 1;
      }
    } catch (e) { amapInk = -1; }
    return {
      view: app.state.view, baseMap: app.state.baseMap, mode: r.mode, plain: r.plain === true,
      canvas: cv ? cv.id : null,
      canvasHidden: cv ? cv.hidden === true : null,
      canvasDisplay: st ? st.display : null,
      canvasSize: [Math.round(box.width), Math.round(box.height)],
      hostHidden: host ? host.hidden === true : null,
      ovlHidden: ovlCv ? ovlCv.hidden === true : null,
      nodes: r.nodes.length, arcs: r.arcs.length,
      labels: document.querySelectorAll('#node-overlay g').length,
      anim: r.animation && r.animation.running === true,
      land: land, amapInk: amapInk,
      selectValue: document.getElementById('opt-basemap').value,
    };
  })())`;

  const failures = [];
  const results = [];

  /** 一次检查：期望视图 + 期望底图；地图视图必须能看到陆地或高德内容 */
  async function check(label, expect) {
    const s = JSON.parse(await evaluate(snap));
    const problems = [];
    if (expect.view && s.view !== expect.view) problems.push(`view=${s.view}≠${expect.view}`);
    if (expect.baseMap && s.baseMap !== expect.baseMap) problems.push(`baseMap=${s.baseMap}≠${expect.baseMap}`);
    if (expect.canvas && s.canvas !== expect.canvas) problems.push(`canvas=${s.canvas}≠${expect.canvas}`);
    if (expect.mode && s.mode !== expect.mode) problems.push(`mode=${s.mode}≠${expect.mode}`);
    if (expect.visible !== false) {
      if (s.canvasHidden || s.canvasDisplay === 'none') problems.push('画布被隐藏');
      if (s.canvasSize[0] < 50 || s.canvasSize[1] < 50) problems.push(`画布尺寸异常 ${JSON.stringify(s.canvasSize)}`);
    }
    if (expect.land === true && s.land < 500) problems.push(`陆地像素过少 ${s.land}`);
    if (expect.amap === true && s.amapInk < 50) problems.push(`高德叠加层内容过少 ${s.amapInk}`);
    if (expect.nodes && s.nodes < expect.nodes) problems.push(`节点过少 ${s.nodes}`);
    if (expect.anim && !s.anim) problems.push('动画停止');
    if (s.selectValue !== s.baseMap) problems.push(`下拉框(${s.selectValue})与状态(${s.baseMap})不一致`);

    const ok = problems.length === 0;
    results.push({ label, ok, s, problems });
    console.log(`${ok ? '✔' : '✘'} ${label}`);
    console.log(`    view=${s.view} baseMap=${s.baseMap} mode=${s.mode} canvas=${s.canvas} 陆地=${s.land} 高德着墨=${s.amapInk} 节点=${s.nodes} 动画=${s.anim}`);
    if (!ok) {
      console.log('    → ' + problems.join('；'));
      failures.push(`${label}：${problems.join('；')}`);
    }
    return s;
  }

  const setView = async (v) => { await evaluate(`document.querySelector('[data-view="${v}"]').click(); 'ok'`); await new Promise((r) => setTimeout(r, 2200)); };
  const setBase = async (b) => {
    await evaluate(`(function(){var s=document.getElementById('opt-basemap'); s.value='${b}'; s.dispatchEvent(new Event('change'));})()`);
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 800));
      if ((await evaluate('window.NetScopeApp.state.baseMap')) === b) break;
    }
    await new Promise((r) => setTimeout(r, 1800));
  };

  if (!KEY || !SECURITY) {
    console.log('SKIP 未提供高德凭据');
    ws.close(); child.kill(); process.exit(0);
  }
  await evaluate(`window.NetScopeAmap.saveLocalCredentials({ key: ${JSON.stringify(KEY)}, security: ${JSON.stringify(SECURITY)}, enabled: true }); 'ok'`);

  console.log('================ 探测 ================');
  await evaluate("window.NetScopeApp.trace('8.8.8.8')");
  for (let i = 0; i < 80; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    if ((await evaluate('String(window.NetScopeApp.state.busy)')) === 'false') break;
  }
  await new Promise((r) => setTimeout(r, 1200));

  console.log('\n================ 组合 1：内置地图 → 逻辑拓扑 → 高德 → 世界地图 → 内置 ================');
  await setBase('builtin');
  await setView('graph');
  await check('1.1 内置 + 逻辑拓扑', { view: 'graph', baseMap: 'builtin', mode: 'graph', visible: false, nodes: 2 });
  await setBase('amap');
  await check('1.2 逻辑拓扑下切高德（应挂起）', { view: 'graph', baseMap: 'amap', mode: 'graph', canvas: 'map-canvas', nodes: 2, anim: true });
  await setView('map');
  await check('1.3 切世界地图（高德接管）', { view: 'map', baseMap: 'amap', mode: 'map', canvas: 'overlay-canvas', amap: true, anim: true });
  await setBase('builtin');
  await check('1.4 切内置世界地图 ★', { view: 'map', baseMap: 'builtin', mode: 'map', canvas: 'map-canvas', land: true, nodes: 2, anim: true });

  console.log('\n================ 组合 2：内置地图 → 高德 → 逻辑拓扑 → 世界地图 → 内置 ================');
  await setBase('amap');
  await check('2.1 内置切高德（世界地图）', { view: 'map', baseMap: 'amap', mode: 'map', canvas: 'overlay-canvas', amap: true });
  await setView('graph');
  await check('2.2 切逻辑拓扑（挂起高德）', { view: 'graph', baseMap: 'amap', mode: 'graph', canvas: 'map-canvas', nodes: 2, anim: true });
  await setView('map');
  await check('2.3 切世界地图（恢复高德）', { view: 'map', baseMap: 'amap', mode: 'map', canvas: 'overlay-canvas', amap: true });
  await setBase('builtin');
  await check('2.4 切内置世界地图 ★', { view: 'map', baseMap: 'builtin', mode: 'map', canvas: 'map-canvas', land: true, anim: true });

  console.log('\n================ 组合 3：内置 + 逻辑拓扑 → 高德 → 内置 → 世界地图 ================');
  await setView('graph');
  await check('3.1 内置 + 逻辑拓扑', { view: 'graph', baseMap: 'builtin', mode: 'graph', nodes: 2 });
  await setBase('amap');
  await check('3.2 逻辑拓扑下切高德', { view: 'graph', baseMap: 'amap', mode: 'graph', canvas: 'map-canvas' });
  await setBase('builtin');
  await check('3.3 逻辑拓扑下切回内置', { view: 'graph', baseMap: 'builtin', mode: 'graph', canvas: 'map-canvas', nodes: 2 });
  await setView('map');
  await check('3.4 切世界地图 ★', { view: 'map', baseMap: 'builtin', mode: 'map', canvas: 'map-canvas', land: true, anim: true });

  console.log('\n================ 组合 4：世界地图 ⇄ 逻辑拓扑（底图固定内置）多次往返 ================');
  for (let round = 1; round <= 2; round += 1) {
    await setView('graph');
    await check(`4.${round}a 逻辑拓扑（第 ${round} 轮）`, { view: 'graph', mode: 'graph', nodes: 2, anim: true });
    await setView('map');
    await check(`4.${round}b 世界地图（第 ${round} 轮）`, { view: 'map', mode: 'map', canvas: 'map-canvas', land: true, anim: true });
  }

  console.log('\n================ 组合 5：高德 + 世界地图 ⇄ 逻辑拓扑 多次往返 ================');
  await setBase('amap');
  for (let round = 1; round <= 2; round += 1) {
    await setView('graph');
    await check(`5.${round}a 高德切逻辑拓扑（第 ${round} 轮）`, { view: 'graph', baseMap: 'amap', mode: 'graph', canvas: 'map-canvas', nodes: 2 });
    await setView('map');
    await check(`5.${round}b 切回世界地图（第 ${round} 轮）`, { view: 'map', baseMap: 'amap', mode: 'map', canvas: 'overlay-canvas', amap: true });
  }
  await setBase('builtin');
  await check('5.3 最后切内置世界地图 ★', { view: 'map', baseMap: 'builtin', mode: 'map', canvas: 'map-canvas', land: true, anim: true });

  const outDir = path.join(__dirname, '..', 'data', 'screenshots');
  fs.mkdirSync(outDir, { recursive: true });
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, 'matrix-final.png'), Buffer.from(shot.data, 'base64'));

  if (errors.length) {
    console.log('\n页面错误：');
    errors.slice(0, 8).forEach((e) => console.log('  ' + e));
    failures.push(`${errors.length} 个页面脚本错误`);
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n已保存: data/screenshots/matrix-final.png`);
  console.log(`\n================ 结论（${passed}/${results.length} 通过）================`);
  if (failures.length) {
    failures.forEach((f) => console.log('  ✘ ' + f));
    ws.close(); child.kill(); process.exit(1);
  }
  console.log('  ✔ 所有组合均正常');
  ws.close(); child.kill(); process.exit(0);
})().catch((e) => { console.error('验收失败：', e.message); process.exit(1); });
