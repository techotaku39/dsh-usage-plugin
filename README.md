# DSH Usage Plugin

DSH Web UI 的月度用量面板。它把三类数据放在一个页面里：

- **DSH · OpenCode Go**：按 `x-opencode-session` 从 OpenCode 请求日志精确过滤。
- **DSH · 全部渠道**：扫描 `~/.dsh/sessions` 的持久会话日志。
- **OpenCode 账号总览**：读取 OpenCode Console 的账号级用量。

金额显示的是 **Go 额度等价成本**，不是额外现金账单。Go 套餐内仍按订阅计费。

## 安装

```powershell
dsh plugin --profile web add @techotaku39/dsh-usage-plugin
```

然后重启 DSH：

```powershell
dsh web
```

侧边栏会出现「用量」入口。

如果 profile 没有自动启用 bundle，在 `~/.dsh/profiles/<profile>/package.json` 中把包加入 `dsh.profile.bundles`：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@techotaku39/dsh-usage-plugin"
      ]
    }
  }
}
```

## 插件入口

- `sidebar.panellist`：侧边栏「用量」入口
- `main`：月份切换和用量面板
- `/plugins/dsh-usage/api/months`
- `/plugins/dsh-usage/api/summary`

## 配置

默认自动读取：

- `DSH_HOME`，否则 `~/.dsh`
- `OPENCODE_API_KEY` 环境变量，否则 `~/.dsh/.credentials.yaml`
- profile 中的 `x-opencode-session`

可选配置：

```yaml
- insert:
    - id: dsh-usage-plugin
      name: "@techotaku39/dsh-usage-plugin"
      config:
        sessionId: "你的-x-opencode-session"
        timeZone: "Asia/Shanghai"
        dataDir: "C:\\Users\\you\\.dsh\\usage-plugin"
        refreshHours: 6
```

`dataDir` 用于保存 `history.json`。OpenCode 请求日志保留约 30 天；插件会把每月结果归档到该文件，过期后仍可切换查看已归档月份。

## 本地开发

在 `dsh-usage-plugin` 目录运行：

```powershell
node --test test/usage-data.test.mjs
node --check index.js
node --check client.js
node --check lib/usage-data.js
```

## 说明

- 同一 Key 下用不同 `x-opencode-session` 可以分人统计；相同 session ID 会混在一起。
- 插件只读，不修改模型配置、不写 OpenCode 账单。
- OpenCode Console 的请求日志接口属于网页当前使用的接口，未来网站改版可能需要适配。
