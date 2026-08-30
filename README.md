# dsh-mihome

<p align="center">
  <b>Mi Home (米家) control for <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> agents.</b><br>
  List homes/devices · read props · control devices — every state-changing call stops behind a human approval gate.
</p>

<p align="center">
  <a href="README.zh.md">中文</a> ·
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/dsh--plugin-ecosystem-4d7cfe" alt="dsh-plugin"></a> ·
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT"></a>
</p>

## Features

- Tools: `mi_health`, `mi_list_homes`, `mi_list_devices`, `mi_get_state`, `mi_turn` (set_power, approval-gated), `mi_control` (any `miIO/raw_command`, approval-gated), `mi_wait_for_state`, `mi_dashboard`
- **Full console**: a fixed "🏠 米家" tab at the end of the session's top view ring replaces the chat area with a live Mi Home console (rooms, grouped device cards, props, recent changes, 3s auto-refresh; read-only `/dsh-mihome/state` route)
- **QR login**: DSH **Settings → 米家登录** generates a QR code; scan it with the Mi Home App and the session is saved to `$DSH_HOME/plugin-data/dsh-mihome/session.json` — no passwords, no developer application
- All state-changing calls go through the harness approval seam (`requireApproval` defaults to `true`) plus an optional category allowlist (`allowedCategories`); unresolvable categories are **denied** (least privilege)

## Install

Requires **dsh ≥ 0.1.0-rc.7** (verified against `0.1.1-rc.2`).

```sh
dsh plugin --profile web add dsh-mihome     # from npm (recommended)
# or: dsh plugin --profile web add github:SiriusWJ/dsh-mihome
```

Restart `dsh --profile web` afterwards. Manage it in **Settings → Plugins**.

## Login (either; QR wins)

1. **QR login (recommended):** DSH **Settings → 米家登录** → 生成登录二维码 → scan with the Mi Home App and confirm. Session auto-saves.
2. **Environment variables:** `MIHOME_USERNAME=<mi-account> MIHOME_PASSWORD=<mi-password> dsh --profile web`

```yaml
- id: mihome
  config:
    region: cn               # cn / de / ru / us / tw / sg / in …
    usernameEnv: MIHOME_USERNAME
    passwordEnv: MIHOME_PASSWORD
    requireApproval: true
    allowedCategories: [light, outlet, climate]   # optional allowlist
```

When the stored QR session expires (API returns -1), the plugin clears it and falls back to the environment variables; the settings page has a "退出登录" button.

## How it connects

The cloud adapter implements the community-documented Xiaomi Mi Home app API:

1. Login: password flow (`serviceLogin` → `serviceLoginAuth2`, `sid=xiaomiio`, `md5(password)` uppercased → STS sets `serviceToken`/`ssecurity`) **or** QR flow (`longPolling/loginUrl` → QR PNG + `lp` long-poll → `userId`/`ssecurity`/`location` → STS sets `serviceToken`).
2. Calls to `https://api.io.mi.com/app/<method>` with nonce/signed-nonce (`sha256(ssecurity + nonce)`), RC4-encrypted params + sha1 signature for `v2/*`, hmac-sha256 signature for `miIO/raw_command`.

This is a **non-official protocol** (see [Xiaomi-cloud-tokens-extractor](https://github.com/PiotrMachowski/Xiaomi-cloud-tokens-extractor) / python-miio) and may change if Xiaomi updates the app.

## Development

```sh
pnpm install
pnpm typecheck && pnpm build && pnpm test   # signatures/crypto + QR/session tests
```

Zero runtime dependencies on the host side: Node built-in `crypto`/`fetch`/`fs` only.

## License

MIT
