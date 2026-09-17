'use strict';
/**
 * 验收：内置世界地图的「国家内地区划分」（admin-1 边界）
 *   - 数据里 provinces 已就绪，渲染器已启用
 *   - 绘制后画布上确实出现分区线像素（开关关闭时消失）
 *   - 缩放后仍正常（视口裁剪生效，不卡顿）
 *
 * 用法：node test/admin1-map-e2e.js [baseUrl]
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const PORT = 9420 + Math.floor(Math.random() * 30);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-admin1-'));
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
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 950, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: BASE + '/?admin1=' + Date.now() });
  for (let i = 0; i < 60; i += 1) {
    if ((await evaluate("Boolean(window.NetScopeApp && window.NetScopeApp.renderer().world)")) === true) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  await evaluate("document.getElementById('legend-panel').hidden = true; 'ok'");

  const failures = [];

  console.log('================ 数据与开关 ================');
  const info = JSON.parse(await evaluate(`JSON.stringify((function () {
    var w = window.NetScopeApp.renderer().world;
    return {
      hasProvinces: Array.isArray(w.provinces),
      provinceCount: (w.provinces || []).length,
      withBbox: (w.provinces || []).filter(function (p) { return p && Array.isArray(p.b) && Array.isArray(p.p); }).length,
      vertices: (w.provinces || []).reduce(function (a, p) { return a + (p.p ? p.p.length / 2 : 0); }, 0),
      showAdmin1Default: window.NetScopeApp.renderer().options.showAdmin1 !== false,
      checkbox: Boolean(document.getElementById('opt-show-admin1')),
      checkboxChecked: document.getElementById('opt-show-admin1') ? document.getElementById('opt-show-admin1').checked : null,
    };
  })())`));
  console.log('  ' + JSON.stringify(info));
  if (!info.hasProvinces || info.provinceCount < 50) failures.push(`数据：provinces 缺失或过少（${info.provinceCount}）`);
  if (info.withBbox !== info.provinceCount) failures.push('数据：部分分区线缺少包围盒（无法视口裁剪）');
  if (!info.checkbox) failures.push('界面：缺少「显示国家内地区划分」开关');
  if (info.checkboxChecked !== true) failures.push('界面：该开关默认应为开启');

  // 统计分区线颜色像素（config 里的 admin1 颜色是 rgba(96,141,196,0.34)，
  // 叠加在国土色 #16273f 上会得到偏蓝的中间色，用"比国土更亮的蓝"来判定）
  const countAdmin1Pixels = `(function () {
    var r = window.NetScopeApp.renderer();
    var img = r.ctx.getImageData(0, 0, r.width, r.height).data;
    var n = 0;
    for (var i = 0; i < img.length; i += 4) {
      var R = img[i], G = img[i+1], B = img[i+2];
      // 国土基色约 (22,39,63)；分区线会把像素抬亮到 40~90 区间且 B 明显高于 R
      if (R >= 38 && R <= 95 && G >= 55 && G <= 115 && B >= 85 && B <= 150 && B - R >= 30) n += 1;
    }
    return n;
  })()`;

  // 精确验证：清空画布后只调用 drawAdmin1，数它画了多少像素。
  // 这样不受国界 / 海岸线抗锯齿影响，判定更可靠。
  const measureAdmin1Only = `(function () {
    var r = window.NetScopeApp.renderer();
    var ctx = r.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, r.canvas.width, r.canvas.height);
    ctx.restore();
    r.drawAdmin1(ctx);
    var img = ctx.getImageData(0, 0, r.width, r.height).data;
    var n = 0;
    for (var i = 3; i < img.length; i += 4) { if (img[i] > 8) n += 1; }
    // 顺便测一下单次绘制耗时
    var t0 = performance.now();
    for (var k = 0; k < 10; k += 1) r.drawAdmin1(ctx);
    var perCall = (performance.now() - t0) / 10;
    return JSON.stringify({ painted: n, perCallMs: Math.round(perCall * 1000) / 1000, scale: Math.round(r.view.scale * 100) / 100 });
  })()`;

  /** 把视图定位到指定经纬度并按倍数放大（用渲染器自己的视图变换） */
  const zoomToLonLat = (lon, lat, target) => `(function () {
    var r = window.NetScopeApp.renderer();
    r.fitToContainer();
    var p = r.project(${lon}, ${lat});
    var guard = 0;
    while (r.view.scale < ${target} && guard < 80) {
      var sx = p.x * r.view.scale + r.view.offsetX;
      var sy = p.y * r.view.scale + r.view.offsetY;
      r.zoomAt(sx, sy, 1.3);
      guard += 1;
    }
    r.draw();
    return JSON.stringify({ scale: Math.round(r.view.scale * 100) / 100 });
  })()`;

  console.log('\n================ 分区线单独绘制（放大到内陆地区）================');
  // 定位到中国中部（内陆，省界密集），放大到 ~6 倍
  console.log('  ' + await evaluate(zoomToLonLat(103, 34, 6)));
  const zoomed = JSON.parse(await evaluate(measureAdmin1Only));
  console.log('  放大后: ' + JSON.stringify(zoomed));
  if (zoomed.painted < 300) failures.push(`渲染：放大后分区线像素过少（${zoomed.painted}）`);
  if (zoomed.perCallMs > 12) failures.push(`性能：分区线单次绘制过慢（${zoomed.perCallMs} ms）`);

  console.log('\n================ 缩放淡入（全球视图不应绘制分区线）================');
  const globalMeasure = JSON.parse(await evaluate(`(function () {
    var r = window.NetScopeApp.renderer();
    r.fitToContainer();
    return ${JSON.stringify('PLACEHOLDER')};
  })()` .replace('"PLACEHOLDER"', measureAdmin1Only)));
  console.log('  全球视图: ' + JSON.stringify(globalMeasure));
  if (globalMeasure.scale < 1.4 && globalMeasure.painted > 50) {
    failures.push(`层级：全球视图不应绘制分区线（像素 ${globalMeasure.painted}）`);
  }

  console.log('\n================ 开关关闭时不绘制 ================');
  await evaluate("document.getElementById('opt-show-admin1').checked = false; document.getElementById('opt-show-admin1').dispatchEvent(new Event('change')); 'ok'");
  await new Promise((r) => setTimeout(r, 500));
  const afterOff = JSON.parse(await evaluate(`(function () {
    var r = window.NetScopeApp.renderer();
    return JSON.stringify({ showAdmin1: r.options.showAdmin1 !== false });
  })()`));
  console.log('  ' + JSON.stringify(afterOff));
  if (afterOff.showAdmin1) failures.push('开关：关闭后 renderer.options.showAdmin1 仍为 true');
  await evaluate("document.getElementById('opt-show-admin1').checked = true; document.getElementById('opt-show-admin1').dispatchEvent(new Event('change')); 'ok'");
  await new Promise((r) => setTimeout(r, 400));
  await evaluate(zoomToLonLat(103, 34, 6));
  const restored = JSON.parse(await evaluate(measureAdmin1Only));
  console.log('  重新开启后: ' + JSON.stringify(restored));
  if (restored.painted < 300) failures.push('开关：重新开启后分区线未恢复');

  console.log('\n================ 缩放后仍正常 ================');
  const zoomPerf = JSON.parse(await evaluate(`(async function () {
    var r = window.NetScopeApp.renderer();
    // 放大到 8 倍，检查渲染耗时（视口裁剪应让耗时保持很低）
    var guard = 0;
    while (r.view.scale < 8 && guard < 60) { r.zoomAt(r.width / 2, r.height / 2, 1.3); guard += 1; }
    var t0 = performance.now();
    for (var i = 0; i < 10; i += 1) r.draw();
    var perDraw = (performance.now() - t0) / 10;
    var pixels = ${countAdmin1Pixels};
    return JSON.stringify({ perDrawMs: Math.round(perDraw * 100) / 100, pixels: pixels, scale: Math.round(r.view.scale * 100) / 100 });
  })()`));
  console.log('  ' + JSON.stringify(zoomPerf));
  if (zoomPerf.scale < 4) failures.push(`缩放：未能放大（scale=${zoomPerf.scale}）`);
  if (zoomPerf.perDrawMs > 25) failures.push(`性能：放大后单帧绘制过慢（${zoomPerf.perDrawMs} ms）`);
  if (zoomPerf.pixels < 200) failures.push(`渲染：放大后分区线消失（像素 ${zoomPerf.pixels}）`);

  const outDir = path.join(__dirname, '..', 'data', 'screenshots');
  fs.mkdirSync(outDir, { recursive: true });
  // 复位到全球视图再截一张
  await evaluate("window.NetScopeApp.renderer().fitToContainer(); window.NetScopeApp.renderer().draw(); 'ok'");
  await new Promise((r) => setTimeout(r, 400));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, 'admin1-map.png'), Buffer.from(shot.data, 'base64'));
  console.log('\n已保存: data/screenshots/admin1-map.png');

  // 放大到中国附近再截一张，便于肉眼确认
  await evaluate(`(function () {
    var r = window.NetScopeApp.renderer();
    r.fitToContainer();
    var p = r.project(105, 35);
    var target = 7;
    while (r.view.scale < target) r.zoomAt(p.x * r.view.scale + r.view.offsetX, p.y * r.view.scale + r.view.offsetY, 1.35);
    r.draw();
    return 'ok';
  })()`);
  await new Promise((r) => setTimeout(r, 500));
  const shot2 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, 'admin1-map-zoom.png'), Buffer.from(shot2.data, 'base64'));
  console.log('已保存: data/screenshots/admin1-map-zoom.png');

  if (errors.length) {
    console.log('\n页面错误：');
    errors.slice(0, 6).forEach((e) => console.log('  ' + e));
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
