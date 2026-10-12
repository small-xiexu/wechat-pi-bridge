# systemd units - templates, NOT installed

These four units are templates. Installing and enabling them is a deploy-time
step owned by the main agent + user (requires QR scan first).

| unit | what | needs |
|---|---|---|
| `wechat-bridge.service` | Node webhook server (pi binding) + dispatcher | `config/bindings.json` (600), QR-scanned wx-bot-pi state |
| `telegram-bridge.service` | Telegram channel supervisor + Pi dispatch | Telegram config/tokens and bridge state |
| `wx-bot-muse.service` | wx-bot process, binding `muse` (pull) | `config/wx-bot-muse.json` (600), QR scan with 小号A |
| `wx-bot-pi.service` | wx-bot process, binding `pi` (webhook) | `config/wx-bot-pi.json` (600), QR scan with 小号B, webhook key env |

## Webhook key: three places, one value (read this before deploying)

The pi binding's webhook is authenticated with a shared key. The SAME value
must appear in all three places:

1. `config/bindings.json` → `bindings.pi.webhook_token`
2. `wx-bot-pi.service` → `Environment=WXBOT_PI_WEBHOOK_KEY=...`
   (wx-bot reads it because `config/wx-bot-pi.json` declares
   `"key": "env:WXBOT_PI_WEBHOOK_KEY"`)
3. `wechat-bridge.service` → `Environment=WXBOT_PI_WEBHOOK_KEY=...`

Generate the value once (`openssl rand -hex 32`) and paste it into all three.
The templates ship with the placeholder `__REPLACE_WITH_RANDOM_32B_HEX__` -
never commit a real key. If any one of the three differs, wx-bot's webhook
deliveries are rejected with HTTP 401 and WeChat messages silently pile up
in wx-bot's retry queue. This applies on first deploy AND on every restore
(e.g. when the watchdog reinstalls units after a platform reset): always
inject the real key into the restored units before starting them.

## Run user: root in production (platform compromise)

In production all units run as `User=root`. A dedicated low-privilege
`wechat-bridge` user was the original design, but the deployment platform
mounts the home directory as a restricted overlay:

- `chown` under the home tree is rejected (Operation not permitted), even
  for root;
- a non-root user cannot traverse the home directory at all, even when
  POSIX permission bits suggest it should be able to;
- only the home tree survives platform resets, so the runtime cannot simply
  be relocated outside it.

A non-root service user therefore cannot run this stack on that platform.
The rest of the hardening stays in place (`NoNewPrivileges`, `PrivateTmp`,
`ProtectSystem=strict`, `ProtectHome=read-only`, `PrivateDevices`, explicit
`ReadWritePaths` allowlists) and the units do not widen beyond it.

If your platform lets a dedicated user traverse and own the runtime state,
switching `User=`/`Group=` back to that user is recommended. The setup for
that variant is:

```sh
WB_HOME=/home/hatch/workspace/wechat-pi-bridge
sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin wechat-bridge
sudo install -d -m 0750 -o wechat-bridge -g wechat-bridge \
  "$WB_HOME/state" "$WB_HOME/logs" "$WB_HOME/sandbox" \
  /var/lib/wechat-pi-bridge/pi-home/sessions
sudo chown -R wechat-bridge:wechat-bridge \
  "$WB_HOME/state" "$WB_HOME/logs" "$WB_HOME/sandbox" \
  /var/lib/wechat-pi-bridge/pi-home
```

Keep the repository code and configuration read-only to that account either
way.

Install sketch (deploy time, main agent):
```
sudo cp systemd/*.service /etc/systemd/system/
# inject the real webhook key + proxy credentials into the installed copies
sudo systemctl daemon-reload
sudo systemctl enable --now telegram-bridge.service wechat-bridge.service wx-bot-pi.service
```
