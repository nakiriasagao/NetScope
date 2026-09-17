'use strict';

/**
 * GitHub API 上传器
 *
 * 背景：本机网络可以访问 api.github.com，但 github.com 的 HTTPS 被中途阻断
 * （首页超时、裸 IP 直连被 RST），导致 git push 无法完成。
 * 因此这里改用 GitHub REST API 逐个文件上传，效果等价于推送这些文件内容。
 *
 * 用法：
 *   node tools/publish-github-api.js                 # 上传工作区中所有 git 跟踪文件
 *   node tools/publish-github-api.js --dry-run       # 只列出将要上传的文件
 *   node tools/publish-github-api.js --message "..." # 自定义提交信息
 *
 * 凭据来源：Windows 凭据管理器中的 GitHub OAuth Token（由 Git Credential Manager 保存）。
 *           也可用环境变量 GITHUB_TOKEN 覆盖。
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OWNER = process.env.GH_OWNER || 'nakiriasagao';
const REPO = process.env.GH_REPO || 'webtraceor';
const BRANCH = process.env.GH_BRANCH || 'main';
const API = 'https://api.github.com';

const DRY_RUN = process.argv.includes('--dry-run');
const MESSAGE_ARG_INDEX = process.argv.indexOf('--message');
const COMMIT_MESSAGE =
  MESSAGE_ARG_INDEX > -1 && process.argv[MESSAGE_ARG_INDEX + 1]
    ? process.argv[MESSAGE_ARG_INDEX + 1]
    : 'feat: 接入高德地图底图，新增局域网设备发现与星型拓扑图（经 GitHub API 上传）';

/* ------------------------------------------------------------------ */
/* 凭据                                                                */
/* ------------------------------------------------------------------ */

const PS_READ_CRED = `
$ErrorActionPreference='Stop'
$sig = @'
using System;
using System.Runtime.InteropServices;
public class CredApi2 {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags; public uint Type; public IntPtr TargetName; public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
    public uint AttributeCount; public IntPtr Attributes; public IntPtr TargetAlias; public IntPtr UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credentialPtr);
  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr buffer);
}
'@
Add-Type -TypeDefinition $sig -Language CSharp | Out-Null
$ptr = [IntPtr]::Zero
if ([CredApi2]::CredReadW('git:https://github.com', 1, 0, [ref]$ptr)) {
  $cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][CredApi2+CREDENTIAL])
  $bytes = New-Object byte[] $cred.CredentialBlobSize
  [System.Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $cred.CredentialBlobSize)
  $secret = [System.Text.Encoding]::Unicode.GetString($bytes)
  Write-Output $secret
  [CredApi2]::CredFree($ptr)
}
`;

function readToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_READ_CRED], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
  });
  const token = (res.stdout || '').trim();
  if (!token) throw new Error('无法从凭据管理器读取 GitHub Token，请设置环境变量 GITHUB_TOKEN');
  return token;
}

/* ------------------------------------------------------------------ */
/* API 封装                                                            */
/* ------------------------------------------------------------------ */

function makeClient(token) {
  return async function api(method, endpoint, body) {
    const url = endpoint.startsWith('http') ? endpoint : API + endpoint;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120000);
      try {
        const res = await fetch(url, {
          method,
          signal: controller.signal,
          headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'NetScope-publisher',
            'X-GitHub-Api-Version': '2022-11-28',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch (_) {
          json = { raw: text.slice(0, 300) };
        }
        if (res.ok) return json;
        // 5xx 或限流时重试
        if (res.status >= 500 || res.status === 429) {
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, 1500 * attempt));
            continue;
          }
        }
        const message = json && json.message ? json.message : `HTTP ${res.status}`;
        throw new Error(`${method} ${endpoint} → ${res.status} ${message}`);
      } catch (error) {
        if (attempt >= 3) throw error;
        await new Promise((r) => setTimeout(r, 1200 * attempt));
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error('请求失败');
  };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

function listTrackedFiles() {
  const res = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (res.status !== 0) throw new Error('git ls-files 执行失败：' + (res.stderr || '').slice(0, 200));
  return res.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

function detectBinary(buffer) {
  const sample = buffer.subarray(0, 8000);
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] === 0) return true;
  }
  return false;
}

(async () => {
  console.log('=== GitHub API 上传 ===');
  console.log(`仓库：https://github.com/${OWNER}/${REPO}（分支 ${BRANCH}）`);

  const token = readToken();
  const api = makeClient(token);

  const user = await api('GET', '/user');
  console.log(`✔ 已认证：${user.login}（${user.name || '未设置姓名'}）`);

  const repo = await api('GET', `/repos/${OWNER}/${REPO}`);
  console.log(`✔ 仓库可访问：${repo.full_name}，默认分支 ${repo.default_branch}，权限 ${repo.permissions ? JSON.stringify(repo.permissions) : '未知'}`);

  // 分支引用（新仓库可能还没有 main）
  let baseSha = null;
  try {
    const ref = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
    baseSha = ref.object.sha;
    console.log(`✔ 分支 ${BRANCH} 当前提交：${baseSha.slice(0, 8)}`);
  } catch (error) {
    console.log(`! 分支 ${BRANCH} 不存在（${error.message}），将创建初始提交`);
  }

  const files = listTrackedFiles();
  console.log(`\n待上传文件：${files.length} 个`);

  // 清理远端已不再跟踪的文件（例如被重命名/删除的旧文件），保持仓库与工作区一致
  const wanted = new Set(files);
  const remoteTree = await api('GET', `/repos/${OWNER}/${REPO}/git/trees/${BRANCH}?recursive=1`).catch(() => null);
  const stale = [];
  if (remoteTree && Array.isArray(remoteTree.tree)) {
    for (const entry of remoteTree.tree) {
      if (entry.type !== 'blob') continue;
      if (entry.path.startsWith('.github/')) continue; // 不动 CI 配置
      if (!wanted.has(entry.path)) stale.push(entry.path);
    }
  }
  if (stale.length) {
    console.log(`远端有 ${stale.length} 个本地已删除的文件，将一并清理：`);
    stale.forEach((s) => console.log('  - ' + s));
  }
  if (DRY_RUN) {
    files.forEach((f) => console.log('  ' + f));
    console.log('\n--dry-run 结束');
    return;
  }

  for (const rel of stale) {
    try {
      const existing = await api('GET', `/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(rel)}?ref=${BRANCH}`);
      await api('DELETE', `/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(rel)}`, {
        message: `chore: 删除已不再使用的文件 ${rel}\n\n${COMMIT_MESSAGE}`,
        sha: existing.sha,
        branch: BRANCH,
      });
      console.log(`  🗑  已删除 ${rel}`);
    } catch (error) {
      console.log(`  ✘ 删除 ${rel} 失败 → ${error.message}`);
    }
  }

  let uploaded = 0;
  let skipped = 0;
  const failures = [];

  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      skipped += 1;
      console.log(`  ⊘ 跳过（文件不存在）：${rel}`);
      continue;
    }
    const buffer = fs.readFileSync(abs);
    const binary = detectBinary(buffer);
    const content = buffer.toString('base64');

    // 取该文件当前 sha（存在则更新，不存在则新建）
    let sha = null;
    try {
      const existing = await api('GET', `/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(rel)}?ref=${BRANCH}`);
      sha = existing && existing.sha ? existing.sha : null;
    } catch (_) {
      sha = null;
    }

    if (sha) {
      // 内容未变则不必提交
      // 注意：GitHub Contents API 返回的 content 是**按行折行**的 base64，
      // 且换行符可能被规范化，因此这里同时比较"去除空白后的 base64"与"原始字节"两种口径，
      // 只在确实不同时才提交，避免把未变化的文件重复提交（或反过来漏提交）。
      try {
        const current = await api('GET', `/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(rel)}?ref=${BRANCH}`);
        if (current && current.content) {
          const remoteRaw = String(current.content).replace(/\s/g, '');
          const localRaw = buffer.toString('base64');
          if (remoteRaw === localRaw) {
            skipped += 1;
            continue;
          }
          const remote = Buffer.from(remoteRaw, 'base64');
          // 文本文件比较时忽略行尾差异（CRLF / LF），避免仅因换行导致重复提交
          const isText = !binary;
          const normalize = (buf) => buf.toString('utf8').replace(/\r\n/g, '\n');
          if (isText ? normalize(remote) === normalize(buffer) : remote.equals(buffer)) {
            skipped += 1;
            continue;
          }
        }
      } catch (_) {
        /* 比对失败则继续上传 */
      }
    }

    try {
      await api('PUT', `/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(rel)}`, {
        message: `${COMMIT_MESSAGE}\n\n[${rel}]`,
        content,
        branch: BRANCH,
        ...(sha ? { sha } : {}),
      });
      uploaded += 1;
      const size = binary ? `${(buffer.length / 1024).toFixed(0)}KB` : `${buffer.length}B`;
      console.log(`  ✔ ${rel}（${size}）`);
    } catch (error) {
      failures.push({ rel, error: error.message });
      console.log(`  ✘ ${rel} → ${error.message}`);
    }
  }

  console.log('\n================ 结果 ================');
  console.log(`已上传/更新：${uploaded} 个（另有 ${skipped} 个内容相同或缺失，跳过）`);
  if (failures.length) {
    console.log(`失败：${failures.length} 个`);
    failures.forEach((f) => console.log(`  ✘ ${f.rel} → ${f.error}`));
  }

  const branchInfo = await api('GET', `/repos/${OWNER}/${REPO}/branches/${BRANCH}`).catch(() => null);
  if (branchInfo && branchInfo.commit) {
    console.log(`\n分支 ${BRANCH} 最新提交：${branchInfo.commit.sha.slice(0, 8)} ${branchInfo.commit.commit.message.split('\n')[0]}`);
  }
  console.log(`仓库地址：https://github.com/${OWNER}/${REPO}`);
  process.exitCode = failures.length ? 1 : 0;
})().catch((error) => {
  console.error('\n✘ 上传失败：' + error.message);
  process.exitCode = 1;
});
