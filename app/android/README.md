# 私密日志 · Android 打包说明

把 `app/` 下的单页应用套进一个最小 WebView 外壳，打成可安装的 `.apk`。
原生层不含业务逻辑，也不申请联网权限——所有数据仍存在网页的 localStorage 里。

原生层只补三件网页做不到的事：

| 能力 | 为什么必须原生 |
|---|---|
| **导出备份** | WebView 不会自己处理 `blob:` 下载链接，网页点「导出」会毫无反应。改成把 JSON 交给原生，走 SAF（`ACTION_CREATE_DOCUMENT`）让用户选保存位置 |
| **导入备份** | `<input type="file">` 需要宿主实现 `onShowFileChooser`，否则同样是死按钮 |
| **每日提醒** | 网页没有后台能力。用 `AlarmManager` 定时 + 通知栏，关掉应用也会提醒 |

## 权限

只声明两个，且都不涉及隐私数据：

- `POST_NOTIFICATIONS` —— 每日提醒需要；**只在你真的去开这个功能时才弹窗请求**，不开就一直不请求
- `RECEIVE_BOOT_COMPLETED` —— 系统重启会清掉所有定时，靠它恢复

**不申请联网、不申请存储权限**：导出走 SAF 由用户自己选位置，读写不需要 `WRITE_EXTERNAL_STORAGE`。

## 目录

```
app/android/
├─ AndroidManifest.xml                清单（包名 com.wxk.riji，minSdk 24 / targetSdk 34）
├─ res/                               图标与样式
│  ├─ values/strings.xml              应用名「私密日志」
│  ├─ values/styles.xml               无工具栏主题 + 状态栏底色
│  ├─ mipmap-xxhdpi/ic_launcher.png   192×192
│  ├─ mipmap-xxxhdpi/ic_launcher.png  512×512
│  └─ drawable-*/ic_stat_riji.png     通知栏单色小图标（5 档密度，由 gen-icons.js 生成）
├─ src/com/wxk/riji/
│  ├─ MainActivity.java               WebView 外壳 + 导出/导入/提醒的 JS 桥
│  ├─ ReminderScheduler.java          每日提醒的 AlarmManager 定时管理
│  └─ ReminderReceiver.java           通知栏投递 + 开机恢复
├─ keystore/riji.jks                  签名密钥（首次构建自动生成，勿删）
├─ dist/                              产物
└─ build.py                           构建脚本
```

## 构建

```powershell
python app/android/build.py
```

产物：`app/android/dist/private-diary-v1.2.0.apk`（文件名里的版本号取自 `build.py` 顶部的 `VERSION`）

依赖（本机已装好）：

| 组件 | 位置 | 说明 |
|------|------|------|
| **JDK 17** | `D:\Android\tools\jdk17` | **构建必须用它**，见下方说明 |
| Android SDK | `D:\Android\Sdk2` | platforms/android-34 + build-tools/34.0.0 |
| 构建链 | aapt2 → javac → d8 → zip → zipalign → apksigner | 不走 Gradle / AGP |

> **为什么必须是 JDK 17**：`d8`（R8 8.2.2）处理 JDK 21+ 编译出的含内部类的 class 文件时会抛
> `NullPointerException: String.length() ... null` 直接崩。JDK 23 编译同样的源码也不行，
> 但换成 JDK 17 编译就正常。`build.py` 会自动优先找 `D:\Android\tools\jdk17`，
> 找不到才退回系统 JDK（`JDK_CANDIDATES` 里可加路径）。

新增 SDK 组件（若换机器）：

```powershell
D:\Android\Sdk2\cmdline-tools\latest\bin\android.exe --sdk=D:\Android\Sdk2 sdk install platforms/android-34
D:\Android\Sdk2\cmdline-tools\latest\bin\android.exe --sdk=D:\Android\Sdk2 sdk install build-tools/34.0.0
```

> 新版命令行工具里 `sdkmanager` 已废弃，改用 `android sdk install`，包名用斜杠而非分号。
> 平台包下完是 `platform-34-ext12/android.jar`，需要把里面内容上提到 `platforms/android-34/` 根目录。

打包后自检：

```powershell
python app/android/verify-apk.py
```

会检查包名、版本、图标、权限、广播接收器、通知图标、dex、assets、4 字节对齐和签名，
并确认打进包里的网页确实带着当前版本的样式与桥接代码——25 项全 PASS 才算能装。

## 改动网页后重新打包

`build.py` 每次都会把 `index.html`、`manifest.webmanifest`、`sw.js` 和四个图标重新复制进
`assets/`，所以改完页面直接重跑构建即可，不用手动同步。

## 版本号

改 `build.py` 顶部的 `VERSION` / `VERSION_CODE`。**已安装过的机器要覆盖安装，
versionCode 必须递增**，否则会报「应用未安装」。

## 签名

- 密钥：`keystore/riji.jks`，别名 `riji`，口令 `riji2026`（自签名，仅供个人安装使用）
- 有效期 30 年。**这个文件删了就无法再覆盖安装同一个应用**，要留好。
- 校验：`build-tools\34.0.0\apksigner.bat verify --print-certs -v <apk>`

## 安装到手机

1. 把 `dist/private-diary-v1.2.0.apk` 传到手机（数据线 / 微信文件传输助手都行）
2. 手机上点击安装，首次会提示「允许安装未知来源应用」，同意即可
3. 桌面出现「私密日志」图标，点开即用，无需联网

命令行安装（手机开 USB 调试并连上电脑）：

```powershell
adb install -r "app\android\dist\private-diary-v1.2.0.apk"
```

## 与浏览器 PWA 的关系

- 浏览器版：菜单 →「添加到主屏幕」，功能完全一样
- APK 版：多一个真正的应用图标、独立窗口、不会被浏览器清理数据波及，
  以及**关掉应用也能生效的每日提醒通知**
- **两边的数据不互通**（localStorage 分属不同来源）。想迁移就用应用里的
  「导出备份 → 从备份恢复」。

## 改代码时的注意点

- **改了 `app/index.html` 等网页资源**：直接重跑 `build.py` 即可，脚本每次都会重新复制进 `assets/`
- **新增了 Java 类**：`build.py` 会自动收集 `src/` 下所有 `.java`，不用改脚本
- **新增了图标**：通知栏小图标由 `node app/tools/gen-icons.js` 生成，
  它是**白色单色 + 透明**的（系统会自己上色），别直接拿彩色应用图标当通知图标，
  否则在通知栏上会变成一坨白色方块
- **改了权限**：`verify-apk.py` 里对权限有断言（必须无联网、无存储；必须有通知和开机权限），
  改清单后如果自检失败，先确认是有意为之再更新断言
- **通知文案不要写死在 Java 里**：应用内的语言是用户自己选的，跟系统语言不一定一致，
  原生猜不到。所以 `setDailyReminder(on, time, title, body)` 由网页把文案传进来，
  存在 SharedPreferences 里（闹钟触发时应用可能没在运行）；
  原生需要提示用户时统一走 `uiToast(key)` → 回调网页的 `__dyf.toastKey()` 去显示
- **`package="com.wxk.riji"` 与 `keystore/riji.jks` 刻意保留旧名**：
  改包名会让系统当成另一个应用，**已安装用户无法覆盖升级、数据会孤立**。
  这是内部标识，不影响用户看到的名字（那是 `strings.xml` 里的 `app_name`）。
