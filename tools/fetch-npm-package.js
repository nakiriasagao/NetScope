'use strict';

/**
 * 极简 npm 包下载器（零第三方依赖）
 *
 * 为什么需要它：本项目约定"零第三方运行时依赖"，且本机 npm 的 .ps1 被
 * 执行策略拦截、npx 无法使用。打包 exe 时需要 postject 做 SEA blob 注入，
 * 因此这里直接从 npm registry 下载 tarball 并用内置 zlib 解开，
 * 组装出可被 node 直接 require 的 node_modules 结构。
 *
 * 只支持 .tar.gz（npm 的默认包格式）与 npm 的扁平依赖（dependencies 一层）。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const REGISTRIES = [
  'https://registry.npmjs.org',
  'https://registry.npmmirror.com',
];

function fetchBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 60000, headers: { 'User-Agent': 'NetScope-package/1.0' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        res.resume();
        resolve(fetchBuffer(new URL(res.headers.location, url).toString(), redirects + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} @ ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

/** 解析 tar（仅处理常规文件、目录与 pax 扩展头） */
function extractTar(buffer, destDir) {
  const files = [];
  let offset = 0;
  let paxPath = null;

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    // 全零块 = 归档结束
    let allZero = true;
    for (let i = 0; i < 512; i += 1) {
      if (header[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) break;

    const name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const sizeField = header.toString('utf8', 124, 136).replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeField, 8) || 0;
    const typeFlag = String.fromCharCode(header[156] || 48);
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
    let entryName = prefix ? `${prefix}/${name}` : name;
    if (paxPath) {
      entryName = paxPath;
      paxPath = null;
    }

    const dataStart = offset + 512;
    const dataEnd = dataStart + size;

    if (typeFlag === 'x') {
      // pax 扩展头：内容是 "len key=value\n" 文本形式，只取 path 覆盖下一条记录的文件名
      const text = buffer.toString('utf8', dataStart, dataEnd);
      const m = /(?:^|\n)\d+ path=([^\n]+)\n/.exec(text);
      if (m) paxPath = m[1];
    } else if (typeFlag === 'g') {
      // 全局 pax 头：与文件名无关，直接跳过（内容是二进制/文本混合，不能当路径解析）
    } else if (typeFlag === 'L') {
      // GNU longname：内容是下一条记录的文件名
      paxPath = buffer.toString('utf8', dataStart, dataEnd).replace(/\0.*$/, '');
    } else if (typeFlag === '0' || typeFlag === '\0') {
      // 去掉 npm 包的 "package/" 前缀
      const rel = entryName.replace(/^package\//, '');
      // 安全校验：路径必须可打印、不含控制字符、不越界
      const printable = !/[\u0000-\u001f\u007f]/.test(rel);
      const safe = rel && printable && !path.isAbsolute(rel) && !rel.split('/').includes('..');
      if (safe && !rel.endsWith('/')) {
        const target = path.join(destDir, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, buffer.subarray(dataStart, dataEnd));
        files.push(rel);
      }
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** 获取包的元数据（选一个可用 registry） */
async function fetchMeta(name) {
  const errors = [];
  for (const registry of REGISTRIES) {
    try {
      const raw = await fetchBuffer(`${registry}/${name.replace('/', '%2F')}`);
      return JSON.parse(raw.toString('utf8'));
    } catch (error) {
      errors.push(`${registry}: ${error.message}`);
    }
  }
  throw new Error(`无法获取 ${name} 的元数据（${errors.join('; ')}）`);
}

/** 拆出 main 版本号与预发布号：'1.0.0-alpha.6' → { main:[1,0,0], pre:'alpha.6' } */
function parseSemver(raw) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(raw));
  if (!m) return null;
  return { main: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' };
}

/** 从版本列表里挑选合适的版本（支持精确版本、^ 与 ~ 范围，预发布号按字符串比较） */
function pickVersion(versions, range) {
  const wanted = range ? String(range).trim().replace(/^[=v\s]+/, '') : '';

  // 精确指定（含预发布）时直接命中
  if (wanted && versions.includes(wanted)) return wanted;
  // 允许 "1.0.0-alpha.6" 与 "v1.0.0-alpha.6" 两种写法
  if (wanted) {
    const hit = versions.find((v) => v === wanted || v === 'v' + wanted);
    if (hit) return hit;
  }

  const parsed = versions
    .map((v) => ({ raw: v, ...(parseSemver(v) || {}) }))
    .filter((v) => v.main)
    .sort((a, b) => {
      const d = (b.main[0] - a.main[0]) || (b.main[1] - a.main[1]) || (b.main[2] - a.main[2]);
      if (d !== 0) return d;
      // 正式版优先于预发布版
      if (!a.pre && b.pre) return -1;
      if (a.pre && !b.pre) return 1;
      return String(b.pre).localeCompare(String(a.pre));
    });
  if (!parsed.length) return versions[versions.length - 1] || null;
  if (!wanted || wanted === '*' || wanted === 'latest') return parsed[0].raw;

  const caret = /^\^\s*(\d+)\.(\d+)\.(\d+)/.exec(wanted);
  if (caret) {
    const major = Number(caret[1]);
    // ^x.y.z：同一主版本内的最高正式版（忽略预发布，避免拿到 alpha/beta）
    const stable = parsed.find((v) => v.main[0] === major && !v.pre);
    return (stable || parsed.find((v) => v.main[0] === major) || parsed[0]).raw;
  }
  const tilde = /^~\s*(\d+)\.(\d+)\.(\d+)/.exec(wanted);
  if (tilde) {
    const major = Number(tilde[1]);
    const minor = Number(tilde[2]);
    const stable = parsed.find((v) => v.main[0] === major && v.main[1] === minor && !v.pre);
    return (stable || parsed.find((v) => v.main[0] === major && v.main[1] === minor) || parsed[0]).raw;
  }
  return parsed[0].raw;
}

/**
 * 安装一个包到 targetDir/node_modules/<name>
 * 递归处理一层 dependencies（扁平结构足够 npm 官方 CLI 使用）
 * @returns {Promise<object>} { name, version, files, installed }
 */
async function installPackage(name, targetDir, installed = new Set(), range = null) {
  const key = `${name}@${range || 'latest'}`;
  if (installed.has(key)) return { name, version: null, files: 0, installed: [...installed] };
  installed.add(key);

  const meta = await fetchMeta(name);
  const versions = Object.keys(meta.versions || {});
  const version = pickVersion(versions, range)
    || (meta['dist-tags'] && (meta['dist-tags'].latest || meta['dist-tags'].next));
  const info = meta.versions[version];
  if (!info) throw new Error(`${name} 找不到可用版本（请求范围 ${range || 'latest'}）`);

  const buf = await fetchBuffer(info.dist.tarball);
  const tar = zlib.gunzipSync(buf);
  const dest = path.join(targetDir, 'node_modules', name);
  fs.mkdirSync(dest, { recursive: true });
  const files = extractTar(tar, dest);
  if (process.env.NETSCOPE_DEBUG) {
    console.log(`   [debug] ${name}@${version}（请求 ${range || 'latest'}）: tar=${tar.length}B files=${files.length}`);
  }
  if (!files.length) throw new Error(`${name} 解包后没有任何文件（tarball 可能不是标准 tar.gz）`);

  for (const [dep, depRange] of Object.entries(info.dependencies || {})) {
    if (dep.startsWith('@types/')) continue;
    await installPackage(dep, targetDir, installed, depRange);
  }
  return { name, version, files: files.length, installed: [...installed] };
}

/** 找到已安装包的 bin 入口 */
function resolveBin(targetDir, name, binName) {
  const pkgFile = path.join(targetDir, 'node_modules', name, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  const rel = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin && pkg.bin[binName || name]);
  if (!rel) throw new Error(`${name} 没有可执行入口`);
  return path.join(targetDir, 'node_modules', name, rel);
}

module.exports = { installPackage, resolveBin, fetchBuffer, extractTar, pickVersion, parseSemver };

if (require.main === module) {
  (async () => {
    const target = path.resolve(__dirname, '..', 'build', 'tools');
    console.log('→ 安装 postject 到 ' + target + ' …');
    const info = await installPackage('postject', target, new Set(), '1.0.0-alpha.6');
    console.log('   postject ' + info.version + '（' + info.files + ' 个文件）');
    console.log('   依赖: ' + info.installed.filter((n) => !n.startsWith('postject@')).join(', '));
    const bin = resolveBin(target, 'postject', 'postject');
    console.log('   入口: ' + bin);
    const res = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8', windowsHide: true });
    console.log('   自检: ' + ((res.stdout || res.stderr || '').trim() || 'exit=' + res.status));
  })().catch((e) => { console.error('[错误] ' + e.message); process.exit(1); });
}
