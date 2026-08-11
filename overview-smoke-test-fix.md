# 修复启动报错 Cannot find module './smoke-test'

## 问题
启动 Lumora 时主进程抛异常：

```
Uncaught Exception:
Error: Cannot find module './smoke-test'
Require stack:
- D:\IDEA\videos\src\main\index.js
```

## 根因
工作树中有 68 个已跟踪源文件被意外删除，其中包括 `src/main/smoke-test.js`。
`src/main/index.js` 又在顶层无条件 `require('./smoke-test')`，所以普通启动也会因模块缺失而崩溃。

## 修复内容
1. **恢复被删文件**：通过 `git ls-files --deleted | xargs git restore --staged --worktree` 把 68 个被删的核心源文件全部恢复（含 smoke-test.js、eq.js、protocol.js 等）。
2. **防御性延迟加载**：在 `src/main/index.js` 中把 `require('./smoke-test')` 改为按需加载。新增 `getSmokeTest()` 懒加载函数，仅当 `SMOKE` 或任意 `TEST_*` 测试标志激活时才真正加载；普通启动不再依赖该模块。

## 提交
- `ead0f84` fix(main): smoke-test 模块改为按需延迟加载，避免普通启动报错

## 推送
`git push` 直接成功：`67933fc..ead0f84`。

## 门禁结果
- lint:syntax：145/145 通过
- lint:imports：通过
- test:unit：111/111 通过
- typecheck：通过
- pre-commit：4/4 通过

## 验证
彻底杀掉 Lumora 所有进程（含托盘）后重新启动，不应再出现 `./smoke-test` 模块错误。
