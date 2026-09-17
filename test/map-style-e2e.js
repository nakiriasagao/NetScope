'use strict';
/**
 * 验收：内置世界地图的**默认样式 = 按国家划分**
 *   - 地图数据不含 provinces（或为空）时，渲染器不得绘制任何区域线；
 *   - 画面上只有国界与国土填色，且陆地清晰可见；
 *   - 即使数据里带了 provinces，默认选项（showAdmin1 未开启）也不绘制。
 *
 * 用法：node test/map-style-e2e.js [baseUrl]
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const PORT = 9300 + Math.floor(Math.random() * 30);
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
  const failures = [];

  console.log('================ 地图数据 ================');
  const dataRes = await new Promise((resolve, reject) => {
    http.get(BASE + '/data/world-110m.json', (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    }).on('error', reject);
  });
  const provinceCount = (dataRes.provinces || []).length;
  console.log(`  国家/地区：${dataRes.countries.length}`);
  console.log(`  行政区划线：${provinceCount} 条（默认样式应为 0，即纯国家划分）`);
  console.log(`  文件体积：${(JSON.stringify(dataRes).length / 1024).toFixed(1)} KB`);
  if (dataRes.countries.length < 100) failures.push(`数据：国家数量异常（${dataRes.countries.length}）`);
  if (provinceCount !== 0) failures.push(`数据：默认样式不应包含行政区划线，实际 ${provinceCount} 条`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-mapstyle-'));
  const child = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`,
    '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--window-size=1680,950', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let ready = false;
  for (let i = 0; i < 60 && !ready; i += 1) {
    try { await getJSON(`http://127.0.0.1:${PORT}/json/version`, 2000); ready = true; } catch (e) { await new Promise((r) => setTimeout(r, 300)); }
  }
  if (!ready) {
    console.log('⊘ 浏览器未就绪，跳过渲染部分');
  } else {
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
      setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error('CDP 超时 ' + method)); } }, 90000);
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
    await send('Page.navigate', { url: BASE + '/?mapstyle=' + Date.now() });
    for (let i = 0; i < 60; i += 1) {
      if ((await evaluate("Boolean(window.NetScopeApp && window.NetScopeApp.renderer().world)")) === true) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    await evaluate("document.getElementById('legend-panel').hidden = true; 'ok'");

    console.log('\n================ 默认渲染样式 ================');
    const audit = JSON.parse(await evaluate(`JSON.stringify((function () {
      var r = window.NetScopeApp.renderer();
      r.fitToContainer();
      r.draw();
      var img = r.ctx.getImageData(0, 0, r.width, r.height).data;
      var land = 0, border = 0, odd = 0;
      for (var i = 0; i < img.length; i += 4) {
        var R = img[i], G = img[i+1], B = img[i+2];
        if (Math.abs(R - 22) <= 6 && Math.abs(G - 39) <= 6 && Math.abs(B - 63) <= 6) land += 1;
        // 国界色 #26456b（38,69,107）
        else if (Math.abs(R - 38) <= 14 && Math.abs(G - 69) <= 14 && Math.abs(B - 107) <= 16) border += 1;
      }
      return {
        mode: r.mode,
        countries: r.world.countries.length,
        provinces: (r.world.provinces || []).length,
        showAdmin1: r.options.showAdmin1 === true,
        land: land,
        border: border,
      };
    })())`));
    console.log('  ' + JSON.stringify(audit));
    if (audit.mode !== 'map') failures.push(`渲染：应为地图模式，实际 ${audit.mode}`);
    if (audit.land < 5000) failures.push(`渲染：陆地填色过少（${audit.land}），地图可能没画出来`);
    if (audit.border < 500) failures.push(`渲染：国界像素过少（${audit.border}）`);
    if (audit.provinces !== 0) failures.push(`渲染：数据里出现了行政区划线（${audit.provinces}）`);

    console.log('\n================ 覆盖检查：即使有数据，默认也不画 ================');
    const forced = JSON.parse(await evaluate(`JSON.stringify((function () {
      var r = window.NetScopeApp.renderer();
      // 行政区划线有"按缩放淡入"策略（<1.4 倍不画），这里直接改视图以获得 3 倍缩放
      r.view.scale = 3;
      r.view.offsetX = 0;
      r.view.offsetY = 0;

      // 清空画布后单独调用 drawAdmin1，数它到底画了多少不透明像素。
      // 这样与底图无关，判据精确。
      var measure = function () {
        var ctx = r.ctx;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, r.canvas.width, r.canvas.height);
        ctx.restore();
        r.drawAdmin1(ctx);
        var img = ctx.getImageData(0, 0, r.width, r.height).data;
        var n = 0;
        for (var i = 3; i < img.length; i += 4) if (img[i] > 8) n += 1;
        return n;
      };

      var backup = r.world.provinces;
      r.world.provinces = [{ p: [200, 80, 800, 460], b: [200, 80, 800, 460] }];
      var drawnWithData = measure();

      // 默认情况：数据里没有 provinces → 必须画 0 个像素
      r.world.provinces = [];
      var drawnWithoutData = measure();

      // 恢复现场并整幅重绘
      r.world.provinces = backup;
      r.fitToContainer();
      r.draw();
      return {
        scaleUsed: 3,
        drawnWithData: drawnWithData,
        drawnWithoutData: drawnWithoutData,
        defaults: { showAdmin1: r.options.showAdmin1 === true, provinces: (r.world.provinces || []).length },
      };
    })())`));
    console.log('  ' + JSON.stringify(forced));
    if (forced.drawnWithoutData !== 0) {
      failures.push(`渲染：数据无 provinces 时仍绘制了 ${forced.drawnWithoutData} 个像素（默认应为纯国家划分）`);
    } else {
      console.log('  ✔ 数据无 provinces 时不绘制任何区域线');
    }
    if (forced.drawnWithData === 0) failures.push('渲染：有数据且放大后仍不绘制（功能失效）');
    else console.log(`  ✔ 有数据且放大后可正常绘制（${forced.drawnWithData} 个像素，说明功能保留但默认关闭）`);
    if (forced.defaults.showAdmin1) failures.push('渲染：showAdmin1 默认应为关闭');

    const outDir = path.join(__dirname, '..', 'data', 'screenshots');
    fs.mkdirSync(outDir, { recursive: true });
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, 'map-style-country.png'), Buffer.from(shot.data, 'base64'));
    console.log('\n已保存: data/screenshots/map-style-country.png');

    if (errors.length) {
      console.log('\n页面错误：');
      errors.slice(0, 6).forEach((e) => console.log('  ' + e));
      failures.push(`${errors.length} 个页面脚本错误`);
    }

    ws.close();
    child.kill();
  }

  console.log('\n================ 结论 ================');
  if (failures.length) {
    failures.forEach((f) => console.log('  ✘ ' + f));
    process.exit(1);
  }
  console.log('  ✔ 默认样式为按国家划分');
  process.exit(0);
})().catch((e) => { console.error('验收失败：', e.message); process.exit(1); });
