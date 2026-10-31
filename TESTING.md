# DSH Usage Plugin Test Report

测试日期：2026-11-01（Asia/Shanghai）  
环境：Windows / Node.js 24.20.0 / DSH 0.2.1-rc.5

## 自动化测试

```text
node --test dsh-usage-plugin/test/usage-data.test.mjs
```

结果：6 passed / 0 failed

覆盖：

- 时区月份切分
- 跨年上个月计算
- 月份列表排序与当前月
- 默认月份选择
- 本机 DSH 会话日志聚合
- OpenCode 请求日志精确 session 过滤

## 配置与安装

- 隔离 profile：`~/.dsh/profiles/usage-test`
- 日常 profile：`~/.dsh/profiles/web`
- `dsh --profile web --dump-config`：exit code 0，包含 `dsh-usage-plugin`
- 日常 profile 备份：`*.bak-20261101-010732-before-dsh-usage`

## 真实运行测试

- 启动 `dsh --profile web --no-open --port 3022`：成功
- `GET /plugins/dsh-usage/api/months`：200
- `GET /plugins/dsh-usage/api/summary?month=2026-10`：200
- 2026-10 DSH OpenCode 精确口径：4 requests / 61,037 tokens / $0.0062273 allowance
- 2026-10 DSH 全渠道：19 requests / 298,392 tokens
- 2026-09 DSH 全渠道：4,055 requests / 1,008,373,611 tokens
- 月份下拉实际显示：2026-11、2026-10、2026-09，切换成功
- 深浅色主题：均正常渲染
- 导出 JSON：成功生成 `dsh-usage-2026-11.json`

## 接口边界测试

| 测试 | 结果 |
|---|---|
| 非法月份 `month=bad` | 400 |
| POST 请求 | 405 |
| 跨域 Origin | 403 |

## 已知限制

- OpenCode 请求日志约保留 30 天；插件依赖 `history.json` 保存月度快照。
- OpenCode Console 请求日志接口属于网页当前使用的接口，网站改版时可能需要适配。
- 同一 OpenCode Key 下如果两个人使用相同 `x-opencode-session`，用量会混在一起。
- Go 套餐内的 Cost / Allowance 是额度等价成本，不是额外现金账单。
