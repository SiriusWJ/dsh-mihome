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

- **`mi_health`** — connection check (account, region, home/device counts)
- **`mi_list_homes`** — homes and rooms
- **`mi_list_devices`** — devices with category/online status, filterable
- **`mi_get_state`** — one device's common props (power, brightness, temperature, humidity, …)
- **`mi_turn`** — `set_power` on/off (**approval-gated**)
- **`mi_control`** — any `miIO/raw_command` (set_bright, set_properties/MIoT, …) (**approval-gated**)
- **`mi_wait_for_state`** — poll a property until it reaches/leaves a state
- **`mi_dashboard`** — full-home snapshot rendered as a **live dashboard card** in the Web UI (grouped by category, rooms, recent changes)

All state-changing calls go through the harness approval seam (`requireApproval` defaults to `true`) plus an optional category allowlist (`allowedCategories`). When the category cannot be resolved, the call is **denied** (least privilege).

## Install

Requires **dsh ≥ 0.1.0-rc.7** (verified against `0.1.1-rc.2`).

```sh
dsh plugin --profile web add dsh-mihome     # from npm (recommended)
# or: dsh plugin --profile web add github:<owner>/dsh-mihome
```

Restart `dsh --profile web` afterwards. Manage it in **Settings → Plugins**.

## No Xiaomi account? Demo mode

```sh
git clone https://github.com/SiriusWJ/dsh-mihome
cd dsh-mihome && pnpm install && pnpm demo:mi    # fake Mi Home Cloud on http://127.0.0.1:8125
```

```yaml
- id: mihome
  config:
    mode: demo
    baseUrl: http://127.0.0.1:8125
```

Then in DSH: *"check Mi Home and list all devices"*, *"turn the bedroom light to 60 brightness"* (an approval popup appears; after approving, `mi_get_state` confirms `brightness: 60`). Open [`docs/demo.html`](docs/demo.html) to see the full UI without starting dsh at all — simulation chat, approval dialog and a live console connected to the emulator.

Paste-ready configs (demo / real cloud / no approval) are in [`examples/cordis.patch.yml`](examples/cordis.patch.yml).

## Real Mi Home (cloud)

```sh
MIHOME_USERNAME=<mi-account> MIHOME_PASSWORD=<mi-password> dsh --profile web
 ```

```yaml
- id: mihome
  config:
    mode: cloud
    region: cn               # cn / de / ru / us / tw / sg / in …
    usernameEnv: MIHOME_USERNAME
    passwordEnv: MIHOME_PASSWORD
    requireApproval: true
    allowedCategories: [light, outlet, climate]   # optional allowlist
```

Credentials resolve through the harness credentials seam on every request (process env → `.env` fallback), so rotating them takes effect on the next call.

## How it connects

The cloud adapter implements the community-documented Xiaomi Mi Home app API:

1. Login via `account.xiaomi.com/pass/serviceLogin` → `serviceLoginAuth2` (`sid=xiaomiio`, `md5(password)` uppercased) → STS redirect sets `serviceToken` / `ssecurity`.
2. Calls to `https://api.io.mi.com/app/<method>` with nonce/signed-nonce (`sha256(ssecurity + nonce)`), RC4-encrypted params + sha1 signature for `v2/*`, and hmac-sha256 signature for `miIO/raw_command`.

This is a **non-official protocol** (see [Xiaomi-cloud-tokens-extractor](https://github.com/PiotrMachowski/Xiaomi-cloud-tokens-extractor) / python-miio for the community-proven flow) and may change if Xiaomi updates the app. Accounts requiring captcha/2FA at login are reported with a clear error instead of an obscure failure.

## Development

```sh
pnpm install
pnpm typecheck && pnpm build && pnpm test   # signatures/crypto + demo-server e2e
```

Zero runtime dependencies on the host side: Node built-in `crypto`/`fetch` only.

## License

MIT
