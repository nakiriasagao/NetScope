'use strict';
// 下载并解压 Android 构建工具（build-tools）+ 编译用 android.jar
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const SDK_DIR = path.join(ROOT, 'build', 'android-sdk');
const DL_DIR = path.join(ROOT, 'build', 'downloads');

const FILES = [
  {
    name: 'build-tools_r34-windows.zip',
    url: 'https://dl.google.com/android/repository/build-tools_r34-windows.zip',
    kind: 'zip',
    note: 'aapt2 / d8 / zipalign / apksigner',
  },
  {
    name: 'android-14.jar',
    url: 'https://repo1.maven.org/maven2/com/google/android/android/4.1.1.4/android-4.1.1.4.jar',
    kind: 'file',
    note: '编译用 android.jar（API 14 起步，兼容性最好）',
  },
];

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 120000, headers: { 'User-Agent': 'NetScope-build/1.0' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        res.resume();
        resolve(download(new URL(res.headers.location, url).toString(), dest, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
      const total = Number(res.headers['content-length'] || 0);
      let got = 0;
      let lastPct = -1;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const out = fs.createWriteStream(dest);
      res.on('data', (c) => {
        got += c.length;
        if (total) {
          const pct = Math.floor((got / total) * 100);
          if (pct >= lastPct + 20) { lastPct = pct; process.stdout.write(`    ${pct}%\n`); }
        }
      });
      res.pipe(out);
      out.on('finish', () => { out.close(() => resolve({ bytes: got })); });
      out.on('error', reject);
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
  });
}

/* ------------------------- 最小 ZIP 解压（仅 store/deflate） ------------------------- */

function unzip(buffer, destDir) {
  // 从尾部找 EOCD（0x06054b50）
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 66000; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是合法的 ZIP（找不到 EOCD）');

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];

  for (let n = 0; n < count; n += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);
    entries.push({ name, method, compressedSize, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }

  const written = [];
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue;
    const lo = entry.localOffset;
    if (buffer.readUInt32LE(lo) !== 0x04034b50) continue;
    const nameLen = buffer.readUInt16LE(lo + 26);
    const extraLen = buffer.readUInt16LE(lo + 28);
    const start = lo + 30 + nameLen + extraLen;
    const raw = buffer.subarray(start, start + entry.compressedSize);
    let data;
    if (entry.method === 0) data = raw;
    else if (entry.method === 8) data = zlib.inflateRawSync(raw);
    else continue; // 不支持其它压缩方法
    const target = path.join(destDir, entry.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    written.push(entry.name);
  }
  return written;
}

(async () => {
  console.log('=== 准备 Android 构建工具 ===');
  fs.mkdirSync(SDK_DIR, { recursive: true });
  fs.mkdirSync(DL_DIR, { recursive: true });

  for (const item of FILES) {
    const dest = path.join(DL_DIR, item.name);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1024 * 1024) {
      console.log(`→ ${item.name} 已存在（${(fs.statSync(dest).size / 1024 / 1024).toFixed(1)} MB），跳过下载`);
    } else {
      console.log(`→ 下载 ${item.name}（${item.note}）…`);
      const r = await download(item.url, dest);
      console.log(`   完成（${(r.bytes / 1024 / 1024).toFixed(1)} MB）`);
    }
    if (item.kind === 'zip') {
      const target = path.join(SDK_DIR, 'build-tools');
      if (fs.existsSync(path.join(target, 'aapt2.exe'))) {
        console.log('   已解压，跳过');
      } else {
        console.log('   解压 …');
        const files = unzip(fs.readFileSync(dest), SDK_DIR);
        console.log(`   已解压 ${files.length} 个文件`);
      }
    } else {
      fs.copyFileSync(dest, path.join(SDK_DIR, 'android.jar'));
      console.log('   已放置为 android.jar');
    }
  }

  // 找到实际包含 aapt2.exe 的目录
  function findFile(dir, name, depth = 0) {
    if (depth > 4) return null;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const hit = findFile(full, name, depth + 1);
        if (hit) return hit;
      } else if (entry.name.toLowerCase() === name.toLowerCase()) {
        return full;
      }
    }
    return null;
  }

  console.log('\n=== 工具定位 ===');
  for (const tool of ['aapt2.exe', 'd8.bat', 'zipalign.exe', 'apksigner.bat']) {
    const hit = findFile(SDK_DIR, tool);
    console.log(`  ${tool.padEnd(16)} ${hit || '未找到'}`);
  }
  const jar = path.join(SDK_DIR, 'android.jar');
  console.log(`  android.jar      ${fs.existsSync(jar) ? jar + '（' + (fs.statSync(jar).size / 1024 / 1024).toFixed(1) + ' MB）' : '未找到'}`);
})().catch((e) => { console.error('[错误] ' + e.message); process.exit(1); });
