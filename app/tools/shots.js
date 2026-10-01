/**
 * 用 CDP 生成预览截图（替代失效的 Edge --screenshot 老路径）。
 *
 *     node tools/shots.js
 *
 * 会先跑 build-tests.py 生成带演示数据的页面，再逐张截图到 preview/。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { Browser, sleep } = require('./cdp');
const { build } = require('./build-tests');

const HERE = __dirname;
const APP = path.dirname(HERE);
const PREVIEW = path.join(APP, 'preview');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8777';

// [页面（相对 app/ 的路径）, 输出文件, 宽, 高, 是否显示锁屏, 截图前滚动到的位置,
//  强制语言, 是否摆出「指纹可用」那一态]
// 注意：演示页生成在 tools/ 下，index.html 在 app/ 根，别把前缀写错
// 统计页内容变长了，拆成上下两张，README 里比一张超长图好读
const SHOTS = [
  ['tools/_demo-home.html', 'home.png', 390, 640, false, 0],
  ['tools/_demo-home-run.html', 'home-running.png', 390, 640, false, 0],
  ['tools/_demo-plain.html', 'calendar.png', 390, 880, false, 0],
  ['tools/_demo.html', 'reminder.png', 390, 900, false, 0],
  ['tools/_demo-stats.html', 'stats.png', 390, 1180, false, 0],
  ['tools/_demo-stats.html', 'stats-more.png', 390, 1180, false, 990],
  ['tools/_demo-dark.html', 'dark.png', 390, 880, false, 0],
  ['tools/_demo-sheet.html', 'add-record.png', 390, 900, false, 0],
  ['tools/_demo-remind.html', 'remind-settings.png', 390, 900, false, 0],
  ['tools/_demo-settings.html', 'accent.png', 390, 640, false, 0],
  // 英文界面截图，给 README-en.md 用
  ['tools/_demo-en-home.html', 'en-home.png', 390, 640, false, 0],
  ['tools/_demo-en.html', 'en-reminder.png', 390, 900, false, 0],
  ['tools/_demo-en.html', 'en-calendar.png', 390, 880, false, 0],
  ['tools/_demo-en-stats.html', 'en-stats.png', 390, 1180, false, 0],
  ['tools/_demo-en-sheet.html', 'en-add-record.png', 390, 900, false, 0],
  ['tools/_demo-en-remind.html', 'en-settings.png', 390, 900, false, 0],
  ['tools/_demo-en-settings.html', 'en-accent.png', 390, 640, false, 0],
  // 隐私锁（中英各一张）。
  // index.html 没有种子数据，语言会跟随系统 —— headless 里是 en-US，
  // 不钉住的话中文截图的键盘会是 Del/Cancel 这种英文，跟标题对不上。
  ['index.html', 'lock-light.png', 390, 844, true, 0, 'zh'],
  ['index.html', 'lock-dark.png', 390, 844, true, 0, 'zh'],
  ['index.html', 'lock-short.png', 360, 640, true, 0, 'zh'],
  ['index.html', 'lock-landscape.png', 820, 400, true, 0, 'zh'],
  ['index.html', 'en-lock.png', 390, 844, true, 0, 'en'],
  // 指纹锁屏。这个状态只有 APK 里才有（浏览器没有原生桥），
  // 所以截图时手工把那一态摆出来，拍到的仍然是真实布局。
  ['index.html', 'lock-bio.png', 390, 844, true, 0, 'zh', true]
];

(async () => {
  fs.mkdirSync(PREVIEW, { recursive: true });

  // 重建演示数据页（进程内调用）
  const b = build();
  console.log('demo data: ' + b.days + ' days, ' + b.records + ' records');

  const browser = await Browser.launch({});
  console.log('浏览器:', browser.cdp.browserVersion);
  const page = await browser.newPage();

  for (const [src, out, w, h, isLock, scrollY, forceLang, bio] of SHOTS) {
    const dark = /dark/.test(src) || out.indexOf('dark') >= 0;
    await page.setViewport(w, h, true);
    await page.goto(BASE + '/' + src, 400);

    if (forceLang) {
      // index.html 没有种子，语言跟随系统（headless 里是 en-US），
      // 这里显式指定，保证截图语言可控
      await page.eval(`(function(){
        window.__dyf.S.settings.lang = '${forceLang}';
        window.__dyf.save();
        window.__dyf.applyLang();
        return true;
      })()`);
      await sleep(150);
    }

    if (isLock) {
      // 强制显示锁屏，并切到指定主题
      await page.eval(`(function(){
        document.documentElement.setAttribute('data-theme', '${dark ? 'dark' : 'light'}');
        var l = document.getElementById('lockScreen');
        l.hidden = false;
        document.getElementById('lockSub').textContent = window.__dyf.t('app.name');
        // 点亮两位密码，让截图更接近真实使用
        var dots = document.getElementById('pinDots');
        dots.innerHTML = '<i class="on"></i><i class="on"></i><i></i><i></i>';
        return true;
      })()`);
      await sleep(120);
      if (bio) {
        // 指纹那一态浏览器里进不去（没有原生桥），手工摆出来 —— 量到的仍然是真实布局
        await page.eval(`(function(){
          document.getElementById('lockScreen').classList.add('has-bio');
          document.getElementById('bioBtn').hidden = false;
          document.getElementById('lockSub').textContent = window.__dyf.t('lock.bioWaiting');
          return true;
        })()`);
        await sleep(120);
      }
    } else if (scrollY) {
      await page.eval('window.scrollTo(0, ' + scrollY + '); true');
      await sleep(220);
    }

    await page.screenshot(path.join(PREVIEW, out));
    const kb = fs.statSync(path.join(PREVIEW, out)).size;
    const warn = kb < 8000 && !isLock ? '   ⚠ 体积异常小，可能是 404 页' : '';
    console.log(`  ${out.padEnd(22)} ${w}x${h}  ${(kb / 1024).toFixed(0)} KB${warn}`);
  }

  browser.close();
})().catch((e) => { console.error('失败:', e.message); process.exit(2); });
