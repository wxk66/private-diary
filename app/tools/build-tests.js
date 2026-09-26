#!/usr/bin/env node
/**
 * 生成验证用的页面（Node 版，取代原来的 build-tests.py）。
 *
 *     node tools/build-tests.js
 *
 * 产出：
 *   tools/_e2e.html          把 tools/_e2e.js 注入 index.html 副本，用于端到端测试
 *   tools/_demo*.html        带演示数据的页面，用于截图与布局检查
 *
 * 为什么不用 Python 了：verify.js / shots.js 需要调用这个步骤，而 Node 里
 * spawnSync 去起 python.exe 在这台机器上稳定报 EBUSY（杀软/索引器锁 exe），
 * 重试也没用。整个逻辑本来就很薄，直接用 Node 重写、进程内 require 调用，
 * 既去掉了跨运行时的脆弱依赖，也更快。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const APP = path.dirname(HERE);
const INDEX = path.join(APP, 'index.html');

const ERR_HOOK = '<script>window.__errCount=0;window.__errMsgs=[];window.addEventListener(\'error\',function(e){window.__errCount++;window.__errMsgs.push(String(e.message));});</script>\n';

/* 确定性伪随机（mulberry32）：演示数据每次生成都一样，截图可以比对 */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

const KIND_WEIGHTS = [['ej', 0.70], ['fl', 0.22], ['other', 0.08]];
const TAGS = ['stress', 'bored', 'insomnia', 'alone', 'media', 'habit', 'tired', 'anxious'];

function pickKind(rnd) {
  const r = rnd();
  let acc = 0;
  for (const [k, w] of KIND_WEIGHTS) { acc += w; if (r <= acc) return k; }
  return 'ej';
}
/* 射精 1.5~5 mL，流精 0.5~3 mL；不是每次都测，所以有时留空 */
function pickVol(k, rnd) {
  if (k === 'ej' && rnd() < 0.65) return Math.round((1.5 + rnd() * 3.5) * 10) / 10;
  if (k === 'fl' && rnd() < 0.55) return Math.round((0.5 + rnd() * 2.5) * 10) / 10;
  return null;
}
function pickTags(rnd) {
  if (rnd() < 0.45) return [];              // 多数记录不打标签，更贴近真实使用
  const n = rnd() < 0.7 ? 1 : 2;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = TAGS[Math.floor(rnd() * TAGS.length)];
    if (out.indexOf(t) < 0) out.push(t);
  }
  return out;
}

function buildDemoRecords() {
  const rnd = mulberry32(20260926);
  const records = {};
  // 用当天日期，别写死 —— 写死的话演示数据会停在过去，截图里"今天"就没内容了
  const today = new Date();
  for (let i = 300; i >= 0; i--) {
    const d = addDays(today, -i);
    const isWeekend = (d.getDay() === 0 || d.getDay() === 6);
    let has;
    if (i <= 13) {
      has = (i !== 5);                      // 最近两周给足数据，中间留一天空档显得真实
    } else {
      has = rnd() < (isWeekend ? 0.55 : 0.42);
    }
    if (!has) continue;
    const r = rnd();
    const n = r < 0.5 ? 1 : (r < 0.85 ? 2 : 3);
    const items = [];
    for (let j = 0; j < n; j++) {
      const hh = 7 + Math.floor(rnd() * 17);
      const mm = [0, 5, 12, 20, 28, 33, 41, 50, 55][Math.floor(rnd() * 9)];
      const k = pickKind(rnd);
      const rec = { id: 'demo' + (d.getTime() / 86400000 + 40000).toFixed(0) + j, t: pad(hh) + ':' + pad(mm), n: '', k: k };
      const v = pickVol(k, rnd);
      if (v !== null) rec.v = v;
      const g = pickTags(rnd);
      if (g.length) rec.g = g;
      items.push(rec);
    }
    items.sort((a, b) => a.t.localeCompare(b.t));
    records[keyOf(d)] = items;
  }
  return records;
}

function seedScript(records, theme, lang) {
  const seed = {
    version: 2,
    records: records,
    settings: {
      theme: theme, weekStart: 1, pin: '',
      lang: lang || 'zh',        // 固定语言，否则 headless 里 navigator.language 是 en-US，截图会变英文
      lastKind: 'ej', lastTags: [],
      remind: { on: true, week: 3, month: 10 },
      remindDismiss: {}, pinSalt: '', pinIter: 0,
      pinFails: { n: 0, until: 0 },
      daily: { on: false, time: '21:00' }
    }
  };
  const text = JSON.stringify(seed);
  // 要再包一层 stringify，才能生成 JS 字符串字面量；只 dump 一次会变成对象字面量，
  // localStorage 里存进去的就是 "[object Object]" 这 15 个字符
  return '<script>try{localStorage.setItem(\'private-diary.v1\',' + JSON.stringify(text) + ');}catch(e){}</script>\n';
}

function build() {
  const html = fs.readFileSync(INDEX, 'utf8');
  const written = [];

  /* ---------- 1) 端到端测试页 ---------- */
  // 注意：注入内容必须用**函数形式**的 replace，不能传字符串。
  // 字符串形式的替换串里 `$$` 会被当成转义序列压成一个 `$`，
  // 测试脚本里的 `$$` 选择器辅助函数会被悄悄改成 `$`，排查起来极其费劲。
  const e2eJs = fs.readFileSync(path.join(HERE, '_e2e.js'), 'utf8');
  const inject = (s) => '<script>' + s + '</script>\n';
  let page = html.replace('</head>', () => ERR_HOOK + '</head>');
  // 测试页也要钉死语言：headless 的 navigator.language 是 en-US，
  // 不钉的话「跟随系统」会解析成英文，中文断言全挂
  const seedIdx = page.lastIndexOf('<script>');
  page = page.slice(0, seedIdx) + seedScript({}, 'light', 'zh') + page.slice(seedIdx);
  page = page.replace('</body>', () => inject(e2eJs) + '</body>');
  fs.writeFileSync(path.join(HERE, '_e2e.html'), page, 'utf8');
  written.push('_e2e.html');

  /* ---------- 2) 演示数据页 ---------- */
  const records = buildDemoRecords();
  const SWITCH_STATS = 'setTimeout(function(){document.querySelectorAll(".tab")[1].click();},80);';
  const SHOW_REMIND_SETTINGS = [
    'setTimeout(function(){',
    '  document.querySelectorAll(".tab")[2].click();',
    '  var rows=document.querySelectorAll(".set-row");',
    '  for(var i=0;i<rows.length;i++){',
    '    if(rows[i].textContent.indexOf("每日自查提醒")>=0){ rows[i].scrollIntoView({block:"center"}); break; }',
    '  }',
    '},120);'
  ].join('\n');
  // 干净日历页（关掉提醒卡片后再截图；每点一次会重渲染，所以要反复取新的第一个按钮）
  const DISMISS_REMIND = 'setTimeout(function(){for(var n=0;n<8;n++){var b=document.querySelector(".rm-x");if(!b)break;b.click();}},90);';

  const variants = [
    ['_demo.html', 'light', '', 'zh'],
    ['_demo-stats.html', 'light', SWITCH_STATS, 'zh'],
    ['_demo-dark.html', 'dark', '', 'zh'],
    // 弹层页也先关掉提醒，否则截图里遮罩后面飘着几张提醒卡，很乱
    ['_demo-sheet.html', 'light', DISMISS_REMIND + '\nsetTimeout(function(){document.getElementById("quickAdd").click();},200);', 'zh'],
    ['_demo-remind.html', 'light', SHOW_REMIND_SETTINGS, 'zh'],
    ['_demo-plain.html', 'light', DISMISS_REMIND, 'zh'],
    // 英文版：README-en.md 要用英文界面的截图
    ['_demo-en.html', 'light', '', 'en'],
    ['_demo-en-stats.html', 'light', SWITCH_STATS, 'en'],
    ['_demo-en-sheet.html', 'light', DISMISS_REMIND + '\nsetTimeout(function(){document.getElementById("quickAdd").click();},200);', 'en'],
    ['_demo-en-remind.html', 'light', SHOW_REMIND_SETTINGS, 'en']
  ];
  for (const [name, theme, extra, lang] of variants) {
    const idx = html.lastIndexOf('<script>');
    let out = html.slice(0, idx) + seedScript(records, theme, lang) + html.slice(idx);
    if (extra) out = out.replace('</body>', () => inject(extra) + '</body>');
    fs.writeFileSync(path.join(HERE, name), out, 'utf8');
    written.push(name);
  }

  const days = Object.keys(records).length;
  const total = Object.values(records).reduce((a, v) => a + v.length, 0);
  return { written: written, days: days, records: total };
}

module.exports = { build: build, buildDemoRecords: buildDemoRecords };

if (require.main === module) {
  const r = build();
  for (const f of r.written) console.log('built ' + f);
  console.log('demo data: ' + r.days + ' days, ' + r.records + ' records');
}
