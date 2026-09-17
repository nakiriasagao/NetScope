'use strict';

/**
 * NetScope 单文件可执行程序入口（Node SEA）
 *
 * 与 `node src/server.js` 的区别：
 *   1. 参数风格更贴近桌面程序（--port/--host/--no-open/--help）；
 *   2. 默认自动打开浏览器；
 *   3. data/ 固定放在可执行文件旁边，方便做绿色便携版；
 *   4. 前端资源已内嵌在 exe 内，由 src/server.js 的 serveAsset() 直接返回。
 *
 * 构建：node tools/build-exe.js
 */

const path = require('path');
const fs = require('fs');
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

function parseArgs(argv) {
  const args = { port: undefined, host: undefined, open: true, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--no-open') args.open = false;
    else if (a === '--open') args.open = true;
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
    '      --host <地址>    监听地址（默认 127.0.0.1，改成 0.0.0.0 可让局域网访问）',
    '      --no-open        启动后不自动打开浏览器',
    '  -h, --help           显示本帮助',
    '',
    '环境变量：',
    '  NETSCOPE_PORT / NETSCOPE_HOST        同上面的选项',
    '  NETSCOPE_ROOT                        指定数据目录位置（绿色版可用）',
    '  NETSCOPE_GEO_ONLINE=0                关闭在线地理定位，仅用内置离线库',
    '  NETSCOPE_DISABLE_ICMP=1              禁用原生套接字追踪引擎',
    '',
    '提示：路由追踪与局域网设备发现需要管理员权限才能获得最完整的结果。',
  ].join('\n'));
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
  console.log('');
  console.log('  提示：关闭本窗口即停止服务；按 Ctrl+C 也可停止。');
  console.log('');

  if (args.open) {
    try {
      if (process.platform === 'win32') {
        spawn('cmd.exe', ['/d', '/c', 'start', '', info.base], { stdio: 'ignore', detached: true }).unref();
      } else if (process.platform === 'darwin') {
        spawn('open', [info.base], { stdio: 'ignore', detached: true }).unref();
      } else {
        spawn('xdg-open', [info.base], { stdio: 'ignore', detached: true }).unref();
      }
    } catch (_) {
      console.log('  （自动打开浏览器失败，请手动访问上面的地址）');
    }
  }

  process.on('SIGINT', () => {
    console.log('\n  正在停止 NetScope …');
    process.exit(0);
  });
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
