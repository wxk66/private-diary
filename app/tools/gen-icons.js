/* 生成应用图标 PNG（纯 Node，无第三方依赖）
   用法: node gen-icons.js
   输出: ../icon-192.png  ../icon-512.png  ../favicon.png */
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const SS = 4; // 超采样倍数，用于抗锯齿

/* ---------- CRC32 ---------- */
const CRC_TABLE = (function(){
  const t = new Int32Array(256);
  for(let n=0;n<256;n++){
    let c = n;
    for(let k=0;k<8;k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf){
  let c = 0xFFFFFFFF;
  for(let i=0;i<buf.length;i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* ---------- PNG 写出 ---------- */
function writePNG(file, w, h, rgba){
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for(let y=0;y<h;y++){
    raw[y*(stride+1)] = 0; // filter: none
    rgba.copy(raw, y*(stride+1) + 1, y*stride, (y+1)*stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  function chunk(type, data){
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  const out = Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
  fs.writeFileSync(file, out);
  return out.length;
}

/* ---------- 光栅化 ---------- */
function makeCanvas(N){
  return new Float32Array(N * N * 4);
}
function px(cv, N, x, y, r, g, b, a){
  if(x < 0 || y < 0 || x >= N || y >= N || a <= 0) return;
  const i = (y * N + x) * 4;
  cv[i]   = cv[i]   * (1 - a) + r * a;
  cv[i+1] = cv[i+1] * (1 - a) + g * a;
  cv[i+2] = cv[i+2] * (1 - a) + b * a;
  cv[i+3] = cv[i+3] * (1 - a) + 1 * a;
}
function insideRR(px_, py_, x0, y0, x1, y1, r){
  const cx = Math.min(Math.max(px_, x0 + r), x1 - r);
  const cy = Math.min(Math.max(py_, y0 + r), y1 - r);
  const dx = px_ - cx, dy = py_ - cy;
  return dx*dx + dy*dy <= r*r;
}
function fillRR(cv, N, x0, y0, x1, y1, r, col, alpha){
  const a = (alpha === undefined) ? 1 : alpha;
  for(let y=Math.floor(y0); y<Math.ceil(y1); y++){
    for(let x=Math.floor(x0); x<Math.ceil(x1); x++){
      if(insideRR(x+0.5, y+0.5, x0, y0, x1, y1, r)) px(cv, N, x, y, col[0], col[1], col[2], a);
    }
  }
}
function ringRR(cv, N, x0, y0, x1, y1, r, thick, col, alpha){
  const a = (alpha === undefined) ? 1 : alpha;
  const ix0 = x0 + thick, iy0 = y0 + thick, ix1 = x1 - thick, iy1 = y1 - thick;
  const ir = Math.max(0, r - thick);
  for(let y=Math.floor(y0); y<Math.ceil(y1); y++){
    for(let x=Math.floor(x0); x<Math.ceil(x1); x++){
      const p = x + 0.5, q = y + 0.5;
      if(insideRR(p, q, x0, y0, x1, y1, r) && !insideRR(p, q, ix0, iy0, ix1, iy1, ir)){
        px(cv, N, x, y, col[0], col[1], col[2], a);
      }
    }
  }
}
function fillCircle(cv, N, cx, cy, r, col, alpha){
  const a = (alpha === undefined) ? 1 : alpha;
  for(let y=Math.floor(cy-r); y<Math.ceil(cy+r); y++){
    for(let x=Math.floor(cx-r); x<Math.ceil(cx+r); x++){
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      if(dx*dx + dy*dy <= r*r) px(cv, N, x, y, col[0], col[1], col[2], a);
    }
  }
}

/* ---------- 绘制图标 ---------- */
function renderIcon(size){
  const N = size * SS;
  const s = N / 512; // 以 512 为设计基准
  const cv = makeCanvas(N);

  // 背景：竖向渐变（靛蓝）
  const top = [0x74, 0x74, 0xF5];
  const bot = [0x46, 0x46, 0xC4];
  for(let y=0;y<N;y++){
    const t = y / (N - 1);
    const r = (top[0] + (bot[0]-top[0]) * t) / 255;
    const g = (top[1] + (bot[1]-top[1]) * t) / 255;
    const b = (top[2] + (bot[2]-top[2]) * t) / 255;
    for(let x=0;x<N;x++){
      const i = (y*N + x) * 4;
      cv[i] = r; cv[i+1] = g; cv[i+2] = b; cv[i+3] = 1;
    }
  }

  // 顶部高光
  for(let y=0;y<Math.round(N*0.55);y++){
    const t = 1 - y / (N*0.55);
    for(let x=0;x<N;x++) px(cv, N, x, y, 1, 1, 1, t * 0.07);
  }

  const W = [1, 1, 1];

  // 日历挂钩
  fillRR(cv, N, 172*s, 112*s, 200*s, 178*s, 14*s, W, 1);
  fillRR(cv, N, 312*s, 112*s, 340*s, 178*s, 14*s, W, 1);

  // 日历主体描边
  ringRR(cv, N, 126*s, 150*s, 386*s, 388*s, 52*s, 27*s, W, 1);

  // 顶部实心条
  fillRR(cv, N, 126*s, 150*s, 386*s, 232*s, 52*s, W, 1);
  fillRR(cv, N, 126*s, 204*s, 386*s, 232*s, 0, W, 1);

  // 日期圆点
  fillCircle(cv, N, 208*s, 314*s, 23*s, W, 0.92);
  fillCircle(cv, N, 304*s, 314*s, 23*s, W, 0.92);

  // 缩采样（抗锯齿）
  const out = Buffer.alloc(size * size * 4);
  for(let y=0;y<size;y++){
    for(let x=0;x<size;x++){
      let r=0,g=0,b=0,a=0;
      for(let sy=0;sy<SS;sy++){
        for(let sx=0;sx<SS;sx++){
          const i = ((y*SS+sy) * N + (x*SS+sx)) * 4;
          r += cv[i]; g += cv[i+1]; b += cv[i+2]; a += cv[i+3];
        }
      }
      const n = SS*SS;
      const o = (y*size + x) * 4;
      out[o]   = Math.max(0, Math.min(255, Math.round(r/n*255)));
      out[o+1] = Math.max(0, Math.min(255, Math.round(g/n*255)));
      out[o+2] = Math.max(0, Math.min(255, Math.round(b/n*255)));
      out[o+3] = Math.max(0, Math.min(255, Math.round(a/n*255)));
    }
  }
  return out;
}

/* ---------- 通知栏小图标 ----------
   通知小图标必须是「白色 + 透明」的单色图，系统会自己上色；
   直接用彩色应用图标会变成一坨白色方块。 */
function renderNotifIcon(size){
  const N = size * SS;
  const s = N / 24;              // 以 24dp 为设计基准（Android 通知图标标准尺寸）
  const cv = makeCanvas(N);      // 背景全透明
  const W = [1, 1, 1];

  // 两个挂钩
  fillRR(cv, N, 8.0*s, 3.6*s, 9.2*s, 6.4*s, 0.6*s, W, 1);
  fillRR(cv, N, 14.8*s, 3.6*s, 16.0*s, 6.4*s, 0.6*s, W, 1);
  // 日历外框
  ringRR(cv, N, 3.4*s, 5.2*s, 20.6*s, 20.4*s, 2.6*s, 1.7*s, W, 1);
  // 顶部实心条
  fillRR(cv, N, 3.4*s, 5.2*s, 20.6*s, 9.6*s, 2.6*s, W, 1);
  fillRR(cv, N, 3.4*s, 8.4*s, 20.6*s, 9.6*s, 0, W, 1);
  // 两个日期点
  fillCircle(cv, N, 8.4*s, 15.2*s, 1.5*s, W, 1);
  fillCircle(cv, N, 15.6*s, 15.2*s, 1.5*s, W, 1);

  const out = Buffer.alloc(size * size * 4);
  for(let y=0;y<size;y++){
    for(let x=0;x<size;x++){
      let r=0,g=0,b=0,a=0;
      for(let sy=0;sy<SS;sy++){
        for(let sx=0;sx<SS;sx++){
          const i = ((y*SS+sy) * N + (x*SS+sx)) * 4;
          r += cv[i]; g += cv[i+1]; b += cv[i+2]; a += cv[i+3];
        }
      }
      const n = SS*SS;
      const o = (y*size + x) * 4;
      out[o]   = Math.max(0, Math.min(255, Math.round(r/n*255)));
      out[o+1] = Math.max(0, Math.min(255, Math.round(g/n*255)));
      out[o+2] = Math.max(0, Math.min(255, Math.round(b/n*255)));
      out[o+3] = Math.max(0, Math.min(255, Math.round(a/n*255)));
    }
  }
  return out;
}

/* ---------- 主流程 ---------- */
const dir = path.resolve(__dirname, '..');
const jobs = [
  [512, 'icon-512.png'],
  [192, 'icon-192.png'],
  [180, 'apple-touch-icon.png'],
  [64,  'favicon.png']
];
jobs.forEach(function(j){
  const buf = renderIcon(j[0]);
  const bytes = writePNG(path.join(dir, j[1]), j[0], j[0], buf);
  console.log('  ' + j[1] + '  ' + j[0] + 'x' + j[0] + '  ' + bytes + ' bytes');
});

// 通知栏小图标（单色白），给 APK 的每日提醒用
const drawable = path.join(dir, 'android', 'res', 'drawable');
fs.mkdirSync(drawable, { recursive: true });
[[24, 'drawable-mdpi'], [36, 'drawable-hdpi'], [48, 'drawable-xhdpi'],
 [72, 'drawable-xxhdpi'], [96, 'drawable-xxxhdpi']].forEach(function(j){
  const sub = path.join(dir, 'android', 'res', j[1]);
  fs.mkdirSync(sub, { recursive: true });
  const buf = renderNotifIcon(j[0]);
  const bytes = writePNG(path.join(sub, 'ic_stat_riji.png'), j[0], j[0], buf);
  console.log('  ' + j[1] + '/ic_stat_riji.png  ' + j[0] + 'x' + j[0] + '  ' + bytes + ' bytes');
});
console.log('图标生成完成 -> ' + dir);
