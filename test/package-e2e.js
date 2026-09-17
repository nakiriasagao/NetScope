'use strict';
/**
 * 打包产物验收（可执行文件 + APK）
 *
 * 会实际启动打包好的 exe，检查它能否独立提供前端与 API；
 * 并校验 APK 的清单、权限、签名与体积。
 *
 * 前置：先执行
 *   node tools/build-exe.js
 *   node tools/build-apk.js
 * 缺少产物时会明确提示而不是报一堆无关错误。
 *
 * 用法：node test/package-e2e.js
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'dist', 'netscope.exe');
const APK = path.join(ROOT, 'dist', 'android', 'netscope-1.1.0.apk');
const PORT = 8911;

const failures = [];
const ok = (label, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`);
  if (!cond) failures.push(label + (detail ? '（' + detail + '）' : ''));
};

function request(port, urlPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'GET', timeout: timeoutMs || 8000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
      },
    );
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  console.log('==================== 打包产物验收 ====================');

  /* ---------------- 1. Windows 可执行文件 ---------------- */
  console.log('\n--- Windows 可执行文件 ---');
  if (!fs.existsSync(EXE)) {
    ok('可执行文件存在', false, '未找到 dist/netscope.exe，请先运行 node tools/build-exe.js');
  } else {
    const exeSize = fs.statSync(EXE).size;
    ok('可执行文件存在', true, (exeSize / 1024 / 1024).toFixed(1) + ' MB');

    // 同级的 public/ 是运行所必需的
    const publicDir = path.join(ROOT, 'dist', 'public');
    const indexHtml = path.join(publicDir, 'index.html');
    ok('随附 public/index.html', fs.existsSync(indexHtml));

    // 真正启动一次，验证「自带运行时 + 能提供前端与 API」
    const child = spawn(EXE, ['--port', String(PORT), '--no-open'], {
      cwd: path.join(ROOT, 'dist'),
      stdio: 'ignore',
      windowsHide: true,
    });
    let started = false;
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const res = await request(PORT, '/api/health', 3000);
        if (res.status === 200) { started = true; break; }
      } catch (_) {
        /* 还没起来 */
      }
    }
    ok('可执行文件能独立启动', started, started ? `监听 ${PORT}` : '启动超时');

    if (started) {
      const checks = [
        ['/api/health', 200, 'JSON 接口'],
        ['/', 200, '首页'],
        ['/js/app.js', 200, '前端脚本'],
        ['/css/style.css', 200, '样式'],
        ['/data/world-110m.json', 200, '地图数据'],
        ['/js/runtime-config.js', 200, '运行时配置'],
      ];
      for (const [urlPath, expect, label] of checks) {
        try {
          const res = await request(PORT, urlPath);
          ok(`exe 提供 ${label}`, res.status === expect && res.body.length > 0,
            `${urlPath} → HTTP ${res.status}（${res.body.length}B）`);
        } catch (error) {
          ok(`exe 提供 ${label}`, false, error.message);
        }
      }
      // 真实探测一次，确认核心功能在打包环境下可用
      try {
        const body = JSON.stringify({ target: '223.5.5.5', maxHops: 6, queries: 2, timeoutMs: 700 });
        const res = await new Promise((resolve, reject) => {
          const req = http.request({
            host: '127.0.0.1', port: PORT, path: '/api/trace', method: 'POST', timeout: 90000,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          }, (r) => {
            const chunks = [];
            r.on('data', (c) => chunks.push(c));
            r.on('end', () => resolve({ status: r.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
          });
          req.on('error', reject);
          req.on('timeout', () => req.destroy(new Error('探测超时')));
          req.write(body);
          req.end();
        });
        let parsed = null;
        try { parsed = JSON.parse(res.text); } catch (_) { parsed = null; }
        const hops = parsed && parsed.trace && parsed.trace.hops ? parsed.trace.hops.length : 0;
        ok('exe 内路由追踪可用', res.status === 200 && hops > 0, `HTTP ${res.status}，${hops} 跳`);
      } catch (error) {
        ok('exe 内路由追踪可用', false, error.message);
      }
    }

    try { child.kill(); } catch (_) { /* ignore */ }
    // 兜底：确保端口释放
    await new Promise((r) => setTimeout(r, 600));
    const killer = spawnSync('powershell.exe', ['-NoProfile', '-Command',
      `$p=Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue; if($p){ foreach($id in ($p|Select-Object -ExpandProperty OwningProcess -Unique)){ Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } }`],
      { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    void killer;
  }

  /* ---------------- 2. Android APK ---------------- */
  console.log('\n--- Android APK ---');
  if (!fs.existsSync(APK)) {
    ok('APK 存在', false, '未找到 dist/android/netscope-1.0.0.apk，请先运行 node tools/build-apk.js');
  } else {
    const apkSize = fs.statSync(APK).size;
    ok('APK 存在', true, (apkSize / 1024).toFixed(0) + ' KB');
    ok('APK 体积合理（< 5 MB）', apkSize < 5 * 1024 * 1024);

    // 自行解析 ZIP 目录，确认关键条目
    const buf = fs.readFileSync(APK);
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i -= 1) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    const entries = [];
    if (eocd >= 0) {
      const count = buf.readUInt16LE(eocd + 10);
      let off = buf.readUInt32LE(eocd + 16);
      for (let n = 0; n < count; n += 1) {
        if (buf.readUInt32LE(off) !== 0x02014b50) break;
        const nameLen = buf.readUInt16LE(off + 28);
        const extraLen = buf.readUInt16LE(off + 30);
        const commentLen = buf.readUInt16LE(off + 32);
        entries.push(buf.toString('utf8', off + 46, off + 46 + nameLen));
        off += 46 + nameLen + extraLen + commentLen;
      }
    }
    const has = (suffix) => entries.some((e) => e === suffix || e.endsWith('/' + suffix));
    ok('APK 含 AndroidManifest.xml', has('AndroidManifest.xml'));
    ok('APK 含 classes.dex', has('classes.dex'));
    ok('APK 含 resources.arsc', has('resources.arsc'));
    // 独立运行版的关键：前端资源必须打进 APK（assets/web/），否则 WebView 没有界面
    const assetEntries = entries.filter((e) => /assets[\\/]web[\\/]/.test(e));
    ok('APK 内含前端资源 assets/web/', assetEntries.length > 0, assetEntries.length + ' 项');
    ok('APK 内含 assets/web/index.html',
      entries.some((e) => /assets[\\/]web[\\/]index\.html$/.test(e)));
    ok('APK 内含地图数据',
      entries.some((e) => /assets[\\/]web[\\/]data[\\/]world-110m\.json$/.test(e)));
    ok('APK 已签名（META-INF 签名文件）', entries.some((e) => /^META-INF\/.*\.(RSA|DSA|EC)$/i.test(e)),
      entries.filter((e) => e.startsWith('META-INF/')).join(', ') || '无');

    // 对齐检查
    const zipalign = path.join(ROOT, 'build', 'android-sdk', 'android-14', 'zipalign.exe');
    if (fs.existsSync(zipalign)) {
      const res = spawnSync(zipalign, ['-c', '-v', '4', APK], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
      ok('APK 已 4 字节对齐', res.status === 0, (res.stdout || res.stderr || '').split('\n').filter(Boolean).slice(-1)[0] || '');
    } else {
      console.log('SKIP  zipalign 检查（未找到工具）');
    }

    // 签名校验
    const apksigner = path.join(ROOT, 'build', 'android-sdk', 'android-14', 'apksigner.bat');
    if (fs.existsSync(apksigner)) {
      const quote = (a) => (/[\s&()^|<>]/.test(a) ? `"${a}"` : a);
      const res = spawnSync([apksigner, 'verify', '--print-certs', APK].map(quote).join(' '),
        { encoding: 'utf8', windowsHide: true, shell: true, timeout: 120000 });
      const out = (res.stdout || '') + (res.stderr || '');
      ok('APK 签名校验通过', res.status === 0, out.split('\n').filter((l) => /certificate DN/i.test(l)).slice(0, 1).join('') || '');
    } else {
      console.log('SKIP  签名校验（未找到 apksigner）');
    }

    // 清单内容（用 aapt2 dump，存在才做）
    const aapt2 = path.join(ROOT, 'build', 'android-sdk', 'android-14', 'aapt2.exe');
    if (fs.existsSync(aapt2)) {
      const res = spawnSync(aapt2, ['dump', 'badging', APK], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
      const text = res.stdout || '';
      ok('包名为 com.netscope.app', /package: name='com\.netscope\.app'/.test(text));
      ok('声明 INTERNET 权限', /android\.permission\.INTERNET/.test(text));
      ok('最低系统 API 21', /sdkVersion:'21'/.test(text));
      ok('存在可启动 Activity', /launchable-activity: name='com\.netscope\.app\.MainActivity'/.test(text));
      ok('未申请敏感权限', !/permission\.(ACCESS_FINE_LOCATION|ACCESS_COARSE_LOCATION|READ_PHONE_STATE|READ_CONTACTS|CAMERA|RECORD_AUDIO|READ_EXTERNAL_STORAGE)/.test(text),
        '仅网络相关权限');
    } else {
      console.log('SKIP  清单检查（未找到 aapt2）');
    }

    // classes.dex 里应含我们的类
    if (has('classes.dex')) {
      let off = -1;
      const localHeader = buf.indexOf('PK\x03\x04', 0);
      void localHeader;
      // 简化处理：直接搜索 dex 中的字符串常量（类名以明文存在于 dex 中）
      const text = buf.toString('latin1');
      const dexOffset = text.indexOf('classes.dex');
      void dexOffset;
      // dex 内部字符串为 UTF-8，可能被 4 字节对齐拆分，改为解压后检索
      try {
        const nameOffset = text.indexOf('classes.dex');
        let found = false;
        // 用中央目录里的本地头偏移解压
        if (eocd >= 0) {
          const count = buf.readUInt16LE(eocd + 10);
          let o = buf.readUInt32LE(eocd + 16);
          for (let n = 0; n < count; n += 1) {
            if (buf.readUInt32LE(o) !== 0x02014b50) break;
            const method = buf.readUInt16LE(o + 10);
            const compSize = buf.readUInt32LE(o + 20);
            const nameLen = buf.readUInt16LE(o + 28);
            const extraLen = buf.readUInt16LE(o + 30);
            const commentLen = buf.readUInt16LE(o + 32);
            const localOff = buf.readUInt32LE(o + 42);
            const entryName = buf.toString('utf8', o + 46, o + 46 + nameLen);
            if (entryName === 'classes.dex') {
              const lNameLen = buf.readUInt16LE(localOff + 26);
              const lExtraLen = buf.readUInt16LE(localOff + 28);
              const start = localOff + 30 + lNameLen + lExtraLen;
              const raw = buf.subarray(start, start + compSize);
              const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
              const dexText = data.toString('latin1');
              found = dexText.includes('MainActivity')
                      && dexText.includes('NetHttpd')
                      && dexText.includes('NetApi')
                      && dexText.includes('Probe');
              break;
            }
            o += 46 + nameLen + extraLen + commentLen;
          }
        }
        ok('classes.dex 含独立后端与界面类（MainActivity/NetHttpd/NetApi/Probe）', found);
        void nameOffset;
      } catch (error) {
        ok('classes.dex 含独立后端与界面类（MainActivity/NetHttpd/NetApi/Probe）', false, error.message);
      }
    }
  }

  console.log('\n==================== 结论 ====================');
  if (failures.length) {
    failures.forEach((f) => console.log('  ✘ ' + f));
    process.exit(1);
  }
  console.log('  ✔ 全部通过');
  process.exit(0);
})().catch((error) => {
  console.error('验收失败：' + (error && error.message ? error.message : error));
  process.exit(1);
});
