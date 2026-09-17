'use strict';

/**
 * HTTP 工具：请求体读取、JSON 响应、SSE、CORS
 */

const MAX_BODY_BYTES = 256 * 1024;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Access-Control-Max-Age': '86400',
  };
}

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...corsHeaders(),
  });
  res.end(body);
}

function sendError(res, status, message, extra = {}) {
  sendJSON(res, status, { ok: false, error: message, ...extra });
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
    ...corsHeaders(),
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(Object.assign(new Error(`请求体不是合法 JSON：${error.message}`), { statusCode: 400 }));
      }
    });
    req.on('error', (error) => reject(Object.assign(error, { statusCode: 400 })));
  });
}

/**
 * 建立 SSE 通道
 * @param {import('http').ServerResponse} res
 * @param {import('http').IncomingMessage} req
 */
function openSSE(res, req) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...corsHeaders(),
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let open = true;
  const onClose = () => {
    open = false;
  };
  req.on('close', onClose);
  req.on('aborted', onClose);

  const keepAlive = setInterval(() => {
    if (!open) return;
    try {
      res.write(': keep-alive\n\n');
    } catch (_) {
      open = false;
    }
  }, 15000);
  if (keepAlive.unref) keepAlive.unref();

  return {
    isOpen: () => open,
    send(event, data) {
      if (!open) return false;
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        return true;
      } catch (_) {
        open = false;
        return false;
      }
    },
    error(message, extra = {}) {
      this.send('error', { ok: false, error: message, ...extra });
      this.close();
    },
    close() {
      if (!open) return;
      open = false;
      clearInterval(keepAlive);
      try {
        // 用 end(callback) 等待内核缓冲区写完，避免最后一个大事件（如完整拓扑数据）被截断
        res.end(() => {
          /* 已冲刷完毕 */
        });
      } catch (_) {
        /* ignore */
      }
    },
  };
}

/** 解析查询字符串 */
function parseQuery(url) {
  const index = url.indexOf('?');
  const params = new URLSearchParams(index >= 0 ? url.slice(index + 1) : '');
  const out = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

function parseIntParam(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

function boolParam(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

module.exports = {
  MAX_BODY_BYTES,
  corsHeaders,
  sendJSON,
  sendError,
  sendText,
  readBody,
  openSSE,
  parseQuery,
  parseIntParam,
  boolParam,
};
