# 历史脚本归档

这里放的是开发过程中用过的一次性脚本，**不参与构建、不进产物**。
保留它们只是为了说明某条机制 / 某个数值是怎么来的，方便以后追溯。

| 脚本 | 作用 |
| --- | --- |
| `patch_identity_rand.py` | 患者身份随机化 |
| `fix_defects1.py` | 尿量对容量敏感化 / 更年期潮热 / 性别约束 |
| `fix_science.py` | 科学审计修正：SpO₂ 与 SVR 上限 |
| `fix_unwinnable.py` | 低钠不可通关、肺水肿撤氧、烧伤撤机 |
| `add_missing_drugs.py` | 补齐甲泼尼龙、西地兰等缺失药物 |
| `add_drugs2.py` | 补齐泼尼松、氨溴索等药物 |
| `patch_alias.py` | 药名别名表 |
| `fix_hormone_give.py` | 性激素走给药路径而非 PK 积分 |
| `patch_ins_switch.py` | 医保参保类型切换 |
| `patch_difficulty.py` | 难度重排：合并为两档 + 新增三档 |
| `patch_presentation.py` | 开局必定发病（预热到出现异常） |
| `update_content_scripts2.py` | 测试脚本适配新判定 |

所有本机绝对路径已在归档时替换为相对路径，工作目录为仓库根。
其余一次性脚本（共 140 多个）没有收录——它们只对当时那一次改动有意义。
