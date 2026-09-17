'use strict';

/**
 * NetScope HTTP 服务
 *  - 提供静态前端（public/）与 REST / SSE API（/api/*）
 *  - 零第三方依赖（仅使用 Node 内置模块）
 *  - 默认只监听 127.0.0.1，避免把本机网络诊断能力暴露到局域网
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const config = require('./config');
const { routes } = require('./api/routes');
const { sendJSON, sendError, sendText, corsHeaders } = require('./http-utils');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/**
 * 内嵌资源访问器（打包为单文件 exe 时使用）
 *
 * SEA 构建会把 public/ 下的所有前端资源注入可执行文件，
 * 这里通过 node:sea 读出并直接返回，无需磁盘上的 public/ 目录。
 * 非 SEA 环境下 require('node:sea') 不可用，因此用 try 包裹。
 */
let seaApi = null;
try {
  // eslint-disable-next-line global-require
  seaApi = require('node:sea');
  if (!seaApi || typeof seaApi.isSea !== 'function' || !seaApi.isSea()) seaApi = null;
} catch (_) {
  seaApi = null;
}

/** 是否运行在单文件可执行程序内 */
function isSeaRuntime() {
  return Boolean(seaApi);
}

/**
 * 读取内嵌资源
 * @param {string} assetKey 形如 'index.html'、'js/app.js'（相对 public/，使用正斜杠）
 * @returns {Buffer|null}
 */
function readAsset(assetKey) {
  if (!seaApi) return null;
  try {
    return Buffer.from(seaApi.getAsset(assetKey));
  } catch (_) {
    return null;
  }
}

/**
 * 启动时把实际监听地址写入 public/js/runtime-config.js，
 * 这样即使前端页面是从 file:// 或其它端口打开的，也能自动找到 API。
 *
 * 单文件模式下 public/ 可能是只读或不存在的，此时跳过写盘，
 * 改由内嵌资源里的 runtime-config.js 兜底（见 readAsset 调用处）。
 */
function writeRuntimeConfig(address) {
  const target = path.join(config.publicDir, 'js', 'runtime-config.js');
  const content = runtimeConfigContent(address);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  } catch (error) {
    if (!isSeaRuntime()) console.warn(`[warn] 无法写入 runtime-config.js: ${error.message}`);
  }
  return target;
}

/** runtime-config.js 的内容 */
function runtimeConfigContent(address) {
  return `/* 由 NetScope 服务端自动生成，勿手工修改 */\nwindow.NETSCOPE_RUNTIME = ${JSON.stringify(
    {
      apiBase: address,
      version: require('../package.json').version,
      generatedAt: new Date().toISOString(),
    },
    null,
    2,
  )};\n`;
}

/* ------------------------------------------------------------------ */
/* 静态资源                                                            */
/* ------------------------------------------------------------------ */

/** 去掉查询串与哈希，得到纯路径 */
function pathOnly(url) {
  const raw = String(url || '/');
  const cut = raw.search(/[?#]/);
  return cut === -1 ? raw : raw.slice(0, cut);
}

function safeJoin(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathOnly(urlPath));
  } catch (_) {
    return null; // 非法百分号编码
  }
  const normalized = path.normalize(decoded).replace(/^([/\\])+/, '');
  const full = path.join(root, normalized);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

/** 是否已经向浏览器发送过"清理缓存"指令（服务进程内只发一次） */
let cachePurgeSent = false;

function serveStatic(req, res) {
  const urlPath = pathOnly(req.url);
  const filePath = safeJoin(config.publicDir, urlPath === '/' ? '/index.html' : urlPath);
  if (!filePath) {
    sendError(res, 403, '非法路径');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // 磁盘上找不到时，尝试从内嵌资源读取（单文件 exe 模式）
      if (serveAsset(req, res, urlPath)) return;
      // 单页应用：未知路径回退到 index.html（仅限非资源类请求）
      if (!path.extname(urlPath)) {
        const fallback = path.join(config.publicDir, 'index.html');
        if (fs.existsSync(fallback)) {
          serveFile(req, res, fallback, stat);
          return;
        }
        if (serveAsset(req, res, '/index.html')) return;
      }
      sendError(res, 404, `资源不存在：${urlPath}`);
      return;
    }
    serveFile(req, res, filePath, stat);
  });
}

/**
 * 从内嵌资源返回响应（单文件 exe 模式）
 *
 * 内嵌资源的"修改时间"就是可执行文件的构建时间，因此用进程启动时间做 ETag 依据，
 * 保证同一份 exe 内资源稳定、重新打包后自动失效。
 * @returns {boolean} 是否已处理该请求
 */
function serveAsset(req, res, urlPath) {
  if (!seaApi) return false;

  let key = pathOnly(urlPath).replace(/^\/+/, '');
  if (!key) key = 'index.html';
  if (key === 'js/runtime-config.js') {
    // 内嵌模式下 public/ 只读：这个文件按当前监听地址即时生成
    const body = Buffer.from(runtimeConfigContent(`http://${req.headers.host || '127.0.0.1'}`), 'utf8');
    res.writeHead(200, {
      'Content-Type': MIME_TYPES['.js'],
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
      ...corsHeaders(),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }

  const body = readAsset(key);
  if (!body) return false;

  const ext = path.extname(key).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  const isData = key.startsWith('data/');
  const cacheControl = ext === '.html' || isData ? 'no-cache' : `public, max-age=${config.http.staticMaxAge}`;
  const etag = `"sea-${body.length.toString(16)}-${Math.floor(process.uptime()).toString(16)}"`;

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl, ...corsHeaders() });
    res.end();
    return true;
  }
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': body.length,
    'Cache-Control': cacheControl,
    ETag: etag,
    ...corsHeaders(),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

function serveFile(req, res, filePath, stat) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  // 数据文件会随构建脚本更新，禁止强缓存，避免用户看到旧地图（横条纹等已修复的问题）
  const isData = filePath.includes(`${path.sep}data${path.sep}`);
  // HTML 与 data/ 下的数据文件用 no-cache：每次都要向服务端确认，
  // 配合下面的 ETag / Last-Modified 走 304 条件请求，既不会拿到旧内容，也不浪费带宽。
  const cacheControl = ext === '.html' || isData ? 'no-cache' : `public, max-age=${config.http.staticMaxAge}`;
  const etag = stat ? `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"` : null;
  const lastModified = stat ? new Date(stat.mtimeMs).toUTCString() : null;

  // 条件请求：内容没变就回 304，避免重新下载世界地图这种较大的数据文件
  if (stat && etag) {
    const ifNoneMatch = req.headers['if-none-match'];
    const ifModifiedSince = req.headers['if-modified-since'];
    const etagHit = ifNoneMatch && ifNoneMatch.split(',').map((s) => s.trim()).includes(etag);
    const timeHit = ifModifiedSince && new Date(ifModifiedSince).getTime() >= Math.floor(stat.mtimeMs / 1000) * 1000;
    if (etagHit || timeHit) {
      res.writeHead(304, {
        ETag: etag,
        'Last-Modified': lastModified,
        'Cache-Control': cacheControl,
        ...corsHeaders(),
      });
      res.end();
      return;
    }
  }

  const headers = {
    'Content-Type': mime,
    'Content-Length': stat ? stat.size : 0,
    'Cache-Control': cacheControl,
    ...corsHeaders(),
  };
  if (etag) headers.ETag = etag;
  if (lastModified) headers['Last-Modified'] = lastModified;

  // 首次返回页面时，主动清理浏览器侧缓存：
  // 早期版本把 data/ 当成普通静态资源做过强缓存，旧的世界地图数据可能还留在
  // 浏览器缓存里（表现为地图样式没有更新）。这里发一次 Clear-Site-Data，
  // 清掉本源的 HTTP 缓存；之后靠 ETag 条件请求保持最新，不再重复发送。
  if (!cachePurgeSent && ext === '.html') {
    cachePurgeSent = true;
    headers['Clear-Site-Data'] = '"cache"';
  }

  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
}

/* ------------------------------------------------------------------ */
/* 请求分发                                                            */
/* ------------------------------------------------------------------ */

const routeMap = new Map();
for (const route of routes) {
  routeMap.set(`${route.method} ${route.path}`, route);
}

async function handleApi(req, res) {
  const url = req.url.split('?')[0];
  const key = `${req.method} ${url}`;
  const route = routeMap.get(key);

  if (!route) {
    sendError(res, 404, `接口不存在：${key}`, { available: [...routeMap.keys()] });
    return;
  }

  try {
    const result = await route.handler(req, res, { config });
    if (result !== undefined && !res.headersSent) {
      sendJSON(res, 200, { ok: true, ...result });
    }
  } catch (error) {
    if (res.headersSent) {
      try {
        res.end();
      } catch (_) {
        /* ignore */
      }
      return;
    }
    const status = error.statusCode || (error.code === 'ABORTED' ? 499 : 500);
    sendError(res, status, error.message || String(error), { code: error.code || null });
  }
}

function createServer() {
  const server = http.createServer((req, res) => {
    const started = Date.now();
    const urlPath = req.url.split('?')[0];

    res.on('finish', () => {
      if (process.env.NETSCOPE_LOG === '0') return;
      const ms = Date.now() - started;
      console.log(`${new Date().toISOString()} ${req.method} ${urlPath} → ${res.statusCode} (${ms}ms)`);
    });

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (urlPath.startsWith('/api/')) {
      handleApi(req, res);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, 405, '仅支持 GET / HEAD');
      return;
    }

    serveStatic(req, res);
  });

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return server;
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

function start(options = {}) {
  const port = options.port !== undefined ? options.port : config.http.port;
  const host = options.host || config.http.host;
  const server = createServer();

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      let displayHost = address.address;
      if (displayHost === '::' || displayHost === '0.0.0.0') displayHost = '127.0.0.1';
      if (displayHost === '::1') displayHost = '127.0.0.1';
      const base = `http://${displayHost}:${address.port}`;
      writeRuntimeConfig(base);
      resolve({ server, base, port: address.port, host: displayHost });
    });
  });
}

function parseArgs(argv) {
  const args = { port: undefined, host: undefined, open: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--port' || a === '-p') args.port = Number.parseInt(argv[++i], 10);
    else if (a.startsWith('--port=')) args.port = Number.parseInt(a.split('=')[1], 10);
    else if (a === '--host') args.host = argv[++i];
    else if (a.startsWith('--host=')) args.host = a.split('=')[1];
    else if (a === '--open') args.open = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function printBanner(info) {
  const lines = [
    '',
    '  ╭──────────────────────────────────────────────╮',
    '  │   NetScope · 网络连接探测与世界地图拓扑可视化  │',
    '  ╰──────────────────────────────────────────────╯',
    '',
    `  界面地址   ${info.base}`,
    `  接口地址   ${info.base}/api/health`,
    `  运行平台   ${os.type()} ${os.release()} / Node ${process.version}`,
    '',
    '  提示：默认仅监听本机。如需局域网内其它设备访问，使用 --host 0.0.0.0 启动。',
    '  按 Ctrl+C 停止服务。',
    '',
  ];
  console.log(lines.join('\n'));
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`用法: node src/server.js [--port 8787] [--host 127.0.0.1] [--open]\n\n` +
      `环境变量:\n` +
      `  NETSCOPE_PORT                 监听端口（默认 8787）\n` +
      `  NETSCOPE_HOST                 监听地址（默认 127.0.0.1）\n` +
      `  NETSCOPE_GEO_ONLINE=0         关闭在线地理定位，仅用内置离线库\n` +
      `  NETSCOPE_GEO_PROVIDERS        地理服务顺序，如 ipwhois,ipapi,ipinfo\n` +
      `  NETSCOPE_DISABLE_ICMP=1       禁用以原生套接字为主的追踪引擎\n` +
      `  NETSCOPE_LOG=0                关闭访问日志\n`);
    process.exit(0);
  }

  start({ port: args.port, host: args.host })
    .then((info) => {
      printBanner(info);
      if (args.open) {
        const { spawn } = require('child_process');
        try {
          if (process.platform === 'win32') spawn('cmd.exe', ['/d', '/c', 'start', '', info.base], { stdio: 'ignore', detached: true }).unref();
          else if (process.platform === 'darwin') spawn('open', [info.base], { stdio: 'ignore', detached: true }).unref();
          else spawn('xdg-open', [info.base], { stdio: 'ignore', detached: true }).unref();
        } catch (_) {
          /* 打开浏览器失败不影响服务 */
        }
      }
    })
    .catch((error) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`\n[错误] 端口 ${config.http.port} 已被占用。请换一个端口，例如：node src/server.js --port 8899\n`);
      } else {
        console.error(`\n[错误] 服务启动失败：${error.message}\n`);
      }
      process.exit(1);
    });

  process.on('SIGINT', () => {
    console.log('\n正在停止 NetScope 服务…');
    process.exit(0);
  });
}

module.exports = { createServer, start, writeRuntimeConfig, MIME_TYPES };
