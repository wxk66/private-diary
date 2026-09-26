/**
 * 极简 Chrome DevTools Protocol 客户端。
 *
 * 为什么需要它：新版 Edge（153+）的 `--dump-dom` / `--screenshot` 在无头模式下
 * 已经不再向 stdout 输出任何东西（即使是 about:blank），但 `--remote-debugging-port`
 * 仍然可用。所以改成：后台起一个带调试端口的无头浏览器，用 CDP 驱动它。
 *
 * 好处不只是"能用了"——CDP 还能精确覆盖视口尺寸（不再受 --window-size 被忽略的困扰）、
 * 执行任意 JS 并取回结果、截取任意区域，比 --dump-dom 强得多。
 *
 * 只用 Node 22+ 自带的全局 WebSocket，无第三方依赖。
 */
'use strict';

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function findBrowser() {
  for (const p of BROWSER_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch (e) { /* ignore */ }
  }
  throw new Error('找不到 Edge / Chrome，请把路径加到 BROWSER_CANDIDATES');
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('HTTP 超时: ' + url)); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this._id = 0;
    this._pending = new Map();
    this._listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null) {
        const p = this._pending.get(msg.id);
        if (!p) return;
        this._pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      } else if (msg.method) {
        const fns = this._listeners.get(msg.method) || [];
        for (const fn of fns) { try { fn(msg.params); } catch (e) { /* ignore */ } }
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
    });
    return new CDP(ws);
  }

  send(method, params) {
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  on(method, fn) {
    if (!this._listeners.has(method)) this._listeners.set(method, []);
    this._listeners.get(method).push(fn);
  }

  once(method, timeoutMs) {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), timeoutMs || 15000);
      const fn = (params) => {
        clearTimeout(t);
        const arr = this._listeners.get(method) || [];
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
        resolve(params);
      };
      this.on(method, fn);
    });
  }

  /** 在当前页面求值，返回 JS 的值（对象会按值序列化） */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('页面 JS 异常: ' + (d.exception && d.exception.description || d.text));
    }
    return r.result.value;
  }

  async setViewport(width, height, mobile) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width, height,
      deviceScaleFactor: 1,
      mobile: mobile !== false,
    });
  }

  async goto(url, waitMs) {
    const loaded = this.once('Page.loadEventFired', 15000);
    await this.send('Page.navigate', { url });
    await loaded;
    if (waitMs) await sleep(waitMs);
  }

  /**
   * 截图。默认 captureBeyondViewport:false —— 开启它会让 Chromium 把视口临时撑到
   * 整页高度，既会触发不同的媒体查询（截图与真实布局不符），又会让 position:fixed
   * 的元素只覆盖原视口，底下露出页面内容。视口高度我们自己控制，不需要它。
   */
  async screenshot(file, opts) {
    const r = await this.send('Page.captureScreenshot', Object.assign(
      { format: 'png', captureBeyondViewport: false }, opts || {}));
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }

  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

class Browser {
  constructor(proc, cdp, port) {
    this.proc = proc;
    this.cdp = cdp;
    this.port = port;
  }

  static async launch(opts) {
    opts = opts || {};
    const port = opts.port || (9200 + Math.floor(Math.random() * 300));
    const exe = findBrowser();
    // 每次用唯一目录：复用同名目录时，上一轮残留的浏览器进程会锁住
    // CrashpadMetrics-active.pma 之类的文件，rmSync 直接抛 EBUSY
    const profile = path.join(os.tmpdir(), 'dyf-cdp-' + port + '-' + Date.now().toString(36));
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 新目录，删不掉也无所谓 */ }

    const args = [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-crash-reporter',
      '--disable-breakpad',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--user-data-dir=' + profile,
      '--remote-debugging-port=' + port,
      'about:blank',
    ];
    const proc = spawn(exe, args, { stdio: 'ignore', detached: false });

    // 等调试端口就绪
    let ver = null;
    for (let i = 0; i < 60; i++) {
      try {
        ver = JSON.parse(await httpGet(`http://127.0.0.1:${port}/json/version`));
        break;
      } catch (e) { await sleep(250); }
    }
    if (!ver) { try { proc.kill(); } catch (e) {} throw new Error('浏览器调试端口未就绪'); }

    const list = JSON.parse(await httpGet(`http://127.0.0.1:${port}/json/list`));
    const page = list.find((t) => t.type === 'page');
    if (!page) { try { proc.kill(); } catch (e) {} throw new Error('没有可用的 page target'); }

    const cdp = await CDP.connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    cdp.browserVersion = ver.Browser;

    const b = new Browser(proc, cdp, port);
    b.profile = profile;
    return b;
  }

  /**
   * 复用同一个 page target（默认就是 launch 时那个 about:blank）。
   * 注意：新版 Chromium 的 `/json/new` 只接受 PUT，GET 会返回一段纯文本
   * （"Using unsafe HTTP verb GET to invoke /json/new..."），JSON.parse 直接炸。
   * 所以这里不做新建，只导航，既快又避开那个坑。
   */
  async newPage(url) {
    const cdp = this.cdp;
    if (url) await cdp.goto(url);
    return cdp;
  }

  close() {
    try { this.cdp.close(); } catch (e) { /* ignore */ }
    try { this.proc.kill(); } catch (e) { /* ignore */ }
    // 临时配置目录删不掉就留着，系统会回收；千万不要因为清理失败而让整个脚本崩掉
    if (this.profile) {
      try { fs.rmSync(this.profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
  }
}

module.exports = { Browser, CDP, findBrowser, httpGet, sleep };
