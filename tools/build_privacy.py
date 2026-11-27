# -*- coding: utf-8 -*-
"""把隐私政策生成一个可部署的静态页面 dist/privacy.html"""
import os

from pathlib import Path

ROOT = str(Path(__file__).resolve().parent.parent)
DIST = os.path.join(ROOT, 'dist')

HTML = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>悬壶 · 隐私政策</title>
<style>
  :root{--bg:#f4f2f1;--ink:#141414;--ink2:#6b6b6b;--card:#fff;--line:#e8e4e2;--red:#d33a3a}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;padding:24px 16px 60px}
  .wrap{max-width:720px;margin:0 auto}
  h1{font-size:24px;margin:0 0 6px}
  .sub{color:var(--ink2);font-size:12.5px;margin-bottom:20px}
  h2{font-size:16px;margin:26px 0 8px;padding-top:6px;border-top:1px solid var(--line)}
  p,li{font-size:14px;color:#333}
  table{width:100%;border-collapse:collapse;margin:10px 0;font-size:13px}
  th,td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}
  th{background:#faf8f7;font-weight:600}
  .warn{margin-top:22px;padding:14px;border-radius:12px;background:rgba(211,58,58,.06);border:1px solid rgba(211,58,58,.2);font-size:13px}
  a{color:var(--red)}
</style>
</head>
<body>
<div class="wrap">
  <h1>悬壶 · 隐私政策</h1>
  <div class="sub">生效日期：2026 年 11 月 27 日 ｜ 适用版本 v1.49.x 及以后</div>

  <h2>一、我们收集哪些信息</h2>
  <p><b>我们不收集你的个人身份信息。</b></p>
  <table>
    <tr><th>类型</th><th>是否收集</th><th>说明</th></tr>
    <tr><td>姓名、手机号、身份证号</td><td>不收集</td><td>游戏无账号系统</td></tr>
    <tr><td>位置信息</td><td>不收集</td><td>不申请定位权限</td></tr>
    <tr><td>通讯录、相册、短信</td><td>不收集</td><td>不申请相关权限</td></tr>
    <tr><td>设备唯一标识</td><td>不收集</td><td>不做设备追踪</td></tr>
    <tr><td>游戏进度</td><td>仅存本地</td><td>存放在你设备的 localStorage，不上传</td></tr>
  </table>

  <h2>二、游戏过程中产生的数据</h2>
  <p><b>1. 游戏进度（本地）</b>：床位、病例、行医手册、成就、设置，全部存在你设备上，不会离开你的设备。清除浏览器数据或卸载应用会删除，我们无法恢复。</p>
  <p><b>2. 你主动提交的反馈（可选）</b>：当你点击「反馈问题」并提交时，会发送游戏版本、平台、当前病例与体征、最近操作记录，以及你自己写的问题描述。<b>只用于定位和修复问题</b>。不提交则什么都不会发送。</p>
  <p><b>3. 不会自动上传任何数据</b>：没有埋点、没有广告 SDK、没有第三方分析工具。</p>

  <h2>三、权限说明</h2>
  <p>安卓版仅申请 <code>INTERNET</code> 权限，用于检查更新、加载在线版（可选）、提交反馈（可选）。不申请存储、相机、麦克风、定位、通讯录等权限。</p>

  <h2>四、第三方服务</h2>
  <table>
    <tr><th>服务</th><th>用途</th><th>涉及数据</th></tr>
    <tr><td>Netlify</td><td>托管网页版与更新文件</td><td>常规访问日志（IP、时间、UA）</td></tr>
    <tr><td>TapTap（如上架）</td><td>应用分发</td><td>由 TapTap 按其隐私政策处理</td></tr>
  </table>

  <h2>五、未成年人</h2>
  <p>本作是医学教学模拟，包含疾病、抢救、死亡等内容，建议 16 岁以上玩家使用。我们不面向儿童收集任何信息。</p>

  <h2>六、你的权利</h2>
  <p>查看：所有数据在设备本地；删除：清除浏览器数据或卸载应用即彻底删除；撤回：不点击提交反馈即不产生任何数据外发。</p>

  <h2>七、数据安全</h2>
  <p>游戏不上传个人数据，不存在服务器端泄露风险。本地数据安全取决于你的设备。</p>

  <h2>八、联系我们</h2>
  <p>邮箱：（待填写）｜ 或通过 TapTap 开发者页面留言</p>

  <div class="warn">
    <b>特别声明</b>：本作是教学模拟游戏，所有病例、数值、治疗建议均为教学演示，<b>不构成任何医疗建议</b>，不能用于真实诊疗。如有健康问题请就医。
  </div>
</div>
</body>
</html>
"""

out = os.path.join(DIST, 'privacy.html')
with open(out, 'w', encoding='utf-8') as f:
    f.write(HTML)
print('隐私政策页面:', out)
