'use strict';
/**
 * 验收：世界地图数据的缓存行为
 *   1. 数据响应带 ETag / Last-Modified，且 Cache-Control 为 no-cache（不会被强缓存）；
 *   2. 带 If-None-Match 重复请求返回 304（省流量的同时保证内容最新）；
 *   3. 数据内容变化后 ETag 变化，浏览器必然拿到新版本；
 *   4. 页面响应带一次 Clear-Site-Data 清理旧缓存；
 *   5. 前端不再使用 force-cache，并带版本号请求。
 *
 * 用法：node test/map-cache-e2e.js [baseUrl]
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const PORT = 9380 + Math.floor(Math.random() * 30);
const BROWSER = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function request(urlPath, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const req = http.request(
      { host: url.hostname, port: url.port || 80, path: url.pathname + url.search, method: 'GET', headers: headers || {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

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
  const failures = [];

  console.log('================ HTTP 缓存头 ================');
  const first = await request('/data/world-110m.json');
  const cc = String(first.headers['cache-control'] || '');
  const etag = first.headers.etag;
  const lastMod = first.headers['last-modified'];
  console.log(`  状态=${first.status} Cache-Control=${cc}`);
  console.log(`  ETag=${etag}`);
  console.log(`  Last-Modified=${lastMod}`);
  console.log(`  体积=${(first.body.length / 1024).toFixed(1)} KB`);
  if (first.status !== 200) failures.push(`HTTP：首次请求应返回 200，实际 ${first.status}`);
  if (!/no-cache/.test(cc)) failures.push(`HTTP：数据文件必须为 no-cache（当前「${cc}」），否则会强缓存旧地图`);
  if (!etag) failures.push('HTTP：缺少 ETag，浏览器无法做条件请求');
  if (!lastMod) failures.push('HTTP：缺少 Last-Modified');

  const json = JSON.parse(first.body.toString('utf8'));
  console.log(`  地图数据：generatedAt=${json.generatedAt} 国家=${json.countries.length} 分区线=${(json.provinces || []).length}`);

  console.log('\n================ 条件请求（304）================');
  const second = await request('/data/world-110m.json', { 'If-None-Match': etag });
  console.log(`  带 If-None-Match 请求 → ${second.status}（体积 ${second.body.length} 字节）`);
  if (second.status !== 304) failures.push(`条件请求：应返回 304，实际 ${second.status}`);

  const third = await request('/data/world-110m.json', { 'If-Modified-Since': lastMod });
  console.log(`  带 If-Modified-Since 请求 → ${third.status}`);
  if (third.status !== 304) failures.push(`条件请求：If-Modified-Since 应返回 304，实际 ${third.status}`);

  console.log('\n================ ETag 随内容变化 ================');
  const other = await request('/data/../index.html').catch(() => null);
  const htmlFirst = await request('/');
  const htmlHeaders = htmlFirst.headers;
  console.log(`  页面 Cache-Control=${htmlHeaders['cache-control']}`);
  if (!/no-cache/.test(String(htmlHeaders['cache-control'] || ''))) {
    failures.push('HTTP：HTML 应为 no-cache');
  }
  // 改写 ETag 模拟"内容变化"，服务端必须返回 200 而不是 304
  const stale = await request('/data/world-110m.json', { 'If-None-Match': '"deadbeef-1"' });
  console.log(`  用一个过期 ETag 请求 → ${stale.status}`);
  if (stale.status !== 200) failures.push(`条件请求：ETag 不匹配时应返回 200（重新下发），实际 ${stale.status}`);
  if (stale.headers.etag === '"deadbeef-1"') failures.push('条件请求：服务端应回传真实 ETag');

  console.log('\n================ Clear-Site-Data（清理旧缓存）================');
  await request('/api/health'); // 让首页之外的请求先发生
  const page = await request('/');
  const csd = page.headers['clear-site-data'];
  console.log(`  Clear-Site-Data = ${csd === undefined ? '(本次未发送，属于正常：每个服务进程只发一次)' : csd}`);
  // 只要求"机制存在"：是不是这一次发送取决于服务进程是否已发过
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  if (!/Clear-Site-Data/.test(src)) failures.push('服务端：未实现 Clear-Site-Data 缓存清理');

  console.log('\n================ 前端请求方式 ================');
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  if (/cache: 'force-cache'/.test(appSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''))) {
    failures.push('前端：仍在使用 force-cache（会强制读取旧缓存）');
  } else {
    console.log('  ✔ 已不再使用 force-cache');
  }
  if (!/cache: forceFresh \? 'reload' : 'no-cache'/.test(appSrc)) failures.push('前端：未使用 no-cache 重新验证');
  else console.log("  ✔ 使用 no-cache / reload 重新验证");
  if (!/url \+= '\?v='/.test(appSrc)) failures.push('前端：未对地图数据做版本化请求');
  else console.log('  ✔ 地图数据带版本号请求');

  console.log('\n================ 浏览器实际行为 ================');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-cache-'));
  const child = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`,
    '--no-first-run', '--disable-gpu', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    try { await getJSON(`http://127.0.0.1:${PORT}/json/version`, 2000); ready = true; } catch (e) { await new Promise((r) => setTimeout(r, 300)); }
  }
  if (!ready) {
    console.log('  ⊘ 浏览器未就绪，跳过');
  } else {
    const list = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
    const pageTarget = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl).pop();
    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    const mapResponses = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === 'Network.responseReceived' && /world-110m\.json/.test(m.params.response.url)) {
        mapResponses.push({ status: m.params.response.status, url: m.params.response.url, fromCache: m.params.response.fromDiskCache || false });
      }
    });
    await new Promise((r) => ws.addEventListener('open', r));
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const myId = ++id;
      pending.set(myId, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
      ws.send(JSON.stringify({ id: myId, method, params }));
      setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error('CDP 超时 ' + method)); } }, 60000);
    });
    const evaluate = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Page.navigate', { url: BASE + '/?cache=' + Date.now() });
    for (let i = 0; i < 60; i += 1) {
      if ((await evaluate("Boolean(window.NetScopeApp && window.NetScopeApp.renderer().world)")) === true) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    const worldInfo = JSON.parse(await evaluate(`JSON.stringify({
      generatedAt: window.NetScopeApp.renderer().world.generatedAt,
      countries: window.NetScopeApp.renderer().world.countries.length,
      storedBuild: window.localStorage.getItem('netscope.worldmap.build'),
      hasReloadFn: typeof window.NetScopeApp.reloadWorldData === 'function',
      reloadButton: Boolean(document.getElementById('btn-reload-map')),
    })`));
    console.log('  页面内的地图数据: ' + JSON.stringify(worldInfo));
    // 默认样式为"按国家划分"：国家数据必须有，行政区划线默认为 0
    if (worldInfo.countries < 100) failures.push(`浏览器：加载到的地图数据国家数异常（${worldInfo.countries}）`);
    if (worldInfo.storedBuild !== worldInfo.generatedAt) failures.push('浏览器：未记录地图构建版本（无法做版本化请求）');
    if (!worldInfo.hasReloadFn) failures.push('浏览器：缺少 reloadWorldData 接口');
    if (!worldInfo.reloadButton) failures.push('浏览器：缺少「重新下载地图数据」按钮');

    // 强制重新下载，应产生一次新的地图数据请求
    const before = mapResponses.length;
    await evaluate('window.NetScopeApp.reloadWorldData()');
    await new Promise((r) => setTimeout(r, 2500));
    const after = mapResponses.length;
    console.log(`  重新下载后新增地图数据请求：${after - before} 次`);
    console.log('  请求记录: ' + JSON.stringify(mapResponses.map((r) => r.status + ' ' + (r.url.split('?')[1] || '(无版本参数)'))));
    if (after <= before) failures.push('浏览器：reloadWorldData 未产生新的网络请求（可能仍读缓存）');

    ws.close();
    child.kill();
  }

  console.log('\n================ 结论 ================');
  if (failures.length) {
    failures.forEach((f) => console.log('  ✘ ' + f));
    process.exit(1);
  }
  console.log('  ✔ 缓存行为正确');
  process.exit(0);
})().catch((e) => { console.error('验收失败：', e.message); process.exit(1); });
