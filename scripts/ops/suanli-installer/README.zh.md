# 算力助手安装包国内源站

[English](README.md) | 中文

<a id="summary"></a>

## 摘要

使用国内安装包源站降低冷下载延迟，同时继续由 Cloudflare R2 提供版本入口和缺失安装包的回退。EdgeOne 通过 `download.ovaijisuan.com` 提供下载。这套部署无需付费的 EdgeOne 预热、源站保护或源站容灾功能。

<a id="table-of-contents"></a>

## 目录

- [布局](#layout)
- [部署](#deployment)
- [EdgeOne 规则](#edgeone-rules)
- [验收](#acceptance)
- [已知问题](#known-issues)
- [开发备注](#dev-note)

<a id="layout"></a>

## 布局

```
User --> EdgeOne edge --(hit)--> cached response
                   \--(miss)--> <origin-host>:80 (Caddy) --> 127.0.0.1:8080 (serve.py)
                                                              |-- local file: serve
                                                              \-- missing: proxy aijisuan.kdns.fr
```

- `sync.py`：每十五分钟读取已发布的 `latest.json`，包括 `size` 和 `sha256`。未变更的文件不下载；变更文件使用六路并发 HTTP Range 下载，校验后原子替换，再从 `<target>/latest/<stable>` 硬链接到版本文件：两个名称共用一份内容。
- `serve.py`：只监听回环地址，支持 GET/HEAD 和 Range。`/versions/` 缓存一年且不可变，`/latest/` 缓存五分钟。请求必须携带 `X-Origin-Token`。缺失文件代理到 R2，因此发布与同步间隔内只会慢一次，不会返回 404。
- `publish` 之后，发布工作流向 `https://<origin-host>/suanli-assistant/__sync` 发起 POST。`suanli-installer-sync.path` 立即启动同步，无需等待十五分钟定时器。

<a id="deployment"></a>

## 部署

```bash
# 1) Files
install -m 755 sync.py /usr/local/sbin/suanli-installer-sync
install -m 755 serve.py /usr/local/sbin/suanli-files-server
install -d -m 755 /srv/downloads /etc/suanli

# 2) Origin token: keep it on the machine, never in the repository
printf 'SUANLI_FILES_TOKEN=%s\n' "$(openssl rand -base64 24 | tr -d '\n')" > /etc/suanli/files.env
chmod 600 /etc/suanli/files.env

# 3) Dedicated unprivileged user
useradd --system --no-create-home --shell /usr/sbin/nologin suanli-files

# 4) systemd
install -m 644 suanli-files.service suanli-installer-sync.{service,timer,path} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now suanli-files suanli-installer-sync.timer suanli-installer-sync.path
systemctl start suanli-installer-sync        # initial synchronization, about five minutes

# 5) Caddy snippet: see Caddyfile.example
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
```

<a id="edgeone-rules"></a>

## EdgeOne 规则

只对安装包文件覆盖源站，版本入口与非国内流量保持原样。在 `download.ovaijisuan.com` 规则下添加子规则：

- 条件：`${http.request.file_extension} in ['exe', 'dmg', 'zip', 'blockmap']`
- 按以下顺序执行动作：
  1. `ModifyOrigin` → `IPDomain` / `<origin-host>` / `http` / 80
  2. `HostHeader` → `custom` / `<origin-host>`
  3. `ModifyRequestHeader` → `set` / `X-Origin-Token` / `<origin-token>`

保留父规则的 HTTPS 强制跳转、源站缓存策略和分片回源。`nightly.yml` 和 `latest.json` 不匹配扩展名条件，继续使用 R2。本地副本最多可能延迟十五分钟，不能用它决定当前版本。

本地副本替代免费套餐不可用的预热功能；源站容灾不可用时，由 `serve.py` 实现向 R2 回退。

<a id="acceptance"></a>

## 验收

```bash
# Local: 403 without a token; 200/206 with a token
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/suanli-assistant/<path>.exe
curl -sS -o /dev/null -H "X-Origin-Token: $TOKEN" -r 0-1023 \
  http://127.0.0.1:8080/suanli-assistant/<path>.exe -w '%{http_code}\n'

# Domestic cold download: expect several MB/s
curl -sS -o /dev/null -r 0-8388607 -w '%{speed_download}\n' \
  "https://download.ovaijisuan.com/suanli-assistant/win32-x64/versions/<version>/<artifact>.exe"

# Confirm synchronization caught up with publication
journalctl -u suanli-installer-sync -n 20
python3 -c "import json;d=json.load(open('/srv/downloads/suanli-assistant/.state.json'));print({k.split('/')[0] for k in d}, {v['version'] for v in d.values()})"
```

<a id="known-issues"></a>

## 已知问题

1. Caddy 的自动 80→443 跳转优先于自定义 `:80` 站点，可能把 EdgeOne 回源变成 308 响应。设置 `auto_https disable_redirects`，再在 `:80` 中明确声明 `redir`。
2. 同步失败时不能让 `<target>/latest/` 指向旧内容。`sync.py` 会在放弃前删除该浮动链接，使请求回退到 R2，避免继续提供旧版本。
3. 同步通过 `SUANLI_SYNC_BASE` 直接连接 R2。经过 CDN 会形成从本机到边缘节点、再回到本机、最后到回退 R2 的环路。

<a id="dev-note"></a>

## 开发备注

无。
