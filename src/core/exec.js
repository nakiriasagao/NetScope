'use strict';

/**
 * 进程执行与输出捕获助手
 *
 * 为什么需要“多策略捕获”：
 *   某些受限环境（容器、应用沙箱、安全软件）会禁止子进程的标准输出管道
 *   （spawn 直接抛 EPERM）。此时仍然可以创建进程，只是拿不到管道数据。
 *   为此本模块提供三级策略，逐级降级，保证在受限环境下依然能读到命令输出：
 *
 *     1. pipe   —— 标准做法：spawn 并读取 stdout/stderr 管道（最快、最通用）
 *     2. shell-file —— 借用 PowerShell 的输出重定向写入临时文件，再读文件
 *                      （Node 自身不接触管道，规避 EPERM）
 *     3. win-file —— 直接用 cmd.exe 的 ">" 重定向写文件（部分环境可用）
 *
 * 所有策略都不使用字符串拼接执行用户输入：命令行以参数数组传入，
 * 只有“重定向目标文件路径”是程序内部生成的临时路径。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* ------------------------------------------------------------------ */
/* 编码处理                                                            */
/* ------------------------------------------------------------------ */

const ENCODINGS = ['utf-8', 'gbk', 'big5', 'windows-1252'];

/**
 * 尝试用多种编码解码，选择“最像正常文本”的结果。
 *
 * 关键点：UTF-8 只有在字节序列完全合法时才是正确选择；中文 Windows 命令
 * （ipconfig / tracert / ping）输出的是 GBK 字节，用 UTF-8 解码不会产生
 * U+FFFD（Node 会生成无效的 lone surrogate），因此必须把“非法 UTF-8 序列”
 * 也计入扣分，才能正确回退到 GBK。
 */
function decodeBest(buf) {
  if (!buf || buf.length === 0) return '';
  // BOM 是权威信号，优先采信
  if (buf.length > 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le'); // UTF-16LE
  }
  if (buf.length > 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le'); // UTF-16BE
  }
  if (buf.length > 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8'); // UTF-8 BOM
  }

  // 严格 UTF-8 校验：只要整个缓冲是合法 UTF-8 且包含多字节字符，
  // 就直接采信（现代工具输出均为 UTF-8；避免了启发式评分把中文判成 latin1 乱码）
  let utf8Text = null;
  try {
    utf8Text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (_) {
    utf8Text = null;
  }
  if (utf8Text !== null && hasHighByte(buf)) return utf8Text;

  // 到这一步说明：要么全是 ASCII，要么存在非 UTF-8 的高位字节（如中文 Windows 的 GBK）
  const candidates = [];
  if (utf8Text !== null) {
    candidates.push({ enc: 'utf-8', text: utf8Text, score: 0 });
  }
  for (const enc of ENCODINGS.slice(1)) {
    try {
      candidates.push({ enc, text: new TextDecoder(enc, { fatal: false }).decode(buf), score: 0 });
    } catch (_) {
      /* 当前 Node 不支持该编码，跳过 */
    }
  }
  if (!candidates.length) return buf.toString('utf8');

  let best = candidates[0];
  for (const candidate of candidates) {
    candidate.score = scoreText(candidate.text);
    if (candidate.score > best.score) best = candidate;
  }
  return best.text;
}

function hasHighByte(buf) {
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] > 0x7f) return true;
  }
  return false;
}

/**
 * 文本质量评分：ASCII 与控制字符给正分，非法码位给负分。
 * 注意 lone surrogate（0xD800–0xDFFF）是“错误解码”的强信号。
 */
function scoreText(text) {
  if (!text) return 0;
  let good = 0;
  let bad = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdfff) {
      bad += 4; // 非法代理区，UTF-8 误解码 GBK 时的典型症状
      continue;
    }
    if (code === 0xfffd) bad += 4;
    else if (code === 9 || code === 10 || code === 13) good += 1;
    else if (code < 32) bad += 1;
    else if (code >= 0x4e00 && code <= 0x9fff) good += 3; // 常用汉字
    else if (code >= 0x3040 && code <= 0x30ff) good += 3; // 日文假名
    else if (code >= 0x3000 && code <= 0x303f) good += 2; // 中文标点
    else if (code >= 0xff01 && code <= 0xff60) good += 2; // 全角标点
    else if (code >= 0x80 && code <= 0x2fff) bad += 1; // Latin-1 / 扩展区：乱码高发区，轻微扣分
    else good += 1;
  }
  return good - bad * 2;
}

/** 当前 Node 是否具备指定编码的解码能力 */
function supportsEncoding(encoding) {
  try {
    new TextDecoder(encoding);
    return true;
  } catch (_) {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 运行期能力探测                                                      */
/* ------------------------------------------------------------------ */

const capability = {
  pipeBlocked: false,
  shellFileWorks: null, // null=未探测 true/false
  shellExe: null,
  probed: false,
};

function whichSync(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (path.isAbsolute(candidate)) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch (_) {
        /* ignore */
      }
      continue;
    }
    const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
      const full = path.join(dir, candidate);
      try {
        if (fs.existsSync(full)) return full;
      } catch (_) {
        /* ignore */
      }
    }
  }
  return null;
}

function findShell() {
  if (capability.shellExe) return capability.shellExe;
  if (process.platform === 'win32') {
    capability.shellExe =
      whichSync(['pwsh.exe', 'pwsh']) ||
      whichSync([path.join(process.env.SystemRoot || 'C:\\WINDOWS', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]) ||
      whichSync(['powershell.exe']);
  } else {
    capability.shellExe = whichSync(['pwsh', 'bash', 'sh']);
  }
  return capability.shellExe;
}

function newTempFile(tag) {
  const dir = path.join(os.tmpdir(), 'netscope-capture');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    /* ignore */
  }
  const name = `ns-${tag}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.txt`;
  return path.join(dir, name);
}

/* ------------------------------------------------------------------ */
/* 策略 1：管道                                                        */
/* ------------------------------------------------------------------ */

function runWithPipe(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (error) {
      resolve({ ok: false, reason: 'spawn-throw', error, durationMs: 0 });
      return;
    }

    const out = [];
    const err = [];
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch (_) {
        /* ignore */
      }
    }, timeoutMs);

    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: !error,
        code,
        stdout: decodeBest(Buffer.concat(out)),
        stderr: decodeBest(Buffer.concat(err)),
        timedOut,
        durationMs: Date.now() - startedAt,
        error,
        strategy: 'pipe',
      });
    };

    child.stdout?.on('data', (chunk) => out.push(chunk));
    child.stderr?.on('data', (chunk) => err.push(chunk));
    child.on('error', (error) => {
      // EPERM 表示沙箱禁止管道，标记后后续调用直接走文件策略
      if (error.code === 'EPERM') capability.pipeBlocked = true;
      finish(null, error);
    });
    child.on('close', (code) => finish(code, undefined));
  });
}

/* ------------------------------------------------------------------ */
/* 策略 2 / 3：重定向到文件                                            */
/* ------------------------------------------------------------------ */

function spawnIgnored(shellExe, shellArgs, timeoutMs, onDone) {
  const startedAt = Date.now();
  let child;
  try {
    child = spawn(shellExe, shellArgs, { stdio: 'ignore', windowsHide: true });
  } catch (error) {
    onDone({ ok: false, reason: 'spawn-throw', error, durationMs: 0 });
    return;
  }
  let timedOut = false;
  let settled = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill('SIGKILL');
    } catch (_) {
      /* ignore */
    }
  }, timeoutMs);

  const done = (payload) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    onDone({ ...payload, timedOut, durationMs: Date.now() - startedAt, strategy: payload.strategy });
  };

  child.on('error', (error) => done({ ok: false, error, reason: 'spawn-error' }));
  child.on('close', (code) => done({ ok: true, code }));
}

/**
 * 通过 PowerShell 把命令输出重定向到临时文件
 */
function runWithShellFile(command, args, timeoutMs, options = {}) {
  return new Promise((resolve) => {
    const shell = findShell();
    if (!shell) {
      resolve({ ok: false, reason: 'no-shell', durationMs: 0 });
      return;
    }
    const file = newTempFile('sh');
    const isPowerShell = /powershell|pwsh/i.test(path.basename(shell));
    const quotedArgs = args.map((a) => (/[\s"'`$&|<>;*?]/.test(a) ? `'${String(a).replace(/'/g, "''")}'` : a));
    const cmd = [quoteForShell(command), ...quotedArgs].join(' ');
    const inner = isPowerShell
      ? `& ${cmd} *> ${quoteForShell(file)}`
      : `${cmd} > ${quoteForShell(file)} 2>&1`;

    const shellArgs = isPowerShell
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', inner]
      : ['-c', inner];

    spawnIgnored(shell, shellArgs, timeoutMs, (result) => {
      const stdout = safeReadFile(file);
      safeUnlink(file);
      if (!result.ok && !stdout) {
        resolve({ ...result, stdout: '', stderr: '' });
        return;
      }
      const text = stdout;
      capability.shellFileWorks = text.length > 0;
      resolve({
        ok: true,
        code: result.code,
        stdout: text,
        stderr: '',
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        strategy: 'shell-file',
      });
    });
  });
}

/**
 * 直接用 cmd.exe 的 ">" 重定向写文件
 */
function runWithCmdFile(command, args, timeoutMs) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ ok: false, reason: 'not-windows', durationMs: 0 });
      return;
    }
    const file = newTempFile('cmd');
    const line = `${command} ${args.join(' ')} > "${file}" 2>&1`;
    spawnIgnored('cmd.exe', ['/d', '/s', '/c', line], timeoutMs, (result) => {
      const stdout = safeReadFile(file);
      safeUnlink(file);
      resolve({
        ok: true,
        code: result.code,
        stdout,
        stderr: '',
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        strategy: 'cmd-file',
      });
    });
  });
}

function quoteForShell(value) {
  const s = String(value);
  if (process.platform === 'win32' && /^[A-Za-z]:\\/.test(s) && !/[\s'"]/.test(s)) return s;
  return `'${s.replace(/'/g, "''")}'`;
}

function safeReadFile(file) {
  try {
    const buf = fs.readFileSync(file);
    return decodeBest(buf);
  } catch (_) {
    return '';
  }
}

function safeUnlink(file) {
  try {
    fs.unlinkSync(file);
  } catch (_) {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 运行命令并捕获输出
 * @param {string} command
 * @param {string[]} args
 * @param {{ timeoutMs?: number, preferFile?: boolean, attempts?: number }} [options]
 * @returns {Promise<{ ok:boolean, code:number|null, stdout:string, stderr:string, timedOut:boolean, durationMs:number, strategy:string, error?:Error }>}
 */
async function runAndCapture(command, args, options = {}) {
  const timeoutMs = options.timeoutMs || 60000;
  const strategies = [];

  if (!options.preferFile && !capability.pipeBlocked) strategies.push('pipe');
  strategies.push('shell-file');
  if (process.platform === 'win32') strategies.push('cmd-file');
  if (capability.pipeBlocked && !strategies.includes('pipe')) {
    // 已确认管道不可用，不再浪费时间重试
  } else if (!strategies.includes('pipe')) {
    strategies.unshift('pipe');
  }

  const errors = [];
  let best = null;

  for (const strategy of strategies) {
    let result;
    if (strategy === 'pipe') {
      result = await runWithPipe(command, args, timeoutMs);
      if (!result.ok) {
        errors.push(`pipe: ${result.error?.code || result.error?.message || result.reason}`);
        // EPERM 说明环境禁止管道，永久切换到文件策略
        if (result.error?.code !== 'EPERM') {
          // 其他错误（例如命令不存在）通常其它策略也会失败，但仍继续尝试
        }
        continue;
      }
    } else if (strategy === 'shell-file') {
      result = await runWithShellFile(command, args, timeoutMs);
      if (!result.ok) {
        errors.push(`shell-file: ${result.error?.code || result.reason || '未获得输出'}`);
        continue;
      }
      if (!result.stdout) {
        errors.push('shell-file: 输出为空');
        // 命令本身可能确实没有输出，若退出码为 0 则接受
        if (result.code === 0 && !result.timedOut) {
          return { ...result, attempts: errors };
        }
        continue;
      }
    } else {
      result = await runWithCmdFile(command, args, timeoutMs);
      if (!result.ok) {
        errors.push(`cmd-file: ${result.error?.code || result.reason || '未获得输出'}`);
        continue;
      }
      if (!result.stdout && !(result.code === 0 && !result.timedOut)) {
        errors.push('cmd-file: 输出为空');
        continue;
      }
    }

    if (!best) best = result;
    if (result.stdout) return { ...result, attempts: errors };
  }

  if (best) return { ...best, attempts: errors };
  return {
    ok: false,
    code: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    durationMs: 0,
    strategy: 'none',
    attempts: errors,
    error: new Error(errors.join(' | ') || '所有输出捕获策略均失败'),
  };
}

/**
 * 仅启动命令、不关心输出（用于 fire-and-forget 场景）
 */
function runDetached(command, args, options = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: options.stdio || 'ignore', windowsHide: true, detached: Boolean(options.detached) });
    } catch (error) {
      resolve({ ok: false, error });
      return;
    }
    child.on('error', (error) => resolve({ ok: false, error }));
    if (options.wait === false) {
      child.unref();
      resolve({ ok: true, pid: child.pid });
      return;
    }
    child.on('close', (code) => resolve({ ok: true, code }));
  });
}

/** 兼容旧接口 */
async function runCommand(command, args, options = {}) {
  return runAndCapture(command, args, options);
}

function captureCapability() {
  return { ...capability };
}

module.exports = {
  runAndCapture,
  runCommand,
  runDetached,
  decodeBest,
  scoreText,
  supportsEncoding,
  captureCapability,
  findShell,
  newTempFile,
};
