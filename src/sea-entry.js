'use strict';

/**
 * NetScope 桌面版入口（Node SEA）
 *
 * 与 `node src/server.js` 的区别：
 *   1. 参数风格更贴近桌面程序（--port/--host/--no-window/--help）；
 *   2. **默认打开一个独立的应用窗口**（Chrome/Edge 的 --app 模式：无地址栏、无标签页），
 *      并且**关闭该窗口即自动结束后端服务**；
 *   3. data/ 固定放在可执行文件旁边，方便做绿色便携版；
 *   4. 前端资源由同级 public/ 提供（见 tools/build-exe.js 的说明）。
 *
 * 构建：node tools/build-exe.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

// package.json 可能不在 exe 旁边（目录分发模式下 exe 与 public/ 同级），
// 因此容错读取，失败时用内置默认值。
const pkg = (() => {
  try {
    return require('../package.json');
  } catch (_) {
    return { version: '1.0.0' };
  }
})();

/** 带应用模式的浏览器候选（按优先级） */
function browserCandidates() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] || '';
  return [
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local ? path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
}

function findBrowser() {
  for (const candidate of browserCandidates()) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {
      /* 继续 */
    }
  }
  return null;
}

function parseArgs(argv) {
  const args = { port: undefined, host: undefined, help: false, window: true, browser: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--no-window' || a === '--no-open') args.window = false;
    else if (a === '--no-browser') args.browser = false;
    else if (a === '--port' || a === '-p') args.port = Number.parseInt(argv[++i], 10);
    else if (a.startsWith('--port=')) args.port = Number.parseInt(a.slice(7), 10);
    else if (a === '--host') args.host = argv[++i];
    else if (a.startsWith('--host=')) args.host = a.slice(7);
  }
  return args;
}

function printHelp() {
  console.log([
    `NetScope ${pkg.version} · 网络连接探测与拓扑可视化`,
    '',
    '用法：netscope.exe [选项]',
    '',
    '选项：',
    '  -p, --port <端口>    监听端口（默认 8787）',
    '      --host <地址>    监听地址（默认 127.0.0.1；0.0.0.0 表示允许局域网/手机访问）',
    '      --no-window      不打开应用窗口，只启动服务（用浏览器手动访问）',
    '      --no-browser     同上（兼容旧参数）',
    '  -h, --help           显示本帮助',
    '',
    '窗口行为：',
    '  默认以「应用窗口」形式打开（无地址栏、无标签页，类似原生程序）；',
    '  关闭该窗口会同时关闭后端服务。',
    '  若系统未安装 Chrome / Edge，则回退为默认浏览器打开，',
    '  此时请用 Ctrl+C 或关闭本控制台窗口来停止服务。',
    '',
    '环境变量：',
    '  NETSCOPE_PORT / NETSCOPE_HOST        同上面的选项',
    '  NETSCOPE_ROOT                        指定数据目录位置（绿色版可用）',
    '  NETSCOPE_BROWSER                     指定用于应用窗口的浏览器可执行文件',
    '  NETSCOPE_GEO_ONLINE=0                关闭在线地理定位，仅用内置离线库',
    '  NETSCOPE_DISABLE_ICMP=1              禁用原生套接字追踪引擎',
    '',
    '提示：路由追踪与局域网设备发现需要管理员权限才能获得最完整的结果。',
  ].join('\n'));
}

/**
 * 应用窗口使用的浏览器配置目录
 *
 * 必须是**稳定路径**：localStorage（高德 Key、底图偏好、界面设置）都按
 * "来源 + 配置目录"隔离，若每次启动都用新的临时目录，用户会表现为
 * "设置不被保存 / Key 每次都要重填"。因此固定放在用户数据目录下。
 */
function windowProfileDir() {
  const base = process.env.LOCALAPPDATA || process.env.APPDATA || os.tmpdir();
  return path.join(base, 'NetScope', 'browser-profile');
}

/**
 * 以「应用窗口」方式打开页面，并在窗口关闭时回调 onClosed。
 * @returns {import('child_process').ChildProcess|null} 子进程；null 表示未能用应用模式打开
 */
function openAppWindow(browserPath, url, onClosed) {
  const profileDir = windowProfileDir();
  try {
    fs.mkdirSync(profileDir, { recursive: true });
  } catch (_) {
    /* 目录创建失败也继续尝试，浏览器会自行处理 */
  }
  const args = [
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,900',
    '--disable-features=Translate,ChromeWhatsNewUI',
  ];
  let child = null;
  try {
    child = spawn(browserPath, args, { stdio: 'ignore', detached: false, windowsHide: false });
  } catch (_) {
    return null;
  }
  const finish = () => {
    if (typeof onClosed === 'function') onClosed();
  };
  child.on('exit', finish);
  child.on('error', finish);
  return child;
}

/** 回退方案：用系统默认浏览器打开（无法感知窗口关闭） */
function openDefaultBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/d', '/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    }
    return true;
  } catch (_) {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  // 数据目录：放在可执行文件旁边，便于打包成便携版
  const exeDir = path.dirname(process.execPath);
  const dataDir = path.join(exeDir, 'data');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (error) {
    console.warn(`[warn] 无法创建数据目录 ${dataDir}：${error.message}`);
  }

  if (args.port) process.env.NETSCOPE_PORT = String(args.port);
  if (args.host) process.env.NETSCOPE_HOST = args.host;

  const server = require('./server');

  console.log('');
  console.log('  NetScope ' + pkg.version + ' · 网络连接探测与拓扑可视化');
  console.log('  ------------------------------------------------');

  const info = await server.start({
    port: args.port || undefined,
    host: args.host || undefined,
  });

  console.log('');
  console.log('  访问地址：' + info.base);
  console.log('  数据目录：' + dataDir);

  let shuttingDown = false;
  function shutdown(reason, code) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('');
    console.log('  ' + reason + '，正在关闭 NetScope 服务 …');
    // 给 HTTP 连接一点收尾时间，然后退出（data/ 的写入都是同步/短时的）
    setTimeout(() => process.exit(code || 0), 150);
  }

  process.on('SIGINT', () => shutdown('收到停止信号'));
  process.on('SIGTERM', () => shutdown('收到停止信号'));

  if (!args.window) {
    console.log('');
    console.log('  （已按 --no-window 运行：请自行用浏览器访问上面的地址；Ctrl+C 停止）');
    console.log('');
    return;
  }

  const browserPath = process.env.NETSCOPE_BROWSER || findBrowser();
  if (!browserPath) {
    console.log('');
    console.log('  未找到 Chrome / Edge，改用系统默认浏览器打开。');
    console.log('  关闭窗口不会停止服务，请在本控制台按 Ctrl+C 结束。');
    console.log('');
    openDefaultBrowser(info.base);
    return;
  }

  console.log('  正在打开应用窗口（关闭窗口即退出程序）…');
  console.log('');
  const child = openAppWindow(browserPath, info.base, () => {
    shutdown('应用窗口已关闭');
  });

  if (!child) {
    console.log('  应用窗口启动失败，改用系统默认浏览器。');
    openDefaultBrowser(info.base);
    console.log('  请在本控制台按 Ctrl+C 结束程序。');
    console.log('');
  }
}

main().catch((error) => {
  if (error && error.code === 'EADDRINUSE') {
    console.error(`\n[错误] 端口 ${process.env.NETSCOPE_PORT || 8787} 已被占用。请换一个端口，例如：netscope.exe --port 8899\n`);
  } else {
    console.error('\n[错误] 启动失败：' + (error && error.message ? error.message : error) + '\n');
  }
  if (process.stdin.isTTY) {
    console.error('按任意键退出…');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', () => process.exit(1));
  } else {
    process.exit(1);
  }
});
