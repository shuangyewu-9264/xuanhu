# -*- coding: utf-8 -*-
"""生成软著申报材料：
   1) 源代码文档.docx  —— 前 30 页 + 后 30 页，每页 50 行
   2) 软件说明书.docx  —— 用户手册（约 20 页）
"""
import glob
from docx import Document
from docx.shared import Pt, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml.ns import qn

import os
from pathlib import Path

ROOT = str(Path(__file__).resolve().parent.parent)
OUT = os.path.join(ROOT, '软著')
os.makedirs(OUT, exist_ok=True)

SOFT_NAME = '悬壶临床病房模拟训练软件'
VERSION = 'V1.0'

# ---------------- 1) 源代码 ----------------
ORDER = ['engine.js', 'generator.js', 'substances.js', 'game.js', 'diagnosis.js',
         'handbook.js', 'mentor.js', 'signs.js', 'share.js', 'chart.js',
         'achievements.js', 'glossary.js', 'traits.js', 'tutorial.js', 'sound.js']
lines = []
for name in ORDER:
    p = os.path.join(ROOT, 'prototype', name)
    if not os.path.exists(p):
        continue
    lines.append('/* ================== ' + name + ' ================== */')
    with open(p, encoding='utf-8') as f:
        for ln in f.read().split('\n'):
            lines.append(ln.rstrip())

# HTML 也算源码的一部分
html_p = os.path.join(ROOT, 'prototype', 'ui-v4.html')
if os.path.exists(html_p):
    lines.append('<!-- ================== ui-v4.html ================== -->')
    with open(html_p, encoding='utf-8') as f:
        for ln in f.read().split('\n'):
            lines.append(ln.rstrip())

LINES_PER_PAGE = 50
PAGES = 30
head = lines[:PAGES * LINES_PER_PAGE]
tail = lines[-(PAGES * LINES_PER_PAGE):]

doc = Document()
sec = doc.sections[0]
sec.page_width, sec.page_height = Cm(21.0), Cm(29.7)
sec.top_margin = sec.bottom_margin = Cm(2.0)
sec.left_margin = sec.right_margin = Cm(2.2)

style = doc.styles['Normal']
style.font.name = 'Consolas'
style.font.size = Pt(8)
style.element.rPr.rFonts.set(qn('w:eastAsia'), '宋体')
style.paragraph_format.space_before = Pt(0)
style.paragraph_format.space_after = Pt(0)
style.paragraph_format.line_spacing = 1.0


def add_header(page_no):
    """页眉：软件名称 + 版本 + 页码"""
    hdr = sec.header
    p = hdr.paragraphs[0]
    p.text = ''
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run('%s %s    第 %d 页' % (SOFT_NAME, VERSION, page_no))
    r.font.size = Pt(9)
    r.font.name = '宋体'


def write_pages(chunk, start_page):
    page = start_page
    for i in range(0, len(chunk), LINES_PER_PAGE):
        block = chunk[i:i + LINES_PER_PAGE]
        add_header(page)
        for ln in block:
            p = doc.add_paragraph()
            if ln.strip() == '':
                r = p.add_run(' ')
            else:
                r = p.add_run(ln)
            r.font.name = 'Consolas'
            r.font.size = Pt(8)
        page += 1
        if i + LINES_PER_PAGE < len(chunk):
            doc.add_page_break()
    return page


p1 = write_pages(head, 1)
doc.add_page_break()
write_pages(tail, p1)

src_path = os.path.join(OUT, '源代码文档.docx')
doc.save(src_path)
print('源代码文档:', src_path, '| 共', p1 * 2 - 1, '页（前30+后30）')

# ---------------- 2) 软件说明书 ----------------
d = Document()
d.sections[0].page_width, d.sections[0].page_height = Cm(21.0), Cm(29.7)
d.sections[0].top_margin = d.sections[0].bottom_margin = Cm(2.5)
d.sections[0].left_margin = d.sections[0].right_margin = Cm(2.8)
st = d.styles['Normal']
st.font.name = '宋体'
st.font.size = Pt(11)
st.element.rPr.rFonts.set(qn('w:eastAsia'), '宋体')


def H(text, level=1):
    p = d.add_heading(text, level=level)
    for r in p.runs:
        r.font.name = '黑体'
        r._element.rPr.rFonts.set(qn('w:eastAsia'), '黑体')
    return p


def P(text, bold=False, indent=True):
    p = d.add_paragraph()
    if indent:
        p.paragraph_format.first_line_indent = Pt(22)
    p.paragraph_format.line_spacing = 1.5
    r = p.add_run(text)
    r.bold = bold
    r.font.name = '宋体'
    r._element.rPr.rFonts.set(qn('w:eastAsia'), '宋体')
    return p


title = d.add_paragraph()
title.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = title.add_run('%s\n%s\n用户说明书' % (SOFT_NAME, VERSION))
r.font.size = Pt(22)
r.bold = True
r.font.name = '黑体'
r._element.rPr.rFonts.set(qn('w:eastAsia'), '黑体')
d.add_page_break()

H('一、软件概述', 1)
P('本软件是一款医学临床思维训练类模拟软件。玩家扮演病房值班医生，同时管理最多四张病床，在持续流逝的'
  '时间内对患者进行病情评估、检查开具、药物给予与临床操作，目标是使患者脱离危险并达到出院标准。')
P('软件内置生理引擎，以容量、电解质、酸碱、氧合、循环、凝血、内分泌等状态变量驱动生命体征变化；'
  '所有病理模块仅向引擎写入负荷与驱动量，不直接改写生命体征，因此"同一操作在不同病理下后果不同"。')
P('软件包含三十余种临床病例、两百余种可给予物质、七十余条术语释义，并配有行医手册、病例档案、'
  '指标走势图、成就系统等辅助功能。')

H('二、运行环境', 1)
P('操作系统：Android 9.0 及以上（移动端）；或支持 HTML5 的现代浏览器（网页端）。')
P('硬件要求：内存 2GB 及以上，屏幕分辨率 720×1280 及以上。')
P('网络：本地运行无需联网；在线更新、在线版、问题反馈为可选功能。')
P('权限：仅需网络权限（用于可选的在线功能）。')

H('三、安装与启动', 1)
P('安卓端：安装提供的安装包，授予"未知来源应用"安装权限，安装完成后点击桌面图标即可启动。')
P('网页端：使用浏览器打开提供的网址即可运行，无需安装。')
P('首次启动进入大厅页面，可选择开始新病例、继续既有床位、查看教程或调整难度。')

H('四、界面说明', 1)
H('4.1 主界面', 2)
P('主界面中央为人体的器官示意图，包含脑、肺、心脏、肝脏、胃、脾、胰腺、肾脏、肠道、生殖器官等部位。'
  '点击任一器官可显示该器官相关的生理指标；点击心脏时额外显示实时心电图。')
P('左侧为生命体征区，显示心率、血压、呼吸频率、血氧饱和度、体温、意识状态六项核心指标，'
  '并按数值范围以颜色区分正常、异常与危急。')
P('右上角为游戏时钟与时间倍率控制，可切换一倍、四倍、十六倍速度或快进。')
P('右下角为操作入口，分别对应给药、临床操作、身体检查与更多功能。')
P('底部为菜单入口，包含会诊、费用与医保、检查更新、反馈问题、统计、病历档案、行医手册、'
  '指标走势、术语表、成就、难度设置、昼夜模式、现实模式等。')

H('4.2 给药面板', 2)
P('给药面板提供搜索框与分类标签，可按药品、细胞与血制品、病毒与细菌、食物等类别浏览，'
  '顶部另有"常用"与"急救"两组置顶药品。')
P('选择药物后进入给药配置页面，可选择给药途径并调节剂量。剂量由玩家自行决定，'
  '过量或不足都会产生相应的生理后果。')

H('4.3 检查与报告', 2)
P('病情危重（如意识障碍、休克、严重低氧、严重电解质紊乱等）时，血液指标以监护方式实时更新；'
  '病情稳定时，需主动开具检查（血常规、电解质肾功能、动脉血气等），待检查完成后才能获得新的化验结果。')

H('五、核心玩法', 1)
H('5.1 病例与目标', 2)
P('每个病例包含主诉、查体要点、初始生理状态与出院判据。玩家需在限定时间内使患者达到出院标准；'
  '若未及时处理，病情将按病理机制恶化，直至死亡。')
H('5.2 多床位并发', 2)
P('软件最多支持四张病床同时运行，各床时间同步流逝。玩家可在床位间切换，'
  '每位患者的病情在其床位后台持续推进，因此需要权衡处理顺序。')
H('5.3 难度与模式', 2)
P('病例难度分为五档：普通、重症、危重、极危、噩梦，难度越高病理数量越多、恶化速度越快。'
  '指导强度可调，决定上级医师提示的详略。')
P('昼夜模式：夜间模式下病情推进速度提高，界面转为深色。')
P('现实模式：启用医疗费用与医保结算，玩家需关注患者家庭的自付负担。')

H('六、辅助功能', 1)
H('6.1 行医手册', 2)
P('自动记录已接诊病例的诊断、处置与结局，形成个人病例档案，可按结局筛选与回顾。')
H('6.2 指标走势', 2)
P('以曲线方式展示血压、心率、血钾、血钠、血糖、体温、血氧、乳酸等指标随时间的变化，'
  '血钾与血钠采用双纵轴显示。')
H('6.3 会诊', 2)
P('可将当前病例生成一段分享文本（含病例标识、患者信息、全部处置记录与结局），'
  '其他使用者粘贴后可查看处置思路并接手重演该病例。')
H('6.4 问题反馈', 2)
P('反馈功能自动汇总软件版本、当前病例、生命体征与最近操作记录，并附会诊码，'
  '便于问题复现。使用者可选择复制文本或直接提交。')
H('6.5 在线更新', 2)
P('软件可检查版本更新，提示下载新版本或直接打开在线版。')

H('七、数据结构说明', 1)
P('软件采用纯前端架构，全部逻辑在客户端运行，不依赖服务器。')
P('核心状态对象包含：循环（心率、每搏输出量、外周阻力、容量）、呼吸（呼吸频率、潮气量、'
  '分流、肺水）、代谢（血糖、乳酸、酸碱）、电解质（钾、钠、氯、钙）、血液（血红蛋白、'
  '血小板、凝血）、神经（意识、颅压）等类别。')
P('药物动力学采用一阶动力学近似，记录给药时刻、起效时间、持续时间、效应方向与剂量缩放系数，'
  '并由引擎每周期根据当前浓度计算实际效应。')

H('八、常见问题', 1)
P('问：为什么给了药指标没有变化？答：药物存在起效时间，且部分病理机制会抵消药物效应，'
  '需结合病理判断。')
P('问：为什么病情稳定时化验结果不更新？答：稳定患者不进入持续监护，需主动开具检查。')
P('问：数据保存在哪里？答：全部保存在本机，不上传服务器。清除应用数据将丢失进度。')

H('九、版本记录', 1)
P('V1.0　首次发布：包含三十余种病例、两百余种物质、行医手册、会诊分享、'
  '多床位管理、昼夜与难度模式、费用与医保结算等功能。')

man_path = os.path.join(OUT, '软件说明书.docx')
d.save(man_path)
print('软件说明书:', man_path)
