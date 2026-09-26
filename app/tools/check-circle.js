/**
 * 隐私锁键盘「圆盘」形状检查。
 *
 * 历史上这里出过一个 bug：`.keypad button` 写的是 `height:64px; border-radius:50%`，
 * 但 3 列网格在 272px 容器下每列约 81px 宽 —— 宽 81 高 64 配 50% 圆角，渲染出来是**椭圆**。
 * 这个脚本在真实浏览器里量按钮的实际宽高比和圆角，覆盖各种屏幕尺寸与宽高比。
 *
 *     node tools/check-circle.js
 */
'use strict';

const path = require('path');
const { Browser, sleep } = require('./cdp');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8777';
const PORT = parseInt(process.env.CDP_PORT || '0', 10) || undefined;

// 覆盖：极窄、常见手机、大屏手机、平板、横屏、桌面
const SIZES = [
  [320, 480, '极窄小屏'],
  [320, 568, 'iPhone SE 一代'],
  [360, 640, '小屏安卓'],
  [360, 780, '长屏安卓'],
  [375, 667, 'iPhone 8'],
  [390, 844, 'iPhone 14'],
  [412, 915, 'Pixel 7'],
  [430, 932, 'iPhone 15 Pro Max'],
  [480, 800, '小平板'],
  [600, 900, '平板'],
  [768, 1024, 'iPad 竖屏'],
  [820, 1180, 'iPad Air 竖屏'],
  [568, 320, '小屏横屏'],
  [640, 360, '安卓横屏'],
  [740, 360, '大屏横屏'],
  [820, 400, 'iPad 横屏'],
  [900, 420, '手机横屏'],
  [1024, 600, '桌面矮窗'],
  [1280, 720, '桌面宽屏'],
  [1920, 1080, '桌面全高清'],
];

const MEASURE = `(function(){
  var lock = document.getElementById('lockScreen');
  lock.hidden = false;
  var kp = document.getElementById('keypad');
  var btns = kp.querySelectorAll('button');
  var res = [];
  for (var i = 0; i < btns.length; i++) {
    var b = btns[i];
    var r = b.getBoundingClientRect();
    var cs = getComputedStyle(b);
    var br = cs.borderTopLeftRadius;
    // 解析圆角：百分比按较小边换算，像素直接用
    var radPx = br.indexOf('%') >= 0
      ? parseFloat(br) / 100 * Math.min(r.width, r.height)
      : parseFloat(br);
    var ratio = r.width / r.height;
    // 正圆判定：宽高比 1（容差 1%），且圆角半径达到较短边的一半（容差 1.5px）
    var isCircle = Math.abs(ratio - 1) < 0.01 && Math.abs(radPx * 2 - Math.min(r.width, r.height)) < 1.5;
    res.push({
      i: i,
      w: +r.width.toFixed(2),
      h: +r.height.toFixed(2),
      ratio: +ratio.toFixed(4),
      radius: br,
      circle: isCircle,
      cls: b.className
    });
  }
  var kpr = kp.getBoundingClientRect();
  var lr = lock.getBoundingClientRect();
  // 键盘底部相对锁屏容器是否溢出（矮屏上会点不到）
  var overflowBottom = Math.round(kpr.bottom - lr.bottom);
  var overflowRight = Math.round(kpr.right - lr.right);
  return {
    vw: window.innerWidth, vh: window.innerHeight,
    count: btns.length,
    circles: res.filter(function(x){ return x.circle; }).length,
    sample: res[0],
    overflowBottom: overflowBottom,
    overflowRight: overflowRight,
    kpW: +kpr.width.toFixed(1), kpH: +kpr.height.toFixed(1)
  };
})()`;

(async () => {
  const browser = await Browser.launch({ port: PORT });
  console.log('浏览器:', browser.cdp.browserVersion);
  console.log('页面:  ', BASE + '/index.html');
  console.log('');

  let bad = 0, overflow = 0;
  const seen = new Set();

  for (const [w, h, label] of SIZES) {
    const page = await browser.newPage();
    await page.setViewport(w, h, true);
    await page.goto(BASE + '/index.html', 250);
    const m = await page.eval(MEASURE);

    const btn = m.sample;
    const ok = m.circles === m.count;
    if (!ok) bad++;
    if (m.overflowBottom > 0 || m.overflowRight > 0) overflow++;

    // 记录去重后的按钮尺寸，便于一眼看出是否有多种形状
    seen.add(btn.w + 'x' + btn.h);

    const over = [];
    if (m.overflowBottom > 0) over.push('下溢 ' + m.overflowBottom + 'px');
    if (m.overflowRight > 0) over.push('右溢 ' + m.overflowRight + 'px');

    console.log(
      (ok ? '  OK  ' : '  BAD ') +
      String(w).padStart(4) + 'x' + String(h).padEnd(5) +
      ' ' + label.padEnd(18) +
      ' 按钮 ' + (btn.w + '×' + btn.h).padEnd(16) +
      ' 比例 ' + btn.ratio.toFixed(3) +
      ' 圆角 ' + btn.radius.padEnd(8) +
      ' 正圆 ' + m.circles + '/' + m.count +
      (over.length ? '  ⚠ ' + over.join(' ') : '')
    );
  }

  console.log('');
  console.log('不同按钮尺寸种类:', Array.from(seen).join(' / '));
  console.log('非正圆视口数:', bad);
  console.log('键盘溢出视口数:', overflow);

  browser.close();
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => { console.error('失败:', e.message); process.exit(2); });
