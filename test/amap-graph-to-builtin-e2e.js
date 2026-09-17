'use strict';
/**
 * 复现：高德 + 逻辑拓扑 → 切世界地图模式 → 再切内置世界地图 → 世界地图不显示
 *
 * 用法：node test/amap-graph-to-builtin-e2e.js [baseUrl]
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const PORT = 9340 + Math.floor(Math.random() * 30);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-agtb-'));
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
  await send('Page.navigate', { url: BASE + '/?agtb=' + Date.now() });
  for (let i = 0; i < 60; i += 1) {
    if ((await evaluate("Boolean(window.NetScopeApp && window.NetScopeApp.renderer().world)")) === true) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  await evaluate("document.getElementById('legend-panel').hidden = true; 'ok'");

  const snap = `JSON.stringify((function () {
    var app = window.NetScopeApp;
    var r = app.renderer();
    var inner = document.getElementById('map-canvas');
    var ovl = document.getElementById('overlay-canvas');
    var host = document.getElementById('amap-host');
    var vis = function (el) { if (!el) return null; var st = getComputedStyle(el); var b = el.getBoundingClientRect();
      return { hidden: el.hidden, display: st.display, size: [Math.round(b.width), Math.round(b.height)] }; };
    var ink = function (cv) { if (!cv || !cv.width) return -1; try { var g = cv.getContext('2d').getImageData(0,0,Math.min(cv.width,900),Math.min(cv.height,700)).data; var n=0;
      for (var i=0;i<g.length;i+=4*29){ if(g[i]+g[i+1]+g[i+2]+g[i+3]>30) n+=1; } return n; } catch(e){ return -1; } };
    var land = 0;
    try {
      if (r.mode === 'map') {
        var g2 = r.ctx.getImageData(0,0,Math.min(r.width,900),Math.min(r.height,700)).data;
        for (var i2=0;i2<g2.length;i2+=4*29){ if(Math.abs(g2[i2]-22)<=6&&Math.abs(g2[i2+1]-39)<=6&&Math.abs(g2[i2+2]-63)<=6) land+=1; }
      }
    } catch(e) { land = -1; }
    return {
      view: app.state.view, baseMap: app.state.baseMap, mode: r.mode,
      plain: r.plain === true, lanMode: r.lanMode === true,
      canvas: r.canvas ? r.canvas.id : null,
      ctxMatches: r.ctx && r.canvas ? (r.ctx.canvas === r.canvas) : null,
      rendererSize: [r.width, r.height],
      nodes: r.nodes.length, arcs: r.arcs.length,
      labels: document.querySelectorAll('#node-overlay g').length,
      anim: r.animation && r.animation.running === true,
      inner: vis(inner), ovl: vis(ovl), host: vis(host),
      innerInk: ink(inner), ovlInk: ink(ovl), land: land,
    };
  })())`;

  const show = (label, s) => {
    console.log(`\n【${label}】`);
    console.log(`  view=${s.view} baseMap=${s.baseMap} mode=${s.mode} plain=${s.plain} 画布=${s.canvas} 上下文匹配=${s.ctxMatches}`);
    console.log(`  节点=${s.nodes} 连线=${s.arcs} 标签=${s.labels} 动画=${s.anim} 陆地像素=${s.land}`);
    console.log(`  内置画布 ${JSON.stringify(s.inner)} 着墨=${s.innerInk}`);
    console.log(`  叠加画布 ${JSON.stringify(s.ovl)} 着墨=${s.ovlInk}`);
    console.log(`  高德容器 ${JSON.stringify(s.host)}`);
  };

  const failures = [];
  if (!KEY || !SECURITY) {
    console.log('SKIP 未提供高德凭据');
    ws.close(); child.kill(); process.exit(0);
  }
  await evaluate(`window.NetScopeAmap.saveLocalCredentials({ key: ${JSON.stringify(KEY)}, security: ${JSON.stringify(SECURITY)}, enabled: true }); 'ok'`);

  /* ---------- 场景 B：页面加载时保存的底图就是高德（有 300ms 异步初始化）---------- */
  console.log('\n================ 场景 B：重载页面（保存的底图 = 高德）================');
  await evaluate("window.localStorage.setItem('netscope.basemap','amap'); 'ok'");
  await send('Page.navigate', { url: BASE + '/?agtb2=' + Date.now() });
  for (let i = 0; i < 80; i += 1) {
    if ((await evaluate("Boolean(window.NetScopeApp && window.NetScopeApp.renderer().world)")) === true) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  await evaluate("document.getElementById('legend-panel').hidden = true; 'ok'");
  // 等高德异步初始化完成
  let amapReady = false;
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 800));
    if ((await evaluate('window.NetScopeApp.state.baseMap')) === 'amap') { amapReady = true; break; }
  }
  console.log('  高德已初始化: ' + amapReady);

  // 探测 → 逻辑拓扑
  await evaluate("window.NetScopeApp.trace('8.8.8.8')");
  for (let i = 0; i < 80; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    if ((await evaluate('String(window.NetScopeApp.state.busy)')) === 'false') break;
  }
  await new Promise((r) => setTimeout(r, 1200));
  await evaluate("document.querySelector('[data-view=\\\"graph\\\"]').click(); 'ok'");
  await new Promise((r) => setTimeout(r, 2200));
  const b1 = JSON.parse(await evaluate(snap));
  show('B1 高德 + 逻辑拓扑', b1);
  if (b1.mode !== 'graph' || b1.nodes < 2) failures.push('B1：高德逻辑拓扑未正常显示');

  // 切世界地图模式
  await evaluate("document.querySelector('[data-view=\\\"map\\\"]').click(); 'ok'");
  await new Promise((r) => setTimeout(r, 3000));
  const b2 = JSON.parse(await evaluate(snap));
  show('B2 高德 + 世界地图', b2);
  if (b2.canvas !== 'overlay-canvas') failures.push(`B2：应画在叠加层，实际 ${b2.canvas}`);

  // 切内置世界地图 ← 复现点
  await evaluate("document.getElementById('opt-basemap').value = 'builtin'; document.getElementById('opt-basemap').dispatchEvent(new Event('change')); 'ok'");
  await new Promise((r) => setTimeout(r, 3000));
  const b3 = JSON.parse(await evaluate(snap));
  show('B3 内置世界地图（复现点）', b3);
  if (b3.baseMap !== 'builtin') failures.push(`B3：底图应为内置，实际 ${b3.baseMap}`);
  if (b3.mode !== 'map') failures.push(`B3：渲染模式应为 map，实际 ${b3.mode}`);
  if (b3.canvas !== 'map-canvas') failures.push(`B3：渲染目标应为内置画布，实际 ${b3.canvas}`);
  if (b3.inner && (b3.inner.hidden || b3.inner.display === 'none')) failures.push('B3：内置画布处于隐藏状态');
  if (b3.land < 500) failures.push(`B3：世界地图不可见（陆地像素 ${b3.land}）`);

  const outDirEarly = path.join(__dirname, '..', 'data', 'screenshots');
  fs.mkdirSync(outDirEarly, { recursive: true });
  const shotEarly = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDirEarly, 'bug-scenarioB.png'), Buffer.from(shotEarly.data, 'base64'));
  console.log('\n已保存: data/screenshots/bug-scenarioB.png');

  /* ---------- 场景 C：顺序颠倒（先切内置，再切回世界地图模式）---------- */
  console.log('\n================ 场景 C：先切内置 → 再切回世界地图模式 ================');
  await evaluate("document.querySelector('[data-view=\\\"graph\\\"]').click(); 'ok'");
  await new Promise((r) => setTimeout(r, 1500));
  await evaluate("document.getElementById('opt-basemap').value = 'amap'; document.getElementById('opt-basemap').dispatchEvent(new Event('change')); 'ok'");
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    if ((await evaluate('window.NetScopeApp.state.baseMap')) === 'amap') break;
  }
  await new Promise((r) => setTimeout(r, 2000));
  const c1 = JSON.parse(await evaluate(snap));
  show('C1 高德 + 逻辑拓扑', c1);
  // 先切内置（此时仍是逻辑拓扑视图）
  await evaluate("document.getElementById('opt-basemap').value = 'builtin'; document.getElementById('opt-basemap').dispatchEvent(new Event('change')); 'ok'");
  await new Promise((r) => setTimeout(r, 2500));
  const c2 = JSON.parse(await evaluate(snap));
  show('C2 内置 + 逻辑拓扑', c2);
  // 再切回世界地图模式
  await evaluate("document.querySelector('[data-view=\\\"map\\\"]').click(); 'ok'");
  await new Promise((r) => setTimeout(r, 3000));
  const c3 = JSON.parse(await evaluate(snap));
  show('C3 内置 + 世界地图（复现点）', c3);
  if (c3.land < 500) failures.push(`C3：世界地图不可见（陆地像素 ${c3.land}）`);

  /* ---------- 场景 D：高德初始化期间切换底图（竞态）---------- */
  console.log('\n================ 场景 D：高德异步初始化期间切走 ================');
  await evaluate("window.localStorage.setItem('netscope.basemap','amap'); 'ok'");
  await send('Page.navigate', { url: BASE + '/?agtb3=' + Date.now() });
  for (let i = 0; i < 80; i += 1) {
    if ((await evaluate("Boolean(window.NetScopeApp && window.NetScopeApp.renderer().world)")) === true) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  await evaluate("document.getElementById('legend-panel').hidden = true; 'ok'");
  // 立即切回内置（高德的 300ms 延迟初始化还没开始/正在开始）
  await evaluate("var s=document.getElementById('opt-basemap'); s.value='builtin'; s.dispatchEvent(new Event('change')); 'ok'");
  await new Promise((r) => setTimeout(r, 5000));
  const d1 = JSON.parse(await evaluate(snap));
  show('D1 初始化期间切回内置（等 5 秒后）', d1);
  if (d1.baseMap !== 'builtin') failures.push(`D1：底图选择被异步初始化覆盖（实际 ${d1.baseMap}）`);
  if (d1.mode !== 'map') failures.push(`D1：渲染模式应为 map，实际 ${d1.mode}`);
  if (d1.land < 500) failures.push(`D1：世界地图不可见（陆地像素 ${d1.land}）`);
  const shotD = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDirEarly, 'bug-scenarioD.png'), Buffer.from(shotD.data, 'base64'));

  /* 1. 探测 */
  console.log('================ 步骤 1：探测 ================');
  await evaluate("window.NetScopeApp.trace('8.8.8.8')");
  for (let i = 0; i < 80; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    if ((await evaluate('String(window.NetScopeApp.state.busy)')) === 'false') break;
  }
  await new Promise((r) => setTimeout(r, 1200));

  /* 2. 切高德 + 逻辑拓扑 */
  console.log('================ 步骤 2：切高德并进入逻辑拓扑 ================');
  await evaluate("document.getElementById('opt-basemap').value = 'amap'; document.getElementById('opt-basemap').dispatchEvent(new Event('change')); 'ok'");
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    if ((await evaluate('window.NetScopeApp.state.baseMap')) === 'amap') break;
  }
  await new Promise((r) => setTimeout(r, 2000));
  await evaluate("document.querySelector('[data-view=\\\"graph\\\"]').click(); 'ok'");
  await new Promise((r) => setTimeout(r, 2200));
  const s2 = JSON.parse(await evaluate(snap));
  show('高德 + 逻辑拓扑', s2);
  if (s2.mode !== 'graph' || s2.nodes < 2) failures.push('步骤2：高德逻辑拓扑未正常显示');

  /* 3. 切到世界地图模式（此时应恢复高德底图） */
  console.log('\n================ 步骤 3：切到世界地图模式 ================');
  await evaluate("document.querySelector('[data-view=\\\"map\\\"]').click(); 'ok'");
  await new Promise((r) => setTimeout(r, 3000));
  const s3 = JSON.parse(await evaluate(snap));
  show('高德 + 世界地图', s3);
  if (s3.baseMap !== 'amap') failures.push(`步骤3：底图应仍为高德，实际 ${s3.baseMap}`);
  if (s3.canvas !== 'overlay-canvas') failures.push(`步骤3：应画在叠加层，实际 ${s3.canvas}`);

  /* 4. 切到内置世界地图 —— 这里应显示内置世界地图 */
  console.log('\n================ 步骤 4：切到内置世界地图（bug 复现点）================');
  await evaluate("document.getElementById('opt-basemap').value = 'builtin'; document.getElementById('opt-basemap').dispatchEvent(new Event('change')); 'ok'");
  await new Promise((r) => setTimeout(r, 3000));
  const s4 = JSON.parse(await evaluate(snap));
  show('内置世界地图', s4);
  if (s4.baseMap !== 'builtin') failures.push(`步骤4：底图应为内置，实际 ${s4.baseMap}`);
  if (s4.mode !== 'map') failures.push(`步骤4：渲染模式应为 map，实际 ${s4.mode}`);
  if (s4.canvas !== 'map-canvas') failures.push(`步骤4：渲染目标应为内置画布，实际 ${s4.canvas}`);
  if (s4.ctxMatches !== true) failures.push('步骤4：渲染上下文与画布不匹配');
  if (s4.inner && (s4.inner.hidden || s4.inner.display === 'none')) failures.push('步骤4：内置画布处于隐藏状态');
  if (s4.ovl && !s4.ovl.hidden) failures.push('步骤4：叠加层未隐藏');
  if (s4.land < 500) failures.push(`步骤4：世界地图不可见（陆地像素 ${s4.land}）`);
  if (s4.nodes < 1) failures.push('步骤4：拓扑节点丢失');
  if (!s4.anim) failures.push('步骤4：动画被暂停');

  const outDir = path.join(__dirname, '..', 'data', 'screenshots');
  fs.mkdirSync(outDir, { recursive: true });
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, 'bug-amap-graph-to-builtin.png'), Buffer.from(shot.data, 'base64'));
  console.log('\n已保存: data/screenshots/bug-amap-graph-to-builtin.png');

  if (errors.length) {
    console.log('\n页面错误：');
    errors.slice(0, 8).forEach((e) => console.log('  ' + e));
    failures.push(`${errors.length} 个页面脚本错误`);
  }

  console.log('\n================ 结论 ================');
  if (failures.length) {
    failures.forEach((f) => console.log('  ✘ ' + f));
    ws.close(); child.kill(); process.exit(1);
  }
  console.log('  ✔ 全部通过');
  ws.close(); child.kill(); process.exit(0);
})().catch((e) => { console.error('验收失败：', e.message); process.exit(1); });
