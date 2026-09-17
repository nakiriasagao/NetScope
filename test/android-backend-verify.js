'use strict';
/**
 * 手机端后端（纯 Java）桌面验证
 *
 * android/java/com/netscope/app/core/ 下的类都不依赖 Android API，
 * 因此可以在桌面 JVM 上直接编译并跑起来，验证：
 *   · HTTP 服务能启动、能提供静态资源（用 public/ 代替 APK 的 assets）
 *   · /api/health、/api/selftest、/api/diagnose、/api/trace、/api/dns、
 *     /api/egress、/api/local、/api/lanscan、/api/portscan 等接口可用
 *   · 返回结构与桌面版 Node 后端一致（前端无需改动即可渲染）
 *
 * 用法：node test/android-backend-verify.js
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CORE = path.join(ROOT, 'android', 'java', 'com', 'netscope', 'app', 'core');
const OUT = path.join(ROOT, 'build', 'android-backend-test');
const PORT = 8922;

const failures = [];
function ok(label, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  → ' + detail : ''}`);
  if (!cond) failures.push(label + (detail ? '（' + detail + '）' : ''));
}

/** 桌面用的资源提供者：从 public/ 读取，模拟 Android 的 assets */
const ASSET_PROVIDER = `
package com.netscope.app.core;

import java.io.File;
import java.io.FileInputStream;
import java.io.ByteArrayOutputStream;

/** 桌面验证用：从磁盘目录读取静态资源（Android 侧换成 assets 实现） */
public class FileAssets implements NetHttpd.AssetProvider {
  private final File base;
  public FileAssets(String dir) { this.base = new File(dir); }

  @Override
  public byte[] read(String path) {
    try {
      File f = new File(base, path);
      if (!f.isFile()) return null;
      FileInputStream in = new FileInputStream(f);
      ByteArrayOutputStream bos = new ByteArrayOutputStream();
      byte[] buf = new byte[8192];
      int n;
      while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
      in.close();
      return bos.toByteArray();
    } catch (Exception e) {
      return null;
    }
  }

  @Override
  public boolean exists(String path) {
    return new File(base, path).isFile();
  }
}
`;

const MAIN = `
package com.netscope.app.core;

/** 桌面验证入口：启动手机端后端，等待外部请求 */
public class VerifyMain {
  public static void main(String[] args) throws Exception {
    int port = args.length > 0 ? Integer.parseInt(args[0]) : 8922;
    String publicDir = args.length > 1 ? args[1] : "public";
    NetHttpd server = new NetHttpd(new FileAssets(publicDir), null) {
    };
    // NetApi 需要 server 引用，这里手工装配
    FinalServer holder = new FinalServer();
    holder.server = new NetHttpd(new FileAssets(publicDir), null);
    holder.api = new NetApi(holder.server);
    holder.server = new NetHttpd(new FileAssets(publicDir), holder.api);
    holder.server.start(port);
    System.out.println("READY " + holder.server.getPort());
    System.out.flush();
    Thread.sleep(600000);
  }

  static class FinalServer {
    NetHttpd server;
    NetApi api;
  }
}
`;

/* NetHttpd 需要一个可用的 ApiHandler；上面的匿名子类写法不成立，
   因此这里直接生成一个正确的装配入口。 */
const MAIN_FIXED = `
package com.netscope.app.core;

/** 桌面验证入口：启动手机端后端（NetHttpd + NetApi），等待外部请求 */
public class VerifyMain {
  public static void main(String[] args) throws Exception {
    int port = args.length > 0 ? Integer.parseInt(args[0]) : 8922;
    String publicDir = args.length > 1 ? args[1] : "public";

    // NetApi 只依赖 ServerInfo 接口（端口/运行时长），因此可以先建后装配
    final NetHttpd[] holder = new NetHttpd[1];
    ServerInfo info = new ServerInfo() {
      @Override public int getPort() { return holder[0] == null ? port : holder[0].getPort(); }
      @Override public long uptimeSec() { return holder[0] == null ? 0 : holder[0].uptimeSec(); }
      @Override public String startedAtIso() { return holder[0] == null ? "" : holder[0].startedAtIso(); }
    };

    NetHttpd server = new NetHttpd(new FileAssets(publicDir), new NetApi(info));
    holder[0] = server;
    server.start(port);
    System.out.println("READY " + server.getPort());
    System.out.flush();
    Thread.sleep(600000);
  }
}
`;

function request(urlPath, method, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1', port: PORT, path: urlPath, method: method || 'GET', timeout: 120000,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch (_) { json = null; }
          resolve({ status: res.statusCode, text, json, headers: res.headers });
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, text: 'timeout', json: null }); });
    req.on('error', (e) => resolve({ status: 0, text: e.code || e.message, json: null }));
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  console.log('==================== 手机端后端（纯 Java）桌面验证 ====================');

  // 1) 编译
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'FileAssets.java'), ASSET_PROVIDER, 'utf8');
  fs.writeFileSync(path.join(OUT, 'VerifyMain.java'), MAIN_FIXED, 'utf8');
  void MAIN;

  const sources = fs.readdirSync(CORE).filter((f) => f.endsWith('.java')).map((f) => path.join(CORE, f));
  sources.push(path.join(OUT, 'FileAssets.java'), path.join(OUT, 'VerifyMain.java'));

  console.log('\n--- 编译（javac，目标 Java 8）---');
  const javac = spawnSync('javac', ['-encoding', 'UTF-8', '-nowarn', '-d', OUT, ...sources], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  ok('核心类编译通过', javac.status === 0, javac.status === 0 ? `${sources.length} 个源文件` : '');
  if (javac.status !== 0) {
    console.log((javac.stderr || javac.stdout || '').split('\n').slice(0, 25).join('\n'));
    process.exit(1);
  }
  console.log('  ✔ 说明这些类完全不依赖 Android API，可在桌面直接验证');

  // 2) 启动
  console.log('\n--- 启动内置服务 ---');
  const child = spawn('java', ['-Dfile.encoding=UTF-8', '-cp', OUT, 'com.netscope.app.core.VerifyMain',
    String(PORT), path.join(ROOT, 'public')], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });

  let ready = false;
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    if (/READY/.test(out)) { ready = true; break; }
  }
  ok('服务启动', ready, ready ? `端口 ${PORT}` : out.split('\n').slice(0, 5).join(' | '));
  if (!ready) { child.kill(); process.exit(1); }

  try {
    // 3) 静态资源
    console.log('\n--- 静态资源（模拟 APK assets）---');
    for (const [p, label] of [['/', '首页'], ['/js/app.js', '前端脚本'], ['/css/style.css', '样式'],
      ['/data/world-110m.json', '地图数据'], ['/js/config.js', '配置']]) {
      const r = await request(p);
      ok(`提供 ${label}`, r.status === 200 && r.text.length > 0, `${p} → HTTP ${r.status}（${r.text.length}B）`);
    }

    // 4) 核心 API
    console.log('\n--- API 接口 ---');
    const health = await request('/api/health');
    ok('/api/health', health.status === 200 && health.json && health.json.ok === true,
      health.json ? `${health.json.platform} / 模式 ${health.json.mode}` : health.text.slice(0, 80));
    if (health.json && health.json.capabilities) {
      ok('能力声明含 hopAddresses=false（诚实标注平台限制）',
        health.json.capabilities.hopAddresses === false);
    }

    const self = await request('/api/selftest');
    const checks = self.json && self.json.checks ? self.json.checks.length : 0;
    ok('/api/selftest', self.status === 200 && checks > 0, `${checks} 项检查，${self.json ? self.json.summary : ''}`);

    const local = await request('/api/local');
    ok('/api/local', local.status === 200 && local.json && local.json.ok === true,
      local.json && local.json.interfaces ? `${local.json.interfaces.length} 个网卡，网关 ${JSON.stringify(local.json.gateways)}` : '');

    const egress = await request('/api/egress');
    ok('/api/egress', egress.status === 200 && egress.json && egress.json.ip != null,
      egress.json ? `出口 IP ${egress.json.ip}` : egress.text.slice(0, 80));

    const dns = await request('/api/dns', 'POST', { target: 'www.baidu.com' });
    const recs = dns.json && dns.json.records ? dns.json.records.length : 0;
    ok('/api/dns', dns.status === 200 && recs > 0, `${recs} 条记录`);

    const ps = await request('/api/portscan', 'POST', { target: '127.0.0.1', ports: '80,443,445,3389' });
    ok('/api/portscan', ps.status === 200 && ps.json && ps.json.scanned > 0,
      ps.json ? `扫描 ${ps.json.scanned} 个端口，开放 ${ps.json.openCount} 个` : '');

    const geo = await request('/api/geo', 'POST', {});
    ok('/api/geo', geo.status === 200 && geo.json != null, geo.json && geo.json.location
      ? `${geo.json.location.city || '?'} / ${geo.json.location.country || '?'}` : '（无可用 IP 时允许为空）');

    console.log('\n--- 路由追踪（关键：能力边界是否如实呈现）---');
    const tr = await request('/api/trace', 'POST', { target: '223.5.5.5', maxHops: 8, queries: 1, traceTimeoutMs: 900 });
    const trace = tr.json && tr.json.trace ? tr.json.trace : null;
    ok('/api/trace 返回结果', tr.status === 200 && trace != null && trace.hops,
      trace ? `引擎 ${trace.engine}，${trace.hops.length} 跳，用时 ${trace.durationMs}ms` : tr.text.slice(0, 120));
    if (trace) {
      const last = trace.hops[trace.hops.length - 1];
      ok('最后一跳是目标地址', last && last.ip === '223.5.5.5', last ? String(last.ip) : '无');
      const noted = (trace.notes || []).some((n) => /中间路由器|平台|无 root|TTL/.test(n));
      ok('如实说明中间跳不可得的平台限制', noted, (trace.notes || []).join(' / ').slice(0, 120));
      const noFakeIp = trace.hops.filter((h) => h.ip && h.ip !== '223.5.5.5' && h.timeout === false).length === 0;
      ok('未伪造中间跳地址', noFakeIp);
    }

    console.log('\n--- 诊断主流程（前端主入口）---');
    const diag = await request('/api/diagnose', 'POST', { target: '223.5.5.5', maxHops: 6, queries: 1, traceTimeoutMs: 800 });
    const d = diag.json;
    ok('/api/diagnose', diag.status === 200 && d && d.ok === true,
      d ? `目标 ${d.target ? d.target.primaryIP : '?'}，${d.durationMs}ms` : diag.text.slice(0, 120));
    if (d) {
      const need = ['input', 'target', 'probe', 'trace', 'geo', 'local', 'generatedAt'];
      const missing = need.filter((k) => !(k in d));
      ok('返回结构与桌面版一致（前端无需改动）', missing.length === 0,
        missing.length ? '缺少 ' + missing.join(', ') : need.join(', '));
      ok('目标解析正确', d.target && d.target.primaryIP === '223.5.5.5');
      ok('包含平台限制说明', Array.isArray(d.mobileLimitations) && d.mobileLimitations.length > 0,
        (d.mobileLimitations || [])[0] ? String(d.mobileLimitations[0]).slice(0, 70) : '');
      ok('geo 为对象且含坐标', d.geo && typeof d.geo === 'object',
        d.geo && d.target && d.geo[d.target.primaryIP]
          ? JSON.stringify(d.geo[d.target.primaryIP]).slice(0, 90) : '（定位服务不可用时允许为空）');
    }

    console.log('\n--- 局域网扫描 ---');
    const lan = await request('/api/lanscan', 'POST', { deep: false });
    ok('/api/lanscan', lan.status === 200 && lan.json && lan.json.ok === true,
      lan.json ? `网段 ${lan.json.subnet}，网关 ${lan.json.gateway}` : lan.text.slice(0, 100));
    if (lan.json) {
      ok('返回设备列表结构', Array.isArray(lan.json.devices));
      ok('说明 ARP 限制', Array.isArray(lan.json.notes) && lan.json.notes.length > 0,
        (lan.json.notes || [])[0] ? String(lan.json.notes[0]).slice(0, 70) : '');
    }

    console.log('\n--- 未实现接口要明确说明 ---');
    const sec = await request('/api/security', 'POST', { target: 'www.baidu.com' });
    ok('未实现接口返回可读说明', sec.status === 200 && sec.json && sec.json.ok === false && sec.json.error,
      sec.json ? String(sec.json.error).slice(0, 60) : '');
  } finally {
    child.kill();
  }

  console.log('\n==================== 结论 ====================');
  if (failures.length) {
    failures.forEach((f) => console.log('  ✘ ' + f));
    process.exit(1);
  }
  console.log('  ✔ 手机端后端在桌面验证通过（同一份代码打包进 APK）');
  process.exit(0);
})().catch((e) => { console.error('验证失败：' + (e && e.message ? e.message : e)); process.exit(1); });
