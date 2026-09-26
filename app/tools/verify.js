#!/usr/bin/env node
/**
 * 私密日志 · 一键验证。
 *
 *     node tools/verify.js            # 全部检查
 *     node tools/verify.js --layout   # 只跑布局适配检查
 *     node tools/verify.js --e2e      # 只跑端到端交互测试
 *
 * 三块内容：
 *   1) 端到端交互测试 —— 把 tools/_e2e.js 注入 index.html 副本，在真实浏览器里
 *      点按钮、填表单、切页面，断言 DOM 与 localStorage（约 120 项）。
 *   2) 布局适配检查 —— 多种屏幕尺寸下查横向溢出、底栏遮挡、弹层可达性、
 *      触控目标高度、隐私锁键盘是否正圆且放得下。
 *   3) 汇总报告，任一项失败即以非 0 退出。
 *
 * 实现说明：走 CDP（Chrome DevTools Protocol）而不是 `--dump-dom`。
 * 新版 Edge（153+）的 `--dump-dom` / `--screenshot` 在无头模式下已经不输出任何东西
 * （连 about:blank 都拿不到），但 `--remote-debugging-port` 仍然正常，
 * 而且 CDP 能精确覆盖视口、执行任意 JS、断言真实几何，比 dump-dom 强。
 */
'use strict';

const path = require('path');
const { Browser, sleep } = require('./cdp');
const { build } = require('./build-tests');

const HERE = __dirname;
const APP = path.dirname(HERE);
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8777';

const args = process.argv.slice(2);
const onlyE2E = args.includes('--e2e');
const onlyLayout = args.includes('--layout');

/* ------------------------------------------------------------------ 布局测量 */

const LAYOUT_JS = `(async function(){
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  var vw = function(){ return window.innerWidth; };
  var vh = function(){ return window.innerHeight; };
  var R = {};

  R.vw = vw(); R.vh = vh();
  R.sw = document.documentElement.scrollWidth;

  // 元素是否处在可滚动祖先里（那种溢出是故意的，不算问题）
  function inScrollBox(el){
    var p = el.parentElement;
    while(p && p !== document.body){
      var ov = getComputedStyle(p).overflowX;
      if(ov === 'auto' || ov === 'scroll' || ov === 'hidden') return true;
      p = p.parentElement;
    }
    return false;
  }

  // 1) 横向溢出
  R.over = [];
  var all = document.querySelectorAll('body *');
  for(var i=0;i<all.length;i++){
    var e = all[i];
    if(!e.getClientRects().length) continue;
    var cs = getComputedStyle(e);
    if(cs.display === 'none' || cs.visibility === 'hidden') continue;
    var b = e.getBoundingClientRect();
    if(b.width > 0 && b.right > vw() + 1 && !inScrollBox(e)){
      R.over.push(e.tagName + '.' + String(e.className || '').split(' ')[0]);
    }
  }
  R.over = R.over.slice(0, 6);

  // 2) 日历 42 格、第 7 列不越界
  var cells = document.querySelectorAll('#calGrid .cell');
  R.cells = cells.length;
  R.col7 = cells.length >= 7 ? Math.round(cells[6].getBoundingClientRect().right) : -1;

  // 3) 底部悬浮导航
  R.tabsOk = true;
  var tabs = document.querySelectorAll('.tab');
  for(var t=0;t<tabs.length;t++){
    if(tabs[t].getBoundingClientRect().right > vw() + 1) R.tabsOk = false;
  }
  R.tbTop = Math.round(document.querySelector('.tabbar .inner').getBoundingClientRect().top);

  // 4) 触控目标高度（Android 建议 >= 44px）
  function hgt(s){ var e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().height) : -1; }
  R.touch = { add: hgt('.btn-add'), tab: hgt('.tab'), nav: hgt('.nav-btn'), rec: hgt('.rec-item'), chip: hgt('.chip') };

  // 5) 滚到底，看底栏有没有压住内容
  window.scrollTo(0, document.documentElement.scrollHeight);
  await sleep(220);
  var boxes = document.querySelectorAll('#view-calendar .card, #view-calendar .mini, #view-calendar .btn-add');
  var last = boxes[boxes.length - 1].getBoundingClientRect();
  R.gap = R.tbTop - Math.round(last.bottom);
  window.scrollTo(0, 0);

  // 6) 记录弹层：内容放不下时能否滚动到底、按钮能否点到
  document.getElementById('quickAdd').click();
  await sleep(260);
  var panel = document.querySelector('.sheet .panel');
  R.sheet = {
    sh: panel.scrollHeight, ch: panel.clientHeight,
    scrollable: panel.scrollHeight > panel.clientHeight + 1
  };
  panel.scrollTop = panel.scrollHeight;
  await sleep(140);
  var act = document.querySelector('.sheet-actions').getBoundingClientRect();
  R.sheet.actVisible = act.bottom <= vh() + 1 && act.top >= -1;
  document.getElementById('editCancel').click();
  await sleep(160);

  // 7) 隐私锁：键盘是否正圆、是否放得下
  document.getElementById('swPin').click();
  await sleep(260);
  var kp = document.getElementById('keypad').getBoundingClientRect();
  var btn = document.querySelector('#keypad button');
  var bb = btn.getBoundingClientRect();
  var bs = getComputedStyle(btn);
  var br = bs.borderTopLeftRadius;
  var radPx = br.indexOf('%') >= 0 ? parseFloat(br) / 100 * Math.min(bb.width, bb.height) : parseFloat(br);
  var ratio = bb.width / bb.height;
  R.lock = {
    top: Math.round(kp.top), bottom: Math.round(kp.bottom),
    fits: kp.bottom <= vh() + 1 && kp.top >= -1,
    btnW: +bb.width.toFixed(2), btnH: +bb.height.toFixed(2),
    ratio: +ratio.toFixed(4), radius: br,
    circle: Math.abs(ratio - 1) < 0.01 && Math.abs(radPx * 2 - Math.min(bb.width, bb.height)) < 1.5,
    btnCount: document.querySelectorAll('#keypad button').length,
    dotsTop: Math.round(document.querySelector('.pin-dots').getBoundingClientRect().top)
  };
  return R;
})()`;

const VIEWPORTS = [
  [320, 568, 'iPhone SE 一代'],
  [360, 640, '16:9 基准'],
  [360, 780, '长屏安卓'],
  [375, 667, 'iPhone 8'],
  [390, 844, 'iPhone 14'],
  [412, 915, 'Pixel 7'],
  [430, 932, 'iPhone 15 Pro Max'],
  [600, 900, '平板'],
  [768, 1024, 'iPad 竖屏'],
  [640, 360, '安卓横屏'],
  [900, 420, '手机横屏'],
  [1280, 720, '桌面宽屏'],
];

function judgeLayout(d) {
  const p = [];
  if (d.sw > d.vw) p.push(`页面横向溢出 scrollWidth ${d.sw} > ${d.vw}`);
  if (d.over.length) p.push('越界元素 ' + d.over.join(','));
  if (d.cells !== 42) p.push(`日历格子数 ${d.cells}（应为 42）`);
  if (d.col7 > d.vw) p.push('日历第 7 列越界');
  if (!d.tabsOk) p.push('底部导航越界');
  if (d.gap < 0) p.push(`底栏遮挡内容 ${-d.gap}px`);
  if (!d.sheet.actVisible) p.push('弹层操作按钮不可见');
  if (!d.lock.fits) p.push('隐私锁键盘溢出屏幕');
  if (!d.lock.circle) p.push(`隐私锁按键不是正圆（${d.lock.btnW}×${d.lock.btnH} 比例 ${d.lock.ratio}）`);
  if (d.lock.btnCount !== 12) p.push(`键盘按键数 ${d.lock.btnCount}（应为 12）`);
  if (d.touch.add > 0 && d.touch.add < 44) p.push(`主按钮过小 ${d.touch.add}px`);
  if (d.touch.nav > 0 && d.touch.nav < 32) p.push(`月份箭头过小 ${d.touch.nav}px`);
  return p;
}

/* ------------------------------------------------------------------ 主流程 */

/* 同步睡眠：Atomics.wait 是 Node 里唯一干净的同步 sleep 办法 */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch (e) { /* 环境不支持就干脆不睡 */ }
}

(async () => {
  // 重建测试页（_e2e.html / _demo*.html）—— 进程内调用，不起子进程
  const b = build();
  console.log('built ' + b.written.join(', '));
  console.log('demo data: ' + b.days + ' days, ' + b.records + ' records');
  console.log('');

  const browser = await Browser.launch({});
  console.log('浏览器:', browser.cdp.browserVersion);
  console.log('地址:  ', BASE);
  console.log('');

  let failed = 0;

  /* ---------- 1) 端到端交互测试 ---------- */
  if (!onlyLayout) {
    console.log('=== 端到端交互测试 ===');
    const page = await browser.newPage();
    await page.setViewport(390, 844, true);
    await page.goto(BASE + '/tools/_e2e.html', 0);

    let res = null;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      res = await page.eval(`(function(){
        var el = document.getElementById('TESTRESULT');
        return el ? el.textContent : null;
      })()`);
      if (res) break;
    }

    if (!res) {
      console.log('  !! 测试未产出结果（页面可能报错）');
      failed++;
    } else {
      const lines = res.split('\n');
      const summary = lines[0] || '';
      let pass = 0, fail = 0;
      const fails = [];
      for (const l of lines.slice(1)) {
        const c = l.split('|');
        if (c[0] === 'PASS') pass++;
        else if (c[0] === 'FAIL') { fail++; fails.push(c[1] + '   ' + (c[2] || '')); }
        else if (c[0] === 'EXCEPTION') { fail++; fails.push('异常: ' + c[1]); }
      }
      console.log('  ' + summary.replace('SUMMARY|', ''));
      if (fails.length) {
        console.log('  失败项:');
        for (const f of fails) console.log('    ✗ ' + f);
      } else {
        console.log('  ✓ 全部通过');
      }
      failed += fail;
    }
    console.log('');
  }

  /* ---------- 2) 布局适配检查 ---------- */
  if (!onlyE2E) {
    console.log('=== 布局适配检查 ===');
    const page = await browser.newPage();
    for (const [w, h, label] of VIEWPORTS) {
      await page.setViewport(w, h, true);
      await page.goto(BASE + '/tools/_demo-plain.html', 220);
      let d;
      try {
        d = await page.eval(LAYOUT_JS);
      } catch (e) {
        console.log(`  FAIL ${w}x${h} ${label}  !! ${e.message}`);
        failed++;
        continue;
      }
      const problems = judgeLayout(d);
      if (problems.length) failed++;
      console.log(
        (problems.length ? '  FAIL ' : '  OK   ') +
        `${String(w).padStart(4)}x${String(h).padEnd(5)} ${label.padEnd(18)}` +
        ` 按键 ${(d.lock.btnW + '×' + d.lock.btnH).padEnd(15)}` +
        ` 圆 ${d.lock.circle ? '是' : '否'}` +
        ` 底栏余量 ${String(d.gap).padStart(4)}px` +
        ` 弹层按钮 ${d.sheet.actVisible ? '可见' : '不可见'}`
      );
      if (problems.length) console.log('         ' + problems.join('; '));
    }
    console.log('');
  }

  browser.close();

  console.log('='.repeat(58));
  if (failed === 0) {
    console.log('全部通过');
  } else {
    console.log(`存在问题：${failed} 项`);
  }
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('验证失败:', e.message); process.exit(2); });
