'use strict';

/**
 * 打包为 Windows 可执行程序
 *
 * 重要限制：Node 的 SEA 只能承载**单个文件**的入口，运行时 `require()`
 * 仅支持内置模块 —— 相对路径 require（如 `require('./config')`）会抛
 * ERR_UNKNOWN_BUILTIN_MODULE。因此这里采用**目录分发**方案：
 *
 *   dist/
 *     netscope.exe      ← 注入 SEA 入口的可执行文件（内含 Node 运行时）
 *     public/           ← 前端资源（exe 会从同级目录读取）
 *     data/             ← 运行期可写目录（缓存 / 导出）
 *     启动 NetScope.bat / 使用说明.txt
 *
 * 入口 src/sea-entry.js 通过相对路径 require 服务器代码，
 * 它按"exe 所在目录"定位 public/ 与 data/，因此整个目录可直接拷贝分发。
 *
 * 若日后要做严格单文件，需要先引入打包器把所有源码合并为一个文件，
 * 再让 SEA 注入 —— 这超出本项目"零第三方运行时依赖"的范围，暂不采用。
 *
 * 用法：
 *   node tools/build-exe.js               # 构建到 dist/
 *   node tools/build-exe.js --out dist2   # 指定输出目录
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = (() => {
  const i = process.argv.indexOf('--out');
  return path.resolve(i > -1 ? process.argv[i + 1] : path.join(ROOT, 'dist'));
})();
const NO_INJECT = process.argv.includes('--no-inject');

const APP_NAME = 'netscope';
const ENTRY = path.join(ROOT, 'src', 'sea-entry.js');
const BUNDLE = path.join(ROOT, 'build', 'bundle.js');
const SEA_CONFIG = path.join(ROOT, 'build', 'sea-config.json');
const SEA_BLOB = path.join(ROOT, 'build', 'netscope.blob');

function log(msg) {
  process.stdout.write(msg + '\n');
}

function walkFiles(dir, base) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, base));
    else {
      // SEA assets 的键名必须使用正斜杠
      out.push({ key: path.relative(base, full).split(path.sep).join('/'), file: full });
    }
  }
  return out;
}

function run(cmd, args, opts) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...(opts || {}) });
  return { ok: res.status === 0, status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

(async () => {
  log('=== NetScope 可执行文件打包 ===');
  log('项目: ' + ROOT);
  log('输出: ' + OUT_DIR);
  log('');

  if (!fs.existsSync(ENTRY)) {
    console.error('[错误] 缺少入口文件 ' + ENTRY);
    process.exit(1);
  }

  // ---------- 1) 检查入口与随附资源 ----------
  if (!fs.existsSync(ENTRY)) {
    console.error('[错误] 缺少入口文件 ' + ENTRY);
    process.exit(1);
  }
  const publicDir = path.join(ROOT, 'public');
  if (!fs.existsSync(path.join(publicDir, 'index.html'))) {
    console.error('[错误] 缺少前端资源 ' + publicDir);
    process.exit(1);
  }

  // ---------- 2) 先把源码打包成单文件 ----------
  // SEA 的 require 只支持内置模块，因此必须先把 src/ 合并成一个自包含文件。
  log('→ 打包源码为单文件 …');
  const bundler = require('./bundle');
  const bundled = bundler.bundle(ROOT, ENTRY);
  fs.mkdirSync(path.dirname(BUNDLE), { recursive: true });
  fs.writeFileSync(BUNDLE, bundled.code, 'utf8');
  log(`   完成（${bundled.modules} 个模块，${(bundled.bytes / 1024).toFixed(1)} KB）`);

  // ---------- 3) 生成 SEA 配置 ----------
  fs.mkdirSync(path.dirname(SEA_CONFIG), { recursive: true });
  const seaConfig = {
    main: BUNDLE,
    output: SEA_BLOB,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  };
  fs.writeFileSync(SEA_CONFIG, JSON.stringify(seaConfig, null, 2), 'utf8');
  log('→ 已生成 ' + path.relative(ROOT, SEA_CONFIG));

  // ---------- 4) 生成 blob ----------
  log('→ 生成 SEA blob …');
  const blobRes = run(process.execPath, ['--experimental-sea-config', SEA_CONFIG], { cwd: ROOT });
  if (!blobRes.ok) {
    console.error('[错误] 生成 SEA blob 失败：');
    console.error(blobRes.stderr || blobRes.stdout);
    process.exit(1);
  }
  const blobSize = fs.statSync(SEA_BLOB).size;
  log(`   完成（${(blobSize / 1024).toFixed(0)} KB）`);

  // ---------- 5) 复制 node 可执行文件 ----------
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const exePath = path.join(OUT_DIR, `${APP_NAME}.exe`);
  fs.copyFileSync(process.execPath, exePath);
  log(`→ 已复制运行时：${path.relative(ROOT, exePath)}（${(fs.statSync(exePath).size / 1024 / 1024).toFixed(1)} MB）`);

  // ---------- 5) 注入 blob ----------
  // 用 postject 把 blob 注入到 exe 的 NODE_SEA_BLOB 段。
  // 本机 npm/npx 的 .ps1 被执行策略拦截，因此这里不走 npx：
  // 先用自带的零依赖下载器把 postject 装到 build/tools，再用 node 直接调用其 CLI。
  let injected = false;
  if (NO_INJECT) {
    log('→ 跳过注入（--no-inject）');
  } else {
    log('→ 注入 SEA blob …');
    const fuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
    const toolsDir = path.join(ROOT, 'build', 'tools');
    try {
      const fetcher = require('./fetch-npm-package');
      let postjectBin = null;
      try {
        postjectBin = fetcher.resolveBin(toolsDir, 'postject', 'postject');
      } catch (_) {
        postjectBin = null;
      }
      if (!postjectBin) {
        log('   本地没有 postject，正在下载（零依赖下载器，不使用 npm）…');
        const info = await fetcher.installPackage('postject', toolsDir, new Set(), '1.0.0-alpha.6');
        log(`   已安装 postject ${info.version}`);
      }
      const bin = fetcher.resolveBin(toolsDir, 'postject', 'postject');
      const pj = run(process.execPath, [
        bin, exePath, 'NODE_SEA_BLOB', SEA_BLOB,
        '--sentinel-fuse', fuse,
      ], { cwd: ROOT, timeout: 300000 });
      if (pj.ok) {
        injected = true;
        log('   注入成功');
      } else {
        log('   注入失败：' + String(pj.stderr || pj.stdout).split('\n').filter(Boolean).slice(-3).join(' ').trim());
      }
    } catch (error) {
      log('   注入步骤异常：' + error.message);
    }
  }

  // ---------- 6) 随附运行所需目录 ----------
  const dataDir = path.join(OUT_DIR, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  // 服务端代码按相对路径 require，public/ 需要与 exe 同级
  fs.cpSync(publicDir, path.join(OUT_DIR, 'public'), { recursive: true });
  const publicCount = walkFiles(path.join(OUT_DIR, 'public'), path.join(OUT_DIR, 'public')).length;
  log(`→ 已随附 public/（${publicCount} 个文件）`);

  // ---------- 7) 启动脚本与说明 ----------
  const bat = [
    '@echo off',
    'chcp 65001 >nul',
    'title NetScope',
    'echo 正在启动 NetScope …',
    'echo 启动后浏览器会自动打开 http://127.0.0.1:8787',
    'echo 关闭本窗口即可停止服务。',
    'echo.',
    `"%~dp0${APP_NAME}.exe" %*`,
    'pause',
  ].join('\r\n');
  fs.writeFileSync(path.join(OUT_DIR, '启动 NetScope.bat'), bat, 'utf8');

  const readme = [
    'NetScope 便携版',
    '================',
    '',
    '运行方式：双击「启动 NetScope.bat」，或直接双击 netscope.exe。',
    '启动后浏览器会自动打开 http://127.0.0.1:8787 。',
    '',
    '目录说明（整个文件夹一起拷贝即可，不要只拷 exe）：',
    '  netscope.exe        主程序（自带 Node 运行时，无需安装 Node.js）',
    '  public/             前端页面与地图数据（必须与 exe 放在一起）',
    '  data/               缓存与导出文件（可删除，会自动重建）',
    '',
    '命令行参数：',
    '  netscope.exe --port 9000        指定端口',
    '  netscope.exe --host 0.0.0.0     允许局域网访问（注意安全风险）',
    '  netscope.exe --no-open          启动后不自动打开浏览器',
    '  netscope.exe --help             查看全部参数',
    '',
    '提示：路由追踪与局域网设备发现需要管理员权限才能获得最完整的结果。',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(OUT_DIR, '使用说明.txt'), readme, 'utf8');

  const exeSize = fs.statSync(exePath).size;
  log('');
  log('=== 完成 ===');
  log(`输出目录：${OUT_DIR}`);
  log(`主程序：netscope.exe（${(exeSize / 1024 / 1024).toFixed(1)} MB，含 Node 运行时）`);
  log(`SEA 注入：${injected ? '成功' : '未注入（exe 无法独立运行，请检查 postject）'}`);
  log('目录内容：');
  for (const entry of fs.readdirSync(OUT_DIR, { withFileTypes: true })) {
    const full = path.join(OUT_DIR, entry.name);
    const size = entry.isDirectory()
      ? `${walkFiles(full, full).length} 个文件`
      : `${(fs.statSync(full).size / 1024).toFixed(0)} KB`;
    log(`  ${entry.isDirectory() ? '[目录]' : '      '} ${entry.name.padEnd(24)} ${size}`);
  }
  if (!injected) process.exitCode = 1;
})().catch((error) => {
  console.error('[错误] ' + (error && error.stack ? error.stack : error));
  process.exit(1);
});
