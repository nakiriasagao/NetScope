'use strict';

/**
 * 本地 CONNECT 隧道代理（仅用于 git 推送）
 *
 * 背景：本机 git 使用 Windows schannel 做 TLS 握手时，到 github.com:443 的
 * ClientHello 会被中途卡住（git 报 "Failed to connect ... Connection was reset"），
 * 而 Node 的 OpenSSL 栈可以正常握手。为绕开这个差异，这里提供一个极简的
 * HTTP CONNECT 隧道：git 把请求发到本地代理，代理负责与目标建立 TCP 连接并双向转发。
 *
 * 关键点：**不做 TLS 中间人**。CONNECT 之后的数据原样转发，TLS 握手仍然发生在
 * git 与 github.com 之间，因此不涉及证书问题。
 *
 * 用法：
 *   node tools/git-tunnel.js [--port 8899]
 *   git -c http.proxy=http://127.0.0.1:8899 push origin main
 */

const http = require('http');
const net = require('net');
const dns = require('dns');

const portArgIndex = process.argv.indexOf('--port');
const PORT = portArgIndex > -1 ? Number.parseInt(process.argv[portArgIndex + 1], 10) : 8899;
const ALLOWED_HOSTS = (process.env.TUNNEL_ALLOW || 'github.com,codeload.github.com,api.github.com,objects.githubusercontent.com,raw.githubusercontent.com')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

let activeTunnels = 0;
let totalTunnels = 0;

/**
 * 依次尝试解析出的所有 IPv4 地址建立连接。
 * 直连 github.com 时常出现某些 IP 被 reset / 超时的情况，逐个重试能显著提高成功率。
 */
async function connectWithRetry(host, port, attemptsPerAddress = 2) {
  let addresses = [];
  try {
    const list = await dns.promises.lookup(host, { all: true, family: 4 });
    addresses = [...new Set(list.map((a) => a.address))];
  } catch (_) {
    addresses = [];
  }
  if (!addresses.length) addresses = [host];

  let lastError = null;
  for (let round = 0; round < attemptsPerAddress; round += 1) {
    for (const address of addresses) {
      try {
        const socket = await new Promise((resolve, reject) => {
          const s = net.connect({ host: address, port });
          const timer = setTimeout(() => {
            s.destroy();
            reject(Object.assign(new Error('连接超时'), { code: 'ETIMEDOUT' }));
          }, 8000);
          s.once('connect', () => {
            clearTimeout(timer);
            resolve(s);
          });
          s.once('error', (error) => {
            clearTimeout(timer);
            s.destroy();
            reject(error);
          });
        });
        console.error(`[tunnel] 已连接 ${host}(${address}):${port}（第 ${round + 1} 轮）`);
        return socket;
      } catch (error) {
        lastError = error;
        console.error(`[tunnel] 连接失败 ${host}(${address}):${port} → ${error.code || error.message}`);
      }
    }
    if (round < attemptsPerAddress - 1) {
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  throw lastError || new Error('无法连接目标');
}

const server = http.createServer((req, res) => {
  res.writeHead(405, { 'Content-Type': 'text/plain' });
  res.end('该代理仅支持 HTTP CONNECT\n');
});

server.on('connect', async (req, clientSocket, head) => {
  const [host, portRaw] = String(req.url).split(':');
  const port = Number.parseInt(portRaw, 10) || 443;

  if (!ALLOWED_HOSTS.includes(host)) {
    clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    console.error(`[tunnel] 拒绝未在白名单中的目标：${host}:${port}`);
    return;
  }

  let targetSocket;
  try {
    targetSocket = await connectWithRetry(host, port);
  } catch (error) {
    console.error(`[tunnel] 无法连接 ${host}:${port} → ${error.code || error.message}`);
    try {
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    } catch (_) {
      /* ignore */
    }
    return;
  }

  activeTunnels += 1;
  totalTunnels += 1;
  clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  if (head && head.length) targetSocket.write(head);

  targetSocket.pipe(clientSocket);
  clientSocket.pipe(targetSocket);

  const close = (who) => () => {
    if (activeTunnels > 0) activeTunnels -= 1;
    console.error(`[tunnel] ${who} 关闭 ${host}:${port}（活动 ${activeTunnels}，累计 ${totalTunnels}）`);
    targetSocket.destroy();
    clientSocket.destroy();
  };
  targetSocket.on('close', close('目标'));
  clientSocket.on('close', close('客户端'));
  targetSocket.on('error', (error) => console.error('[tunnel] 目标连接错误：' + error.code));
  clientSocket.on('error', (error) => console.error('[tunnel] 客户端连接错误：' + error.code));

  targetSocket.setTimeout(180000, () => {
    console.error(`[tunnel] ${host}:${port} 空闲超时，关闭`);
    targetSocket.destroy();
    clientSocket.destroy();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Git 隧道代理已启动：http://127.0.0.1:${PORT}`);
  console.log(`允许的目标：${ALLOWED_HOSTS.join(', ')}`);
  console.log('');
  console.log('用法：');
  console.log(`  git -c http.proxy=http://127.0.0.1:${PORT} push origin main`);
  console.log(`  git -c http.proxy=http://127.0.0.1:${PORT} ls-remote origin`);
  console.log('');
  console.log('按 Ctrl+C 停止。');
});

process.on('SIGINT', () => {
  console.log('\n隧道代理已停止。');
  process.exit(0);
});
