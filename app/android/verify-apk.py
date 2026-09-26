#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""私密日志 · APK 产物校验

打完包后跑一遍，确认清单、图标、dex、assets、对齐和签名都对：

    python android/verify-apk.py [apk路径]
"""
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SDK = os.environ.get('ANDROID_SDK_ROOT') or r'D:\Android\Sdk2'
BT = os.path.join(SDK, 'build-tools', '34.0.0')
DIST = os.path.join(HERE, 'dist')


def tool(name):
    for c in (name + '.exe', name + '.bat', name):
        p = os.path.join(BT, c)
        if os.path.exists(p):
            return p
    return None


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True, errors='ignore')
    return ((r.stdout or '') + (r.stderr or '')), r.returncode


def main():
    apk = sys.argv[1] if len(sys.argv) > 1 else None
    if not apk:
        cands = [os.path.join(DIST, f) for f in os.listdir(DIST)] if os.path.isdir(DIST) else []
        cands = [c for c in cands if c.endswith('.apk')]
        if not cands:
            print('dist/ 里没有 apk')
            return 1
        apk = max(cands, key=os.path.getmtime)
    print('校验: %s (%.2f MB)\n' % (apk, os.path.getsize(apk) / 1048576.0))

    checks = []

    # 1) 清单信息 + 图标 + 权限
    aapt2 = tool('aapt2')
    badging, _rc = run([aapt2, 'dump', 'badging', apk]) if aapt2 else ('', 1)
    def pick(pat):
        m = re.search(pat, badging)
        return m.group(1) if m else '(未找到)'
    print('包名      :', pick(r"package: name='([^']+)'"))
    print('版本      :', pick(r"versionCode='([^']+)'") + ' / ' + pick(r"versionName='([^']+)'"))
    print('应用名    :', pick(r"application-label:'([^']+)'"))
    print('SDK       :', 'min=' + pick(r"sdkVersion:'([^']+)'") + ' target=' + pick(r"targetSdkVersion:'([^']+)'"))
    icons = re.findall(r"application-icon-\d+:'([^']+)'", badging)
    print('图标      :', ', '.join(sorted(set(icons))) or '(无)')
    perms = re.findall(r"uses-permission: name='([^']+)'", badging)
    print('权限      :', ', '.join(p.split('.')[-1] for p in perms) if perms else '（无）')
    launchable = re.search(r"launchable-activity: name='([^']+)'", badging)

    checks.append(('包名正确', 'com.wxk.riji' in badging))
    checks.append(('应用名为「私密日志」', '私密日志' in badging))
    checks.append(('minSdk 24', "sdkVersion:'24'" in badging))
    checks.append(('图标齐全', len(set(icons)) >= 2))
    checks.append(('有启动入口', bool(launchable)))
    # 依旧不联网；导出走 SAF、提醒走通知，都不需要存储权限
    checks.append(('不申请联网权限', not any('INTERNET' in p for p in perms)))
    checks.append(('不申请存储权限', not any('STORAGE' in p or 'MEDIA' in p for p in perms)))
    checks.append(('声明通知权限', any('POST_NOTIFICATIONS' in p for p in perms)))
    checks.append(('声明开机自启权限', any('RECEIVE_BOOT_COMPLETED' in p for p in perms)))

    # 2) 清单里的广播接收器（badging 不列 receiver，得看 xmltree）
    if aapt2:
        tree, _rc2 = run([aapt2, 'dump', 'xmltree', apk, '--file', 'AndroidManifest.xml'])
        has_recv = 'ReminderReceiver' in tree
        has_boot = 'BOOT_COMPLETED' in tree
        checks.append(('声明 ReminderReceiver', has_recv))
        checks.append(('接收器监听开机广播', has_boot))
        print('接收器    :', 'ReminderReceiver' + (' + BOOT_COMPLETED' if has_boot else '')
              if has_recv else '(未找到)')

    # 3) APK 内容
    import zipfile
    with zipfile.ZipFile(apk) as z:
        names = z.namelist()
        html = z.read('assets/index.html').decode('utf-8', 'replace')
    need = ['classes.dex', 'AndroidManifest.xml', 'resources.arsc', 'assets/index.html']
    for n in need:
        checks.append(('包含 ' + n, n in names))
    asset_list = sorted(n for n in names if n.startswith('assets/'))
    print('assets    :', ', '.join(asset_list))

    stat_icons = [n for n in names if 'ic_stat_riji' in n]
    checks.append(('通知栏小图标齐全', len(stat_icons) >= 3))
    print('通知图标  : %d 个密度' % len(stat_icons))

    # 4) 打进包里的网页确实带着本轮新功能（防止忘了同步 assets）
    for key, label in [('--kp:', '键盘正圆样式'), ('tagChips', '诱因标签'),
                       ('goalCard', '目标达成'), ('trendWrap', '月度趋势'),
                       ('exportBackup', '原生导出桥'), ('setDailyReminder', '原生提醒桥'),
                       ('p2:', 'PBKDF2 密码'),
                       ('Private Journal', '英文界面'), ('setLang', '语言切换'),
                       ('LEGACY_STORE_KEYS', '旧存储键迁移')]:
        checks.append(('网页含' + label, key in html))

    # 3) 对齐（zipalign -c 通过时无输出，只看返回码）
    za = tool('zipalign')
    if za:
        out, rc = run([za, '-c', '-p', '4', apk])
        aligned = (rc == 0)
        checks.append(('4 字节对齐', aligned))
        print('对齐      :', 'OK' if aligned else out.strip()[:120])

    # 4) 签名
    asg = tool('apksigner')
    if asg:
        out, _rc = run([asg, 'verify', '--print-certs', '-v', apk])
        signed = 'Verified using v2 scheme (APK Signature Scheme v2): true' in out
        v1 = 'Verified using v1 scheme (JAR signing): true' in out
        checks.append(('签名有效', 'Verifies' in out or 'verified' in out.lower()))
        print('签名      : v1=%s v2=%s' % (v1, signed))
        cn = re.search(r'signer #1 certificate DN: (.+)', out)
        if cn:
            print('证书      :', cn.group(1).strip()[:120])

    print('\n--- 结果 ---')
    bad = 0
    for name, ok in checks:
        print('  %s %s' % ('PASS' if ok else 'FAIL', name))
        if not ok:
            bad += 1
    print('\n%s' % ('全部通过，可以安装' if bad == 0 else '有 %d 项未通过' % bad))
    return 0 if bad == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
