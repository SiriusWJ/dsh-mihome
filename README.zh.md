# dsh-mihome

<p align="center">
  <b>给 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> agent 的米家（Xiaomi Home）控制插件。</b><br>
  读取家庭/设备 · 查询属性 · 控制设备——所有改变状态的调用都经过人工审批闸门。
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/dsh--plugin-ecosystem-4d7cfe" alt="dsh-plugin"></a> ·
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT"></a>
</p>

## ✨ 效果预览

| ① 提问 | ② 审批闸门 | ③ 完成——状态真的变了 |
|---|---|---|
| agent 用 `mi_list_devices` 列出你的设备。 | `mi_turn` / `mi_control` 暂停，弹出人工审批框。 | 批准后设备状态更新，`mi_get_state` 确认。 |

**还有 Web UI 仪表盘卡片** —— 调用 `mi_dashboard`，全屋状态直接渲染在对话里：

```
🏠 米家仪表盘 · 14 台设备 · 12 在线 · 18:32:05
🏠 客厅  🏠 卧室  🏠 厨房
💡 灯光        💡 客厅灯  on · brightness 100%      💡 卧室灯  off
🔌 插座        🔌 客厅插线板  on · 32 W              …
📊 传感器      🌡️ 客厅温湿度  temperature 22.5°C   💧 卧室温湿度  humidity 52%
…
🕐 最近变化    卧室灯: power — → on   18:31
```

**没有米家账号也能玩** —— 自带演示模拟器（`pnpm demo:mi`）+ 交互式演示页（`docs/demo.html`），5 分钟完整体验。

## 🎯 能做什么？

像跟管家说话一样指挥你的家——所有写操作都先经过人工审批：

| 你说 | 会发生什么 |
|---|---|
| 「检查米家连接，列出所有设备」 | `mi_health` / `mi_list_devices` 扫描并汇总 |
| 「客厅灯开着吗？卧室呢？」 | `mi_get_state` 按需读取属性 |
| 「给我看看家庭仪表盘。」 | `mi_dashboard` 在对话里渲染**实时仪表盘卡片**——分类、房间、最近变化一览无余 |
| 「关掉卧室灯。」 | `mi_turn` → **审批弹窗** → 执行 → 状态即时更新 |
| 「把客厅灯调到 60% 亮度。」 | `mi_control`（set_bright）→ **审批弹窗** → 执行 |
| 「等空调到 24° 再告诉我。」 | `mi_wait_for_state` 轮询到目标状态 |
| 「出门模式：把所有灯都关掉。」 | 批量 `mi_turn`（每条都过审批） |

## 🛠 功能

| 工具 | 说明 | 审批 |
|---|---|---|
| `mi_health` | 验证连接；返回账号、区域、家庭数、设备数 | 只读 |
| `mi_list_homes` | 列出家庭与房间（home_id / owner_id / 房间） | 只读 |
| `mi_list_devices` | 列出设备，按名称/类别过滤（light、outlet、sensor、climate…） | 只读 |
| `mi_get_state` | 单设备状态：在线状态、类别、常见属性（power/brightness/温度/湿度/电量…） | 只读 |
| `mi_turn` | `set_power` 开/关设备 | **需批准** |
| `mi_control` | 任意 miIO raw_command：set_bright、set_properties（MIoT）… | **需批准** |
| `mi_wait_for_state` | 轮询等待属性达到/离开某个状态 | 只读 |
| `mi_dashboard` | 全屋快照，在 Web UI 渲染为**仪表盘卡片** | 只读 |

## 📦 安装

需要 **dsh ≥ 0.1.0-rc.7**（0.1.1-rc.2 已实测）。

```sh
# 从 npm 安装（推荐，预构建产物）：
dsh plugin --profile web add dsh-mihome

# 或从 GitHub 安装（源码安装，pnpm 会在安装时自动构建）：
# dsh plugin --profile web add github:<owner>/dsh-mihome
```

安装后重启 `dsh --profile web`。可在 **Settings → Plugins** 管理。

## 🧪 没有米家账号？先玩演示模式

```sh
git clone https://github.com/SiriusWJ/dsh-mihome
cd dsh-mihome
pnpm install
pnpm demo:mi          # 在 http://127.0.0.1:8125 起一个假的米家云
```

在 profile 的 `cordis.patch.yml` 里配置：

```yaml
- id: mihome
  config:
    mode: demo
    baseUrl: http://127.0.0.1:8125
```

然后启动 dsh 试试：

> 「检查米家连接，然后列出所有设备。」
>
> 「把卧室灯调到 60 亮度。」——会弹出审批请求；批准后 `mi_get_state` 显示 `brightness: 60`。
>
> 「关掉客厅里所有的灯。」

模拟器里的温度传感器每几秒漂移一次，所以仪表盘和「最近变化」永远有新数据。

**想完全不启动 dsh 就先看效果？** 用浏览器打开 [`docs/demo.html`](docs/demo.html)：模拟 DSH 对话（工具卡片 + 审批弹窗），右侧实时控制台直连模拟器做真实调用。

可直接粘贴的配置（演示 / 真实米家 / 关闭审批）见 [`examples/cordis.patch.yml`](examples/cordis.patch.yml)。

## ⚙️ 配置

在 profile 的 `cordis.patch.yml` 中覆盖插件配置（后层覆盖前层）：

```yaml
- id: mihome
  config:
    mode: cloud                # cloud 或 demo
    region: cn                 # 米家账号区域：cn / de / ru / us / tw / sg / in…
    usernameEnv: MIHOME_USERNAME   # 存放账号的环境变量名
    passwordEnv: MIHOME_PASSWORD   # 存放密码的环境变量名
    timeoutMs: 15000
    requireApproval: true      # 改变状态的调用需要人工批准
    allowedCategories: []      # 可控制类别白名单，例如 [light, outlet, climate]；留空 = 全部允许
    dashboardPropsLimit: 30    # 仪表盘拉取属性的设备上限
    recentBufferSize: 50       # 最近变化缓冲大小
```

然后带上环境变量启动：

```sh
MIHOME_USERNAME=<米家账号> MIHOME_PASSWORD=<米家密码> dsh --profile web
```

`username` / `password` 也可以直接写进配置，但**强烈建议**用 `usernameEnv` / `passwordEnv` 走环境变量或 [credentials 接缝](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/credentials)——凭证每次请求重新解析，轮换无需重启。

## 🔒 安全说明

- **运输安全**：米家云 API 使用账号密码登录换取一次性会话（serviceToken / ssecurity），插件不在本地保存密码，只在使用时通过凭证接缝读取。
- **审批闸门**：`mi_turn` / `mi_control` 永远走 harness 的审批接缝（`requireApproval: true` 默认开启）——agent 不经你同意碰不了你的家。
- **类别白名单**：`allowedCategories` 是第二道保险，设置后其他类别的控制调用直接被拒绝，且设备类别解析失败时**默认拒绝**（最小权限）。
- **账号安全**：建议开启米家 App 的「设备授权」验证；如账号触发验证码/2FA 登录（部分账号会有安全风控），当前版本会给出明确报错——这种情况请用无 2FA 的账号或等待风控解除。

## ⚠️ 已知限制

- 云 API（`account.xiaomi.com` / `api.io.mi.com`）**非官方文档**，接口可能随米家 App 更新而变化；本插件按社区验证过的登录/签名流程实现（参考 [Xiaomi-cloud-tokens-extractor](https://github.com/PiotrMachowski/Xiaomi-cloud-tokens-extractor) / python-miio）。
- 不支持的场景：米家账号需验证码/2FA；分组设备（`get_split_device` 的子设备）属性读取可能受限。
- 本地直连（miIO UDP + 设备 token）规划中，接入后不依赖云端即可控制局域网设备。

## 🛠 开发

```sh
pnpm install
pnpm typecheck   # 针对 @deepseek-ai/* 类型做严格 TS 检查
pnpm build       # 打包 lib/（ESM + d.ts）
pnpm test        # 签名/加密原语 + 演示服务器端到端测试
```

## 📋 兼容性

- Host 端零运行时依赖：Node 内置 `crypto` / `fetch` + 标准库，无 MQTT、无额外守护进程。
- 已针对 npm 发布的 `@deepseek-ai/dsh@0.1.1-rc.2` 类型验证；harness 更新导致不兼容请提 issue。

## 📄 许可证

MIT
