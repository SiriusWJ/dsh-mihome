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

**还有 Web UI** —— 会话顶部视图环的「🏠 米家」页签（排在最后）：点击后聊天区域替换为**全屏米家控制台**，房间、按类别分组的设备卡片、实时属性、最近变化，每 3 秒自动刷新，点「聊天」返回。

**设置页扫码登录** —— DSH **设置 → 米家登录** 一键生成二维码，用米家 App 扫一扫并确认，会话自动保存，无需账号密码、无需开发者申请。

## 🎯 能做什么？

像跟管家说话一样指挥你的家——所有写操作都先经过人工审批：

| 你说 | 会发生什么 |
|---|---|
| 「检查米家连接，列出所有设备」 | `mi_health` / `mi_list_devices` 扫描并汇总 |
| 「客厅灯开着吗？卧室呢？」 | `mi_get_state` 按需读取属性 |
| 「给我看看家庭仪表盘。」 | `mi_dashboard` 在对话里渲染**仪表盘卡片** |
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

**界面**

- **顶部视图环「🏠 米家」页签**（最后一位）：点击后聊天区域替换为全屏米家控制台——房间、归类设备卡片、实时属性、最近变化，每 3 秒自动刷新，数据来自只读路由 `/dsh-mihome/state`；侧栏与标题保持不动，点「聊天」返回。
- **设置 → 米家登录**：二维码扫码登录（米家 App 扫一扫 + 确认），状态轮询（等待/已提交/成功/过期/失败）、退出登录；会话保存到 `$DSH_HOME/plugin-data/dsh-mihome/session.json`。

## 📦 安装

需要 **dsh ≥ 0.1.0-rc.7**（0.1.1-rc.2 已实测）。

```sh
# 从 npm 安装（推荐，预构建产物）：
dsh plugin --profile web add dsh-mihome

# 或从 GitHub 安装（源码安装，pnpm 会在安装时自动构建）：
# dsh plugin --profile web add github:SiriusWJ/dsh-mihome
```

安装后重启 `dsh --profile web`。可在 **Settings → Plugins** 管理。

## ⚙️ 配置

在 profile 的 `cordis.patch.yml` 中覆盖插件配置（后层覆盖前层）：

```yaml
- id: mihome
  config:
    region: cn                 # 米家账号区域：cn / de / ru / us / tw / sg / in…
    usernameEnv: MIHOME_USERNAME   # 存放账号的环境变量名
    passwordEnv: MIHOME_PASSWORD   # 存放密码的环境变量名
    timeoutMs: 15000
    requireApproval: true      # 改变状态的调用需要人工批准
    allowedCategories: []      # 可控制类别白名单，例如 [light, outlet, climate]；留空 = 全部允许
    dashboardPropsLimit: 30    # 仪表盘拉取属性的设备上限
    serviceRefreshMs: 20000   # 常驻宿主服务刷新间隔（设备/属性镜像在内存，前端秒开）
    recentBufferSize: 50       # 最近变化缓冲大小
```

### 登录方式（二选一，扫码优先）

1. **扫码登录（推荐）**：DSH **设置 → 米家登录** → 生成登录二维码 → 米家 App 扫一扫并确认。会话自动保存，无需在配置里写任何账号。
2. **环境变量/密码**：`MIHOME_USERNAME=<米家账号> MIHOME_PASSWORD=<米家密码> dsh --profile web`，或 `username` / `password` 写进配置（不推荐）。凭证通过 [credentials 接缝](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/credentials) 每次请求重新解析，轮换无需重启。

扫码会话失效（米家 API 返回 -1）时插件会自动清除会话并回退到环境变量登录；也可在设置页「退出登录」手动清除。

## 🔒 安全说明

- **运输安全**：米家云 API 使用账号密码或扫码换取的一次性会话（serviceToken / ssecurity）；插件不保存密码，QR 会话存于插件数据目录（不进 Git、不进对话日志）。
- **审批闸门**：`mi_turn` / `mi_control` 永远走 harness 的审批接缝（`requireApproval: true` 默认开启）——agent 不经你同意碰不了你的家。
- **类别白名单**：`allowedCategories` 是第二道保险，设置后其他类别的控制调用直接被拒绝，且设备类别解析失败时**默认拒绝**（最小权限）。
- **路由保护**：`/dsh-mihome/*`（含扫码/状态路由）带同源校验；`/dsh-mihome/state` 只读。

## ⚠️ 已知限制

- 云 API（`account.xiaomi.com` / `api.io.mi.com`）**非官方文档**，接口可能随米家 App 更新而变化；本插件按社区验证过的登录/签名流程实现（参考 [Xiaomi-cloud-tokens-extractor](https://github.com/PiotrMachowski/Xiaomi-cloud-tokens-extractor) / python-miio）。
- 米家账号触发验证码/2FA 风控时，请改用**扫码登录**（二维码流程不受影响），或等待风控解除。
- 分组设备（`get_split_device` 的子设备）属性读取可能受限。
- 本地直连（miIO UDP + 设备 token）规划中，接入后不依赖云端即可控制局域网设备。

## 🛠 开发

```sh
pnpm install
pnpm typecheck   # 针对 @deepseek-ai/* 类型做严格 TS 检查
pnpm build       # 打包 lib/（ESM + d.ts）
pnpm test        # 签名/加密原语 + QR 登录/会话持久化测试
```

## 📋 兼容性

- Host 端零运行时依赖：Node 内置 `crypto` / `fetch` / `fs` + 标准库，无 MQTT、无额外守护进程。
- 已针对 npm 发布的 `@deepseek-ai/dsh@0.1.1-rc.2` 类型验证；harness 更新导致不兼容请提 issue。

## 📄 许可证

MIT
