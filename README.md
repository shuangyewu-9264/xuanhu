# 悬壶 · 临床病房模拟

在一间最多容纳四位患者的病房里值班。你可以查看体征、开检查、给药和实施处置，再从监护仪和化验结果中观察病情变化。切换床位后，其余患者的病程仍会推进。

## 开始游戏

电脑上可以直接打开 `web/index.html`，它需要同目录中的 JavaScript 文件。也可以在仓库根目录启动本地网页服务，再访问 [本地游戏](http://localhost:8000/)。

```sh
python -m http.server 8000 --directory web
```

进入病房大厅后选择床位，或点「接诊新患者」。点击人体图上的器官可以查看对应指标。遇到陌生病例时，可使用上级医师提示和行医手册。进度保存在当前浏览器，续玩时请使用同一浏览器和入口。

在病房底部的「菜单」里可以管理存档：

- **重新开始本病例**会重置当前患者的处置和病程。
- **强制移除当前患者（测试用）**会直接腾出这张床，跳过结局统计、病历、手册和成就。移除最后一位患者后，大厅保持空床，可重新接诊。
- **重置游戏存档**需要再次确认，会清空本游戏的所有床位、历史记录和设置。大厅也有同名入口。

## 病房与监护

- 生理引擎根据出血、气道阻力、循环和代谢等因素推演病情。同一种处置在不同患者身上可以产生不同结果。
- 病例涵盖电解质紊乱、中毒、感染及创伤等场景。出血按部位记录，机械通气患者可进行自主呼吸评估和撤机。诊疗记录、趋势图和会诊分享码可用于复盘。
- 选中心脏可查看最近 4 秒的单导联心电图。床旁的心搏音随 R 峰触发，游戏快进时仍按实时心率播放。静音不影响波形。
- 大厅及从大厅打开的工具页只播放高优先级报警。各床位独立报警，室颤响三短声，心静止响较轻的持续音。音量默认 20%，可调节或静音。

## 技术要点

### 机制驱动而非规则驱动

```js
// ❌ 规则驱动：同一个操作在任何病情下结果一样
if (给了胰岛素) 血钾 -= 1.2;

// ✅ 机制驱动：模块只写驱动，引擎统一推导
S.svrDrive = Math.min(16, (S.svrDrive || 8) + 0.012 * dtMin);
const toneTarget = clamp(17.5 * baro * (0.45 + 0.55 * reserve) * pressorGain
    - (S.infection || 0) * 11.0
    + (S.svrDrive || 0)
    + clamp(((S.icp || 0) - 0.60) * 45, 0, 18), 4, 42);
```

### 氧合：分流方程

```js
// SaO₂ = (1−Qs/Qt)·Hill(PaO₂) + Qs/Qt·SvO₂
// SvO₂ 由 Fick 方程推出：SvO₂ = 1 − VO₂/DO₂
S.sao2 = clamp((1 - S.shunt) * hill(S.pao2) + S.shunt * svo2Prev, 0.15, 1);
```

同样的分流，循环越差血氧越低——这是机制自然产生的，不是特判。

### 出血按部位记账

```js
// 每个出血点独立计速率，止血只影响对应部位
S.bleedingSites[site] = rate;
S.bleedRate = Object.values(S.bleedingSites).reduce((a, b) => a + b, 0);
```

## 构建与发布

在仓库根目录使用 Python 3.8 或更高版本。网页构建只使用 Python 标准库。

| 用途 | 命令 | 结果 |
| --- | --- | --- |
| 发送给玩家离线游玩 | `python tools/build_singlefile.py` | `dist/xuanhu-single.html`，可单独打开 |
| 部署静态网站 | `python tools/build_site.py` | 将 `dist/部署包/` 的内容放到站点目录 |
| 上传网站压缩包 | `python tools/build_site_zip.py` | `dist/悬壶-网站包.zip`，解压后根目录即为站点入口 |

网站首页直接进入游戏，`download.html` 提供下载，`privacy.html` 展示隐私政策，`version.json` 列出本次构建包含的产物。

### Android APK

原版的发布脚本引用过 `app/android/`。公开仓库缺少 Android 工程、Gradle Wrapper 和 Capacitor 配置，因此从这份源码可直接构建网页版和离线 HTML；复现原版 APK 需要原作者的 Android 封装工程。发布同一应用的更新还需要沿用原有的签名流程。

如果已有与本次网页版本匹配的 APK，将它放在 `dist/` 后运行 `python tools/build_site_zip.py`。脚本会取最近修改的 `.apk`，以 `xuanhu.apk` 加入站点和网站 ZIP。没有 APK 时，下载页只提供网页和离线版入口。

## 源码与文档

游戏源码在 `prototype/`，页面入口是 `ui-v4.html`。`web/` 是可直接打开的同步副本。修改源码后，按顺序运行以下两条命令更新并核对网页版。

```sh
python tools/build_site.py --sync-web
python tools/build_site.py --check-web
```

开发者从 Git 克隆仓库后，可用 Node.js 20 或更高版本运行 `npm test` 验证生理引擎、病例和心电时序。`npm ci` 后运行 `npm run test:browser` 可在浏览器复核出院和归档；可以使用本机 Edge 或通过 `BROWSER_EXECUTABLE` 指定 Chromium 浏览器。发布用的源码 ZIP 和网站包仅包含运行与构建所需的内容及配套文档。

`tools/` 也包含独立的软著材料生成工具，`docs/` 保存玩法、模型设计及历次版本资料。模型设计和数据处理说明见[技术剖析](docs/技术剖析.md)和[隐私政策](docs/隐私政策.md)。

> **关于测试脚本的保留说明**
>
> `tools/` 下的脚本不参与游戏运行，打包时也不会进入 APK、网页包或离线 HTML，
> 对游玩没有任何影响。保留它们是为了在修改生理引擎后能快速回归，
> 避免「改了 A 坏了 B」。只想发布的话可以整目录删除。
> 按 `.gitattributes`，发布归档（`git archive`）会自动排除这些脚本。
>
> 浏览器端测试需要先 `npm install`（仅 `playwright-core`）。

本作为医学教学模拟，建议 16 岁以上玩家使用。病例、数值及处置效果仅供模拟学习，请勿用于真实诊疗。代码采用 [MIT 许可证](LICENSE)。
