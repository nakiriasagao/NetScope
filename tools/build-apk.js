'use strict';

/**
 * 打包 Android APK（不依赖 Gradle）
 *
 * 为什么不用 Gradle：本项目要求零第三方运行时依赖，且本机 npm/npx 受执行策略限制。
 * 这里直接用 Android SDK 的官方命令行工具走标准流程：
 *
 *   aapt2 compile   资源 → .flat
 *   aapt2 link      生成带 resources.arsc 的 base APK（含 AndroidManifest 编译）
 *   javac           编译 Java 源码（classpath 用 android.jar）
 *   d8              class → dex
 *   zip             把 classes.dex 塞进 APK
 *   zipalign        4 字节对齐（Android 运行要求）
 *   apksigner       用 debug 密钥签名（未签名 APK 无法安装）
 *
 * 产物：dist/android/netscope-1.0.0.apk
 *
 * 用法：
 *   node tools/build-apk.js                 # 自动准备工具链并构建
 *   node tools/build-apk.js --skip-fetch    # 工具已就绪时跳过下载
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ANDROID_DIR = path.join(ROOT, 'android');
const SDK_DIR = path.join(ROOT, 'build', 'android-sdk');
const BUILD_DIR = path.join(ROOT, 'build', 'android');
const OUT_DIR = path.join(ROOT, 'dist', 'android');

const APP_VERSION = '1.1.0';
const VERSION_CODE = '2';
const MIN_SDK = '21';
const TARGET_SDK = '34';
const KEYSTORE_PASS = 'android';

function log(msg) {
  process.stdout.write(msg + '\n');
}

function run(cmd, args, opts) {
  const options = {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    ...(opts || {}),
  };
  // Node 24 在 Windows 上不允许直接 spawn .bat/.cmd（会返回 EINVAL），
  // 需要 shell: true。参数里可能含空格路径，这里统一加引号。
  const isBatch = /\.(bat|cmd)$/i.test(cmd);
  let res;
  if (isBatch) {
    const quote = (a) => (/[\s&()^|<>]/.test(a) ? `"${a}"` : a);
    const line = [cmd, ...args].map(quote).join(' ');
    res = spawnSync(line, { ...options, shell: true });
  } else {
    res = spawnSync(cmd, args, options);
  }
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    error: res.error,
  };
}

function findFile(dir, name, depth = 0) {
  if (depth > 4) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return null;
  }
  for (const entry of entries) {
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

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** 生成 debug 签名用的 keystore（存在则复用） */
function ensureKeystore(target) {
  if (fs.existsSync(target)) return true;
  log('→ 生成调试签名密钥 …');
  const res = run('keytool', [
    '-genkeypair', '-v',
    '-keystore', target,
    '-alias', 'androiddebugkey',
    '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
    '-storepass', KEYSTORE_PASS, '-keypass', KEYSTORE_PASS,
    '-dname', 'CN=NetScope Debug,O=NetScope,C=CN',
  ], { timeout: 120000 });
  if (!res.ok) {
    log('   keytool 失败：' + (res.stderr || res.stdout || (res.error && res.error.message) || '').split('\n').slice(0, 3).join(' '));
    return false;
  }
  log('   已生成 ' + path.relative(ROOT, target));
  return true;
}

(async () => {
  log('=== NetScope Android APK 打包 ===');

  // ---------- 0) 工具链 ----------
  if (!process.argv.includes('--skip-fetch') && !fs.existsSync(path.join(SDK_DIR, 'android.jar'))) {
    log('→ 工具链缺失，先下载 …');
    const fetch = run(process.execPath, [path.join(__dirname, 'fetch-android-tools.js')], { cwd: ROOT, timeout: 900000 });
    if (!fetch.ok) {
      console.error('[错误] 工具链下载失败：' + (fetch.stderr || '').slice(0, 400));
      process.exit(1);
    }
  }

  const aapt2 = findFile(SDK_DIR, 'aapt2.exe');
  const d8 = findFile(SDK_DIR, 'd8.bat');
  const zipalign = findFile(SDK_DIR, 'zipalign.exe');
  const apksigner = findFile(SDK_DIR, 'apksigner.bat');
  const androidJar = path.join(SDK_DIR, 'android.jar');

  const missing = [];
  if (!aapt2) missing.push('aapt2.exe');
  if (!d8) missing.push('d8.bat');
  if (!zipalign) missing.push('zipalign.exe');
  if (!apksigner) missing.push('apksigner.bat');
  if (!fs.existsSync(androidJar)) missing.push('android.jar');
  if (missing.length) {
    console.error('[错误] 缺少构建工具：' + missing.join(', '));
    console.error('       请先运行：node tools/fetch-android-tools.js');
    process.exit(1);
  }
  log('→ 工具链就绪（' + path.relative(ROOT, path.dirname(aapt2)) + '）');

  // ---------- 1) 清理 + 准备 assets ----------
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(BUILD_DIR, 'res-compiled'), { recursive: true });
  fs.mkdirSync(path.join(BUILD_DIR, 'classes'), { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 把 public/ 完整复制到 assets/web/：手机端 WebView 加载的就是这套资源，
  // 因此界面与桌面版完全一致（含地图数据、前端脚本、高德接入层）。
  const resDir = path.join(ANDROID_DIR, 'res');
  const assetsWeb = path.join(ANDROID_DIR, 'assets', 'web');
  const publicDir = path.join(ROOT, 'public');
  fs.rmSync(path.join(ANDROID_DIR, 'assets'), { recursive: true, force: true });
  fs.mkdirSync(assetsWeb, { recursive: true });
  fs.cpSync(publicDir, assetsWeb, { recursive: true });
  // runtime-config.js 由服务端按需生成，打包时不需要
  const staleRuntime = path.join(assetsWeb, 'js', 'runtime-config.js');
  if (fs.existsSync(staleRuntime)) fs.rmSync(staleRuntime, { force: true });
  const assetCount = walk(assetsWeb, []).length;
  const assetBytes = walk(assetsWeb, []).reduce((sum, f) => sum + fs.statSync(f).size, 0);
  log(`→ 前端资源已放入 assets/web/（${assetCount} 个文件，${(assetBytes / 1024).toFixed(0)} KB）`);

  // ---------- 2) 编译资源 ----------
  // 用 --dir 让 aapt2 自己扫描整个 res/ 目录：它会按资源类型生成正确的
  // .flat 文件（手动逐个 compile 容易漏掉类型信息，产出 ZIP 而非 .flat）。
  const flatDir = path.join(BUILD_DIR, 'res-compiled');
  const compileRes = run(aapt2, ['compile', '--dir', resDir, '-o', flatDir], { timeout: 180000 });
  if (!compileRes.ok) {
    console.error('[错误] aapt2 compile 失败：');
    console.error((compileRes.stderr || compileRes.stdout).slice(0, 800));
    process.exit(1);
  }
  const flatFiles = walk(flatDir, []).filter((f) => f.endsWith('.flat'));
  if (!flatFiles.length) {
    console.error('[错误] 未生成任何 .flat 资源文件');
    process.exit(1);
  }
  log(`→ 资源已编译（${flatFiles.length} 个）`);

  // ---------- 3) 链接资源，生成 base APK ----------
  const baseApk = path.join(BUILD_DIR, 'base.apk');
  const linkRes = run(aapt2, [
    'link',
    '-o', baseApk,
    '-I', androidJar,
    // 把 assets/ 一并打进 APK（前端资源就在 assets/web/ 下）
    '-A', path.join(ANDROID_DIR, 'assets'),
    '--manifest', path.join(ANDROID_DIR, 'AndroidManifest.xml'),
    '--java', path.join(BUILD_DIR, 'gen'),
    '--min-sdk-version', MIN_SDK,
    '--target-sdk-version', TARGET_SDK,
    '--version-code', VERSION_CODE,
    '--version-name', APP_VERSION,
    '--no-version-vectors',
    ...flatFiles,
  ], { timeout: 180000 });
  if (!linkRes.ok) {
    console.error('[错误] aapt2 link 失败：');
    console.error((linkRes.stderr || linkRes.stdout).slice(0, 1200));
    process.exit(1);
  }
  log('→ 资源已链接（base.apk）');

  // ---------- 4) 编译 Java ----------
  const javaFiles = walk(path.join(ANDROID_DIR, 'java'), []).filter((f) => f.endsWith('.java'));
  const genFiles = fs.existsSync(path.join(BUILD_DIR, 'gen')) ? walk(path.join(BUILD_DIR, 'gen'), []).filter((f) => f.endsWith('.java')) : [];
  const javacArgs = [
    '-source', '8', '-target', '8',
    '-encoding', 'UTF-8',
    '-bootclasspath', androidJar,
    '-classpath', androidJar,
    '-d', path.join(BUILD_DIR, 'classes'),
    '-nowarn',
    ...javaFiles, ...genFiles,
  ];
  const javac = run('javac', javacArgs, { timeout: 300000 });
  if (!javac.ok) {
    // JDK 17 已移除 -bootclasspath 对 java.* 的覆盖能力，退化为只用 -classpath
    const retry = run('javac', [
      '-source', '8', '-target', '8', '-encoding', 'UTF-8',
      '-classpath', androidJar,
      '-d', path.join(BUILD_DIR, 'classes'),
      '-nowarn',
      ...javaFiles, ...genFiles,
    ], { timeout: 300000 });
    if (!retry.ok) {
      console.error('[错误] javac 失败：');
      console.error(((retry.stderr || retry.stdout) || (javac.stderr || javac.stdout)).slice(0, 1500));
      process.exit(1);
    }
  }
  log(`→ Java 已编译（${javaFiles.length + genFiles.length} 个源文件）`);

  // ---------- 5) class → dex ----------
  const classFiles = walk(path.join(BUILD_DIR, 'classes'), []).filter((f) => f.endsWith('.class'));
  const dexDir = path.join(BUILD_DIR, 'dex');
  fs.mkdirSync(dexDir, { recursive: true });
  const d8Res = run(d8, [
    '--min-api', MIN_SDK,
    '--lib', androidJar,
    '--output', dexDir,
    ...classFiles,
  ], { timeout: 300000 });
  if (!d8Res.ok) {
    console.error('[错误] d8 失败：');
    console.error((d8Res.stderr || d8Res.stdout).slice(0, 1200));
    process.exit(1);
  }
  const dexFile = path.join(dexDir, 'classes.dex');
  if (!fs.existsSync(dexFile)) {
    console.error('[错误] d8 未产出 classes.dex');
    process.exit(1);
  }
  log(`→ dex 已生成（${(fs.statSync(dexFile).size / 1024).toFixed(0)} KB，${classFiles.length} 个 class）`);

  // ---------- 6) 把 dex 放进 APK ----------
  const unsignedApk = path.join(BUILD_DIR, 'unsigned.apk');
  fs.copyFileSync(baseApk, unsignedApk);
  // 用系统 tar/zip 不便于原地追加，这里用 Node 实现「向 ZIP 追加文件」太复杂，
  // 改为借助 jar（JDK 自带）更新归档内容。
  const jarUpdate = run('jar', ['uf', unsignedApk, '-C', dexDir, 'classes.dex'], { timeout: 120000 });
  if (!jarUpdate.ok) {
    console.error('[错误] 写入 classes.dex 失败：');
    console.error((jarUpdate.stderr || jarUpdate.stdout).slice(0, 800));
    process.exit(1);
  }
  // 校验确实写进去了
  const verify = run('jar', ['tf', unsignedApk], { timeout: 60000 });
  if (!verify.stdout.includes('classes.dex')) {
    console.error('[错误] classes.dex 未出现在 APK 中');
    process.exit(1);
  }
  log('→ classes.dex 已写入 APK');

  // 校验前端资源确实在 APK 内（assets/web/index.html）
  // 注意：aapt2 在 Windows 上写出的 ZIP 条目可能用反斜杠（assets\web\...），因此两种都要认
  const assetCheck = verify.stdout.split('\n').filter((l) => /assets[\\/]web[\\/]/.test(l)).length;
  if (assetCheck === 0) {
    console.error('[错误] APK 内没有 assets/web/ 前端资源，手机端将无法加载界面');
    process.exit(1);
  }
  const hasIndex = verify.stdout.split('\n').some((l) => /assets[\\/]web[\\/]index\.html/.test(l));
  if (!hasIndex) {
    console.error('[错误] APK 内缺少 assets/web/index.html');
    process.exit(1);
  }
  log(`→ 已确认 APK 内含前端资源（${assetCheck} 项，含 index.html）`);

  // ---------- 7) 对齐 ----------
  const alignedApk = path.join(BUILD_DIR, 'aligned.apk');
  const zipRes = run(zipalign, ['-f', '-p', '4', unsignedApk, alignedApk], { timeout: 120000 });
  if (!zipRes.ok) {
    console.error('[错误] zipalign 失败：');
    console.error((zipRes.stderr || zipRes.stdout).slice(0, 600));
    process.exit(1);
  }
  log('→ 已完成 4 字节对齐');

  // ---------- 8) 签名 ----------
  const keystore = path.join(BUILD_DIR, 'debug.keystore');
  if (!ensureKeystore(keystore)) {
    console.error('[错误] 无法生成签名密钥，APK 将无法安装');
    process.exit(1);
  }
  const finalApk = path.join(OUT_DIR, `netscope-${APP_VERSION}.apk`);
  const signRes = run(apksigner, [
    'sign',
    '--ks', keystore,
    '--ks-pass', 'pass:' + KEYSTORE_PASS,
    '--key-pass', 'pass:' + KEYSTORE_PASS,
    '--ks-key-alias', 'androiddebugkey',
    '--min-sdk-version', MIN_SDK,
    '--v1-signing-enabled', 'true',
    '--v2-signing-enabled', 'true',
    '--out', finalApk,
    alignedApk,
  ], { timeout: 300000 });
  if (!signRes.ok) {
    console.error('[错误] apksigner 签名失败：');
    console.error((signRes.stderr || signRes.stdout).slice(0, 1200));
    process.exit(1);
  }
  log('→ 已签名');

  // ---------- 9) 校验 ----------
  const verifySign = run(apksigner, ['verify', '--print-certs', finalApk], { timeout: 120000 });
  const certLine = (verifySign.stdout || '').split('\n').find((l) => /Signer #1 certificate DN/i.test(l)) || '';
  const size = fs.statSync(finalApk).size;

  log('');
  log('=== 完成 ===');
  log(`APK：${finalApk}`);
  log(`体积：${(size / 1024).toFixed(0)} KB`);
  log(`签名：${verifySign.ok ? '校验通过' : '校验失败（' + (verifySign.stderr || '').slice(0, 200) + '）'}`);
  if (certLine) log('      ' + certLine.trim());
  log(`包名：com.netscope.app    版本：${APP_VERSION}    最低系统：Android 5.0（API ${MIN_SDK}）`);
  log('');
  log('安装方式：把 APK 传到手机点击安装，或用 adb install -r "' + path.basename(finalApk) + '"');
  log('');
  log('这是**独立运行版**：后端服务与前端资源都已打进 APK，');
  log('打开即用，不需要电脑、也不需要联网到任何 NetScope 服务器。');

  if (!verifySign.ok) process.exitCode = 1;
})().catch((error) => {
  console.error('[错误] ' + (error && error.stack ? error.stack : error));
  process.exit(1);
});
