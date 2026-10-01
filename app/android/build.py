#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""私密日志 · APK 构建

不依赖 Gradle / AGP，直接用 Android SDK 的命令行工具手工打包：

    aapt2 compile -> aapt2 link -> javac -> d8 -> zip(dex) -> zipalign -> apksigner

为什么不用 Gradle：AGP 需要匹配的 JDK 与大量 Maven 依赖；这里只有一个 Activity，
手工链更快更可控，换台机器只要有 SDK 就能复现。

    python android/build.py

产物： app/android/dist/private-diary-v<版本>.apk
签名： app/android/keystore/riji.jks（首次自动生成，密码见 KS_PASS）
"""
import io
import os
import re
import shutil
import subprocess
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)                 # app/
ROOT = os.path.dirname(APP)                 # 项目根

SDK = os.environ.get('ANDROID_SDK_ROOT') or r'D:\Android\Sdk2'
BT = os.path.join(SDK, 'build-tools', '34.0.0')
PLATFORM = os.path.join(SDK, 'platforms', 'android-34')
ANDROID_JAR = os.path.join(PLATFORM, 'android.jar')

# 构建目录用纯 ASCII 路径，绕开中文/全角字符在 java 工具链里可能出现的编码问题
BUILD = r'D:\Android\build\riji'
DIST = os.path.join(HERE, 'dist')
KS_DIR = os.path.join(HERE, 'keystore')
KS = os.path.join(KS_DIR, 'riji.jks')
KS_PASS = 'riji2026'
KS_ALIAS = 'riji'

# 打进 APK 的网页资源（其余如 tools/、preview/、android/ 不打）
ASSETS = ['index.html', 'manifest.webmanifest', 'sw.js',
          'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'favicon.png']

VERSION = '1.3.0'
VERSION_CODE = '6'

# 编译器/打包器统一用 JDK 17：R8 (d8) 8.2.2 与 JDK 21+ 不兼容
# （JDK 23 编译出的内部类会让 d8 抛 NPE），找不到才退回系统 JDK
JDK_CANDIDATES = [r'D:\Android\tools\jdk17', os.environ.get('JAVA_HOME', ''), r'D:\java']

log = []


def jdk_home():
    for p in JDK_CANDIDATES:
        if p and os.path.exists(os.path.join(p, 'bin', 'javac.exe' if os.name == 'nt' else 'javac')):
            return p
    return None


def say(s):
    log.append(str(s))
    print(s)


def run(cmd, cwd=None, env=None):
    say('$ ' + ' '.join('"%s"' % c if ' ' in c else c for c in cmd))
    r = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, errors='ignore')
    if r.stdout.strip():
        say(r.stdout.strip()[-2000:])
    if r.returncode != 0:
        say('!! 失败 rc=%d' % r.returncode)
        say((r.stderr or '')[-2000:])
        raise SystemExit(1)
    return r


def tool(name):
    for cand in (name + '.exe', name + '.bat', name):
        p = os.path.join(BT, cand)
        if os.path.exists(p):
            return p
    raise SystemExit('找不到工具: ' + name + ' (在 %s)' % BT)


def env_with_java():
    env = dict(os.environ)
    jh = jdk_home() or r'D:\java'
    env['JAVA_HOME'] = jh
    env['PATH'] = os.path.join(jh, 'bin') + os.pathsep + env.get('PATH', '')
    return env


def javac_path():
    jh = jdk_home()
    return os.path.join(jh, 'bin', 'javac.exe') if jh else 'javac'


def main():
    for p, label in ((ANDROID_JAR, 'android.jar'), (BT, 'build-tools 34.0.0')):
        if not os.path.exists(p):
            say('!! 缺少 %s：%s' % (label, p))
            say('   先运行 SDK 安装（sdkmanager platforms;android-34 build-tools;34.0.0）')
            return 1

    env = env_with_java()

    # ---------- 0. 清理并铺目录 ----------
    if os.path.exists(BUILD):
        shutil.rmtree(BUILD, ignore_errors=True)
    for d in ('res', 'gen', 'classes', 'dex', 'assets'):
        os.makedirs(os.path.join(BUILD, d), exist_ok=True)
    os.makedirs(DIST, exist_ok=True)
    shutil.copytree(os.path.join(HERE, 'res'), os.path.join(BUILD, 'res'), dirs_exist_ok=True)

    # ---------- 1. 网页资源 -> assets ----------
    for f in ASSETS:
        src = os.path.join(APP, f)
        if not os.path.exists(src):
            say('!! 缺少网页资源: ' + src)
            return 1
        shutil.copy2(src, os.path.join(BUILD, 'assets', f))
    say('assets: %d 个文件, %.0f KB'
        % (len(ASSETS), sum(os.path.getsize(os.path.join(BUILD, 'assets', f)) for f in ASSETS) / 1024))

    # ---------- 2. 资源编译 ----------
    res_zip = os.path.join(BUILD, 'res.zip')
    run([tool('aapt2'), 'compile', '--dir', 'res', '-o', res_zip], cwd=BUILD, env=env)

    # ---------- 3. 资源链接（生成 R.java 与含 assets 的 base.apk）----------
    # aapt2 的 --version-code/--version-name 压不过清单里的硬编码值，
    # 所以这里把版本号写进清单副本，保证 VERSION / VERSION_CODE 是唯一来源
    base_apk = os.path.join(BUILD, 'base.apk')
    manifest = os.path.join(BUILD, 'AndroidManifest.xml')
    xml = io.open(os.path.join(HERE, 'AndroidManifest.xml'), encoding='utf-8').read()
    xml = re.sub(r'android:versionCode="[^"]*"', 'android:versionCode="%s"' % VERSION_CODE, xml)
    xml = re.sub(r'android:versionName="[^"]*"', 'android:versionName="%s"' % VERSION, xml)
    io.open(manifest, 'w', encoding='utf-8').write(xml)
    run([tool('aapt2'), 'link',
         '-o', base_apk,
         '-I', ANDROID_JAR,
         '--manifest', manifest,
         '-R', res_zip,
         '-A', 'assets',
         '--java', 'gen',
         '--min-sdk-version', '24',
         '--target-sdk-version', '34',
         '--version-code', VERSION_CODE,
         '--version-name', VERSION,
         '--auto-add-overlay',
         '--no-version-vectors'], cwd=BUILD, env=env)

    # ---------- 4. 编译 Java ----------
    # 自动收集 src/ 下所有 .java，别写死文件名 —— 加一个类就得回来改脚本太容易漏
    java_srcs = [os.path.join(BUILD, 'gen', 'com', 'wxk', 'riji', 'R.java')]
    src_root = os.path.join(HERE, 'src')
    for dirpath, _dirnames, filenames in os.walk(src_root):
        for fn in sorted(filenames):
            if fn.endswith('.java'):
                java_srcs.append(os.path.join(dirpath, fn))
    say('Java 源文件: %d 个' % (len(java_srcs) - 1))
    ok = False
    for release in ('8', '11'):
        try:
            run([javac_path(), '-encoding', 'UTF-8', '-nowarn',
                 '-source', release, '-target', release,
                 '-bootclasspath', ANDROID_JAR,
                 '-d', 'classes'] + java_srcs, cwd=BUILD, env=env)
            say('javac 目标版本: %s，编译器: %s' % (release, javac_path()))
            ok = True
            break
        except SystemExit:
            say('  (source %s 不支持，换 11 重试)' % release)
    if not ok:
        return 1

    # ---------- 5. dex ----------
    class_files = []
    for dirpath, _dirnames, filenames in os.walk(os.path.join(BUILD, 'classes', 'com')):
        for fn in filenames:
            if fn.endswith('.class'):
                class_files.append(os.path.join(dirpath, fn))
    if not class_files:
        say('!! javac 没有产出 class 文件')
        return 1
    say('class 文件: %d 个' % len(class_files))
    run([tool('d8'), '--release', '--min-api', '24', '--lib', ANDROID_JAR,
         '--output', 'dex'] + class_files, cwd=BUILD, env=env)

    # ---------- 6. 把 classes.dex 塞进 APK ----------
    dex = os.path.join(BUILD, 'dex', 'classes.dex')
    if not os.path.exists(dex):
        say('!! 没有产出 classes.dex')
        return 1
    with zipfile.ZipFile(base_apk, 'a', zipfile.ZIP_DEFLATED) as z:
        z.write(dex, 'classes.dex')
    say('已写入 classes.dex (%.0f KB)' % (os.path.getsize(dex) / 1024))

    # ---------- 7. 对齐 ----------
    aligned = os.path.join(BUILD, 'aligned.apk')
    run([tool('zipalign'), '-f', '-p', '4', base_apk, aligned], cwd=BUILD, env=env)

    # ---------- 8. 签名 ----------
    os.makedirs(KS_DIR, exist_ok=True)
    if not os.path.exists(KS):
        say('生成签名密钥（首次）...')
        run(['keytool', '-genkeypair', '-v',
             '-keystore', KS, '-alias', KS_ALIAS,
             '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10950',
             '-storepass', KS_PASS, '-keypass', KS_PASS,
             '-dname', 'CN=Riji, OU=Personal, O=wxk, L=Mingguang, ST=Anhui, C=CN'],
            env=env)

    out_apk = os.path.join(DIST, 'private-diary-v%s.apk' % VERSION)
    if os.path.exists(out_apk):
        os.remove(out_apk)
    run([tool('apksigner'), 'sign',
         '--ks', KS, '--ks-key-alias', KS_ALIAS,
         '--ks-pass', 'pass:' + KS_PASS, '--key-pass', 'pass:' + KS_PASS,
         '--v1-signing-enabled', 'true', '--v2-signing-enabled', 'true',
         '--out', out_apk, aligned], cwd=BUILD, env=env)

    # ---------- 9. 校验 ----------
    r = run([tool('apksigner'), 'verify', '--print-certs', '-v', out_apk], env=env)
    size = os.path.getsize(out_apk)
    say('')
    say('=== 构建完成 ===')
    say('APK : %s' % out_apk)
    say('大小: %.2f MB' % (size / 1048576.0))
    # 构建日志跟产物放一起，别丢在项目根目录（那里应该是干净的）
    io.open(os.path.join(DIST, 'build.log'), 'w', encoding='utf-8').write('\n'.join(log))
    return 0


if __name__ == '__main__':
    sys.exit(main())
