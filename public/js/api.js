/* NetScope API 客户端
 * 统一封装 REST 调用与 SSE 流式订阅（EventSource）。
 */
(function () {
  'use strict';

  var cfg = window.NetScopeConfig;

  function buildUrl(path, query) {
    var url = cfg.apiBase + path;
    if (query && Object.keys(query).length) {
      var params = new URLSearchParams();
      Object.keys(query).forEach(function (key) {
        var value = query[key];
        if (value === undefined || value === null || value === '') return;
        params.append(key, typeof value === 'boolean' ? (value ? '1' : '0') : value);
      });
      var qs = params.toString();
      if (qs) url += (url.indexOf('?') >= 0 ? '&' : '?') + qs;
    }
    return url;
  }

  async function request(path, options) {
    var opts = options || {};
    var url = buildUrl(path, opts.query);
    var init = { method: opts.method || 'GET', headers: {} };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    if (opts.signal) init.signal = opts.signal;

    var response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      var netError = new Error(
        '无法连接到 NetScope 服务（' + cfg.apiBase + '）。请确认服务已启动：node src/server.js',
      );
      netError.cause = error;
      netError.isNetworkError = true;
      throw netError;
    }

    var text = await response.text();
    var data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (error) {
      throw new Error('服务返回了非 JSON 内容（HTTP ' + response.status + '）：' + text.slice(0, 160));
    }
    if (!response.ok || (data && data.ok === false)) {
      var message = (data && data.error) || ('HTTP ' + response.status);
      var apiError = new Error(message);
      apiError.status = response.status;
      apiError.payload = data;
      throw apiError;
    }
    return data;
  }

  /**
   * 订阅 SSE 流
   * @param {string} path 例如 /api/trace/stream
   * @param {object} query 查询参数
   * @param {{ onEvent?: Function, onDone?: Function, onError?: Function, onClose?: Function, timeoutMs?: number }} handlers
   * @returns {{ close: Function }}
   */
  function stream(path, query, handlers) {
    var h = handlers || {};
    var url = buildUrl(path, query);
    var source = new EventSource(url);
    var closed = false;
    var timer = null;

    function cleanup() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      try {
        source.close();
      } catch (e) {
        /* 忽略 */
      }
      if (h.onClose) h.onClose();
    }

    if (h.timeoutMs) {
      timer = setTimeout(function () {
        if (h.onError) h.onError(new Error('请求超时（' + Math.round(h.timeoutMs / 1000) + ' 秒）'));
        cleanup();
      }, h.timeoutMs);
    }

    // 后端会发送 start / progress / task / hops / done / error / canceled 等命名事件
    ['start', 'task', 'progress', 'hops', 'hop', 'done', 'error', 'canceled'].forEach(function (name) {
      source.addEventListener(name, function (event) {
        var payload = null;
        try {
          payload = JSON.parse(event.data);
        } catch (e) {
          payload = { raw: event.data };
        }
        if (h.onEvent) h.onEvent(name, payload);
        if (name === 'done') {
          cleanup();
          if (h.onDone) h.onDone(payload);
        } else if (name === 'error') {
          cleanup();
          if (h.onError) h.onError(new Error((payload && payload.error) || '服务端返回错误'));
        } else if (name === 'canceled') {
          cleanup();
          if (h.onError) h.onError(new Error('任务已取消'));
        }
      });
    });

    // EventSource 自身的错误（网络断开、服务重启等）
    source.onerror = function () {
      if (closed) return;
      // 若已收到 done，cleanup 会关闭连接，此时忽略
      cleanup();
      if (h.onError) h.onError(new Error('流式连接中断（服务可能已停止）'));
    };

    return {
      close: function (notify) {
        if (closed) return;
        var wasClosed = closed;
        cleanup();
        if (notify && !wasClosed && h.onClose) h.onClose();
      },
    };
  }

  window.NetScopeAPI = {
    base: cfg.apiBase,
    health: function () {
      return request('/api/health');
    },
    selfTest: function () {
      return request('/api/selftest');
    },
    tasks: function () {
      return request('/api/tasks');
    },
    result: function (taskId) {
      return request('/api/result', { query: { taskId: taskId } });
    },
    analyze: function (target) {
      return request('/api/analyze', { method: 'POST', body: { target: target } });
    },
    probe: function (target, extra) {
      return request('/api/probe', { method: 'POST', body: Object.assign({ target: target }, extra || {}) });
    },
    /** 获取公网出口 IP 探测结果（需要更细粒度的原始数据时使用） */
    probeRaw: function (target, extra) {
      return request('/api/probe', { method: 'POST', body: Object.assign({ target: target }, extra || {}) });
    },
    trace: function (target, params) {
      return request('/api/trace', { method: 'POST', body: Object.assign({ target: target }, params || {}) });
    },
    traceStream: function (target, params, handlers) {
      return stream('/api/trace/stream', Object.assign({ target: target }, params || {}), handlers);
    },
    diagnoseStream: function (target, params, handlers) {
      return stream('/api/diagnose/stream', Object.assign({ target: target }, params || {}), handlers);
    },
    geo: function (ips) {
      return request('/api/geo', { method: 'POST', body: { ips: ips } });
    },
    local: function (query) {
      return request('/api/local', { query: query });
    },
    egress: function () {
      return request('/api/egress');
    },
    dns: function (domain) {
      return request('/api/dns', { method: 'POST', body: { domain: domain } });
    },
    dnsCompare: function (domain, servers) {
      return request('/api/dns/compare', { method: 'POST', body: { domain: domain, servers: servers } });
    },
    dnsDelegationStream: function (domain, handlers) {
      return stream('/api/dns/delegation/stream', { domain: domain }, handlers);
    },
    portScan: function (target, params) {
      return request('/api/portscan', { method: 'POST', body: Object.assign({ target: target }, params || {}) });
    },
    security: function (target) {
      return request('/api/security', { method: 'POST', body: { target: target } });
    },
    cancel: function (taskId) {
      return request('/api/cancel', { method: 'POST', body: { taskId: taskId } });
    },
    request: request,
  };
})();
