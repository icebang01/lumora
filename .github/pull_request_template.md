# 代码评审清单（Senior Review Checklist / DoD）

> 合并前逐项确认。本清单锚定 Lumora 真实架构风险，不是泛泛而谈——每一条背后都有历史 bug 或 ADR。

## 架构与状态
- [ ] 共享可变状态是否走 ctx getter/setter（ADR-0001/0002），**有无传值引用**（历史头号 bug 类：setPlaylist 整体替换引用后旧引用即失效）
- [ ] 音视频 throttle 是否保持**独立**水位（bug #7/#8 教训：socketFull 只控视频，音频由渲染端缓冲水位控制）
- [ ] 新增 WebGL2 / 原生能力是否有 try/catch 降级（GPU 会话崩溃历史：WebGL2 不可用时降级纯音频）

## 模块与依赖
- [ ] 新模块是否跑了 `node tools/scan-reverse-leaks.js <宿主> <模块>`（未导出/未导入双向漏网）
- [ ] 是否引入循环依赖（ctx 注入模式即为此而生，直接 require 宿主会循环）

## 工程纪律（铁律）
- [ ] 源文件 LF 行尾（`.gitattributes` 归一，无 CRLF；pre-commit 钩子已自动拦）
- [ ] 无 `node -e` / `node -c` 内联脚本
- [ ] 改完跑了 `npm run lint:syntax && npm run test:unit && npm run typecheck`
- [ ] 涉及播放/IPC/窗口的改动是否补了冒烟回归（`npm run test:smoke`）

## 测试与文档
- [ ] 核心逻辑变更是否补了单测（目标：核心模块单测覆盖，见 `npm run test:cov:report` 的 c8 报告）
- [ ] 模块结构变更是否同步 `MODULES.md`；约定变更是否更新 `AGENTS.md` / 新增 ADR

## 自测说明
<!-- 简述本次改动如何验证（命令 + 结果），便于评审者复现 -->
