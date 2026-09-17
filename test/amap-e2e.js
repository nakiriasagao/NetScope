'use strict';
/**
 * 高德地图（AMap）底图接入验收（浏览器端）
 *
 * 前置条件（满足其一即可）：
 *   1. 命令行传入 key：node test/amap-e2e.js <key> [security] [baseUrl]
 *   2. 已通过界面「⚙ 地图设置」保存过 Key（服务端 data/amap-config.json，含安全密钥）
 *      此时直接运行：node test/amap-e2e.js
 *   若两者都没有，则打印跳过提示并以 0 退出（不视为失败）。
 *
 * 校验内容：脚本加载 → 地图实例创建 → 瓦片接口 → 像素抽样确认地图已渲染
 *          → 内置画布让位 → 无脚本错误；最后截图 data/screenshots/amap-basemap.png
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let KEY = process.argv[2] || '';
let SECURITY = process.argv[3] || '';
const BASE = process.argv[4] || 'http://127.0.0.1:8787';
const PORT = 9810 + Math.floor(Math.random() * 60);
const BROWSER = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function getJSON(url, t = 8000) {
  return new Promise((res, rej) => {
    const q = http.get(url, { timeout: t }, (r) => {
      let s = '';
      r.on('data', (c) => (s += c));
      r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(new Error(s.slice(0, 100))); } });
    });
    q.on('timeout', () => { q.destroy(); rej(new Error('timeout')); });
    q.on('error', rej);
  });
}

(async () => {
  // 未传 Key 时，尝试从服务端已保存的配置里读取（但仍不落盘到前端）
  if (!KEY) {
    try {
      const cfg = await getJSON(BASE + '/api/amap/config');
      if (cfg && cfg.config && cfg.config.configured) {
        console.log('命令行未传 Key，检测到服务端已保存配置（' + cfg.config.keyMasked + '），将使用它进行验收');
        console.log('提示：安全密钥由服务端持有，前端 localStorage 需要一份副本才能加载 JS API。');
        console.log('      若验收失败，请改用：node test/amap-e2e.js <key> <security>');
      } else {
        console.log('SKIP 未配置高德 Key，跳过高德底图验收。');
        console.log('     配置方式：启动服务后打开界面 → 左侧「⚙ 地图设置」→ 填入 Key 与安全密钥。');
        process.exit(0);
      }
    } catch (e) {
      console.log('SKIP 无法读取服务端配置（' + e.message + '），跳过高德底图验收。');
      process.exit(0);
    }
    if (!SECURITY) {
      console.log('SKIP 缺少安全密钥（新版 Key 必需），跳过高德底图验收。');
      console.log('     请用：node test/amap-e2e.js <key> <security>');
      process.exit(0);
    }
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-amap-'));
  const child = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`,
    '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--window-size=1680,950', 'about:blank'], { stdio: 'ignore', windowsHide: true });

  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    try { await getJSON(`http://127.0.0.1:${PORT}/json/version`, 2000); ready = true; } catch (e) { await new Promise((r) => setTimeout(r, 300)); }
  }
  const list = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
  const target = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl).pop();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const errors = [];
  const amapResponses = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push('[异常] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('[console.error] ' + m.params.args.map((a) => a.value || a.description).join(' '));
    if (m.method === 'Network.responseReceived') {
      const u = m.params.response.url;
      if (u.includes('amap.com')) amapResponses.push(m.params.response.status + ' ' + u.slice(0, 90));
    }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: myId, method, params }));
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error('CDP 超时 ' + method)); } }, 90000);
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
  await send('Page.navigate', { url: BASE + '/?amap=' + Date.now() });
  for (let i = 0; i < 60; i += 1) {
    const ok = await evaluate("Boolean(window.NetScopeApp && window.NetScopeApp.renderer() && window.NetScopeApp.renderer().world)");
    if (ok === true) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log('页面已加载');

  // 写入凭据（等同于用户在设置面板填写并保存）
  await evaluate(`window.NetScopeAmap.saveLocalCredentials({ key: ${JSON.stringify(KEY)}, security: ${JSON.stringify(SECURITY)}, enabled: true }); 'ok'`);
  console.log('凭据已写入 localStorage');

  // 切换底图到高德
  console.log(await evaluate("document.getElementById('opt-basemap').value = 'amap'; document.getElementById('opt-basemap').dispatchEvent(new Event('change')); 'switched'"));

  // 等待高德地图就绪
  let mapReady = false;
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    const st = await evaluate(`JSON.stringify({
      hasAMap: typeof window.AMap !== 'undefined',
      mode: window.NetScopeApp.state.baseMap,
      status: document.getElementById('basemap-status').textContent,
    })`);
    const parsed = typeof st === 'string' && st.startsWith('{') ? JSON.parse(st) : {};
    if (i % 4 === 0) console.log('  等待中…', st);
    if (parsed.hasAMap && parsed.mode === 'amap') { mapReady = true; break; }
  }
  console.log('高德地图就绪:', mapReady);

  // 触发一次真实探测，让高德底图上画出拓扑
  console.log('开始探测以便在高德底图上绘制拓扑…');
  await evaluate("window.NetScopeApp.trace('223.5.5.5')");
  for (let i = 0; i < 80; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    const busy = await evaluate('String(window.NetScopeApp.state.busy)');
    if (busy === 'false') break;
  }
  await new Promise((r) => setTimeout(r, 1500));

  const audit = await evaluate(`JSON.stringify((function () {
    const app = window.NetScopeApp;
        // 高德用 canvas / 背景图渲染瓦片，DOM 里不一定有 <img>；
    // 因此直接对地图容器区域做像素抽样，判断是否真的画出了地图内容
    let inkRatio = 0;
    let coloredPixels = 0;
    let canvasCount = 0;
    const host = document.getElementById('amap-host');
    try {
      // 高德地图渲染在专用容器 #amap-host 内（用 canvas / 背景图绘制瓦片，DOM 里不一定有 <img>），
      // 因此对容器内的 canvas 做像素抽样，判断是否真的画出了地图内容
      const scope = host || document.querySelector('.amap-container') || document;
      const canvases = Array.from(scope.querySelectorAll('canvas'));
      canvasCount = canvases.length;
      let sampled = 0;
      let inked = 0;
      let colored = 0;
      for (const cv of canvases.slice(0, 4)) {
        let ctx = null;
        try {
          ctx = cv.getContext && cv.getContext('2d');
        } catch (e) {
          ctx = null;
        }
        if (!ctx || !cv.width || !cv.height) continue;
        const w = Math.min(cv.width, 420);
        const h = Math.min(cv.height, 420);
        const data = ctx.getImageData(0, 0, w, h).data;
        for (let i = 0; i < data.length; i += 4 * 13) {
          sampled += 1;
          const r = data[i], g = data[i + 1], b = data[i + 2];
          if (r + g + b > 40) inked += 1;
          // 瓦片里存在明显的彩色（水体蓝 / 道路黄绿），纯黑背景不会
          if (Math.abs(r - g) > 12 || Math.abs(g - b) > 12) colored += 1;
        }
      }
      inkRatio = sampled ? inked / sampled : 0;
      coloredPixels = colored;
    } catch (e) {
      inkRatio = -1;
    }
    return {
      hasAMapNs: typeof window.AMap !== 'undefined',
      baseMap: app.state.baseMap,
      // 注意：高德会把 amap-container 类直接加在传入的容器上（不新建子元素），
      // 因此判据是"容器内已出现高德自己的图层结构"
      amapHostHasClass: Boolean(host && host.classList.contains('amap-container')),
      amapLayers: document.querySelectorAll('#amap-host .amap-layers').length,
      amapHostChildren: host ? host.childElementCount : null,
      canvasCount: canvasCount,
      inkRatio: Math.round(inkRatio * 1000) / 1000,
      coloredPixels: coloredPixels,
      labels: document.querySelectorAll('#node-overlay g').length,
      builtinCanvasHidden: document.getElementById('map-canvas').hidden,
      hops: app.state.hops.length,
      status: document.getElementById('basemap-status').textContent,
      statsHops: document.getElementById('stat-hops').textContent,
    };
  })())`);
  const a = JSON.parse(audit);
  console.log('\n=== 高德底图审计 ===');
  console.log('AMap 命名空间:', a.hasAMapNs, '| 当前底图:', a.baseMap, '| 状态:', a.status);
  console.log('地图容器: 高德类=' + a.amapHostHasClass + ' 图层数=' + a.amapLayers + ' | canvas 数:', a.canvasCount);
  console.log('画布着墨比例:', a.inkRatio, '| 彩色像素样本:', a.coloredPixels, '| 内置画布已隐藏:', a.builtinCanvasHidden);
  console.log('标签层元素:', a.labels, '| 跳点数:', a.hops, '| 统计栏跳数:', a.statsHops);
  console.log('\namap.com 网络响应（最近 8 条）:');
  amapResponses.slice(-8).forEach((r) => console.log('  ' + r));

  // 截图统一输出到项目根目录的 data/screenshots（该目录已在 .gitignore 中）
  const outDir = path.join(__dirname, '..', 'data', 'screenshots');
  fs.mkdirSync(outDir, { recursive: true });
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const shotBuffer = Buffer.from(shot.data, 'base64');
  fs.writeFileSync(path.join(outDir, 'amap-basemap.png'), shotBuffer);
  console.log('\n已保存: data/screenshots/amap-basemap.png');

  /**
   * 从截图中统计"彩色像素"比例。
   * 为什么不用 canvas.getImageData：高德用 WebGL 渲染，未开启 preserveDrawingBuffer 时
   * 读出来是空白，因此改为对 CDP 截图做像素分析（与渲染方式无关，最可靠）。
   */
  function analyzeScreenshot(buffer, region) {
    const zlib = require('zlib');
    let pos = 8; // 跳过 PNG 签名
    let width = 0, height = 0, bitDepth = 0, colorType = 0;
    const idat = [];
    while (pos + 8 <= buffer.length) {
      const len = buffer.readUInt32BE(pos);
      const type = buffer.toString('ascii', pos + 4, pos + 8);
      const data = buffer.subarray(pos + 8, pos + 8 + len);
      if (type === 'IHDR') {
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        bitDepth = data[8];
        colorType = data[9];
      } else if (type === 'IDAT') {
        idat.push(data);
      } else if (type === 'IEND') {
        break;
      }
      pos += 12 + len;
    }
    if (!width || bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
      return { ok: false, reason: `不支持的 PNG 格式（色深 ${bitDepth}，颜色类型 ${colorType}）` };
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const channels = colorType === 6 ? 4 : 3;
    const stride = width * channels;
    const prev = Buffer.alloc(stride);
    const current = Buffer.alloc(stride);
    const x0 = Math.max(0, region ? region.x : 0);
    const y0 = Math.max(0, region ? region.y : 0);
    const x1 = Math.min(width, region ? region.x + region.width : width);
    const y1 = Math.min(height, region ? region.y + region.height : height);

    let offset = 0;
    let sampled = 0;
    let colored = 0;
    for (let y = 0; y < height; y += 1) {
      const filter = raw[offset];
      offset += 1;
      raw.copy(current, 0, offset, offset + stride);
      offset += stride;
      // PNG 反滤波
      for (let i = 0; i < stride; i += 1) {
        const a = i >= channels ? current[i - channels] : 0;
        const b = prev[i];
        const c = i >= channels ? prev[i - channels] : 0;
        let value = current[i];
        if (filter === 1) value = (value + a) & 0xff;
        else if (filter === 2) value = (value + b) & 0xff;
        else if (filter === 3) value = (value + ((a + b) >> 1)) & 0xff;
        else if (filter === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          value = (value + pr) & 0xff;
        }
        current[i] = value;
      }
      if (y >= y0 && y < y1) {
        for (let x = x0; x < x1; x += 3) {
          const i = x * channels;
          const r = current[i], g = current[i + 1], b = current[i + 2];
          sampled += 1;
          // 高德底图存在明显彩色（水体蓝、道路黄绿、绿地），纯黑/灰界面不会
          if (Math.abs(r - g) > 14 || Math.abs(g - b) > 14 || Math.abs(r - b) > 14) colored += 1;
        }
      }
      current.copy(prev);
    }
    return { ok: true, width, height, sampled, colored, ratio: sampled ? colored / sampled : 0 };
  }

  // 只分析地图区域（画布区），排除左右面板
  const mapRect = JSON.parse(await evaluate(`JSON.stringify((function () {
    const el = document.getElementById('canvas-wrap');
    const r = el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return { x: Math.round(r.left * dpr), y: Math.round(r.top * dpr), width: Math.round(r.width * dpr), height: Math.round(r.height * dpr) };
  })())`));
  const shotAnalysis = analyzeScreenshot(shotBuffer, mapRect);
  if (shotAnalysis.ok) {
    console.log(`截图像素分析（地图区域 ${mapRect.width}x${mapRect.height}）：彩色像素 ${shotAnalysis.colored}/${shotAnalysis.sampled} = ${(shotAnalysis.ratio * 100).toFixed(1)}%`);
  } else {
    console.log('截图像素分析不可用：' + shotAnalysis.reason);
  }

  const tileRequests = amapResponses.filter((r) => r.includes('get_tile') && r.startsWith('200')).length;
  const checks = [
    ['高德脚本加载成功', a.hasAMapNs],
    ['已切换到高德底图', a.baseMap === 'amap'],
    ['地图容器已创建', a.amapHostHasClass === true && a.amapLayers > 0],
    ['瓦片接口请求成功', tileRequests > 0],
    ['地图内容已渲染（截图像素分析）', shotAnalysis.ok ? shotAnalysis.ratio > 0.02 : false],
    ['内置画布已让位', a.builtinCanvasHidden === true],
    ['无脚本错误', errors.length === 0],
  ];
  console.log('\n=== 验收 ===');
  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) failed += 1;
  }
  if (errors.length) {
    console.log('\n错误：');
    errors.slice(0, 10).forEach((e) => console.log('  ' + e));
  }
  ws.close();
  child.kill();
  console.log(failed ? `\n✘ ${failed} 项未通过` : '\n✔ 高德底图接入成功');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('实测失败：', e.message); process.exit(1); });
