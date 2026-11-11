# 蒜狸小助手 · 境内安装包源站

EdgeOne 的下载走 `download.ovaijisuan.com`，默认源站是 Cloudflare R2 的自定义域名。国内节点回源
必须跨境，一条连接只有 ~0.5 MB/s，319 MB 的安装包首拉要十分钟以上。这台机器在境内维护一份副本，
让国内回源变成内网级别的速度（实测 **5 MB/s**），并且不需要 EdgeOne 的任何付费能力（预热、源站防护、
源站故障转移在免费版都不可用）。

## 结构

```
用户 ──> EdgeOne 边缘 ──(缓存命中)──> 直接返回
                    └─(未命中)──> <origin-host>:80 (Caddy) ──> 127.0.0.1:8080 (serve.py)
                                                                   ├─ 本地有 → 直接吐
                                                                   └─ 本地没有 → 代理 aijisuan.kdns.fr
```

- `sync.py`：每 15 分钟读一次发布的 `latest.json`（带 `size`/`sha256`），一致就不下载；不一致才按
  6 个 HTTP Range 并发拉取，校验通过后原子替换，并把 `<target>/latest/<stable>` 硬链到版本目录文件
  （一份字节、两个名字，磁盘只占 1 GB）。
- `serve.py`：只监听回环，GET/HEAD + Range，`/versions/` 发 1 年 immutable、`/latest/` 发 5 分钟，
  要求 `X-Origin-Token`；本地缺文件时反向代理 R2，所以「刚发版、还没同步完」的窗口期不会 404，
  只会慢一次。
- 发布流水线在 `publish` 之后 POST `https://<origin-host>/suanli-assistant/__sync`，通过
  `suanli-installer-sync.path` 立刻拉起同步，把窗口从 15 分钟压到「同步本身所需时间」。

## 部署

```bash
# 1) 文件
install -m 755 sync.py /usr/local/sbin/suanli-installer-sync
install -m 755 serve.py /usr/local/sbin/suanli-files-server
install -d -m 755 /srv/downloads /etc/suanli

# 2) 回源 token（只存在机器上，不进仓库）
printf 'SUANLI_FILES_TOKEN=%s\n' "$(openssl rand -base64 24 | tr -d '\n')" > /etc/suanli/files.env
chmod 600 /etc/suanli/files.env

# 3) 专用低权用户
useradd --system --no-create-home --shell /usr/sbin/nologin suanli-files

# 4) systemd
install -m 644 suanli-files.service suanli-installer-sync.{service,timer,path} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now suanli-files suanli-installer-sync.timer suanli-installer-sync.path
systemctl start suanli-installer-sync        # 首次灌数据，约 5 分钟

# 5) Caddy 片段（见 Caddyfile.example）
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
```

## EdgeOne 规则（只覆盖安装包，不动指针和境外流量）

规则引擎里给 `download.ovaijisuan.com` 的规则加一个子规则：

- 条件：`${http.request.file_extension} in ['exe', 'dmg', 'zip', 'blockmap']`
- 动作（按顺序）：
  1. `ModifyOrigin` → `IPDomain` / `<origin-host>` / `http` / 80
  2. `HostHeader` → `custom` / `<origin-host>`
  3. `ModifyRequestHeader` → `set` / `X-Origin-Token` / `<origin-token>`

父规则原有的强制 HTTPS、遵循源站缓存、分片回源**保持不变**；`nightly.yml` 与 `latest.json` 不匹配
扩展名条件，继续走 R2——那两张指针文件在本机是 15 分钟级的旧数据，不能用来判断版本。

> 免费版不可用的两个能力，这里都用别的办法绕过了：**预热**额度为 0 → 用本机副本代替；
> **源站故障转移**仅白名单 → 由 `serve.py` 自己回退 R2。

## 验收

```bash
# 本地：无 token 403，有 token 200/206
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/suanli-assistant/<path>.exe
curl -sS -o /dev/null -H "X-Origin-Token: $TOKEN" -r 0-1023 \
  http://127.0.0.1:8080/suanli-assistant/<path>.exe -w '%{http_code}\n'

# 国内冷拉（应到几 MB/s）
curl -sS -o /dev/null -r 0-8388607 -w '%{speed_download}\n' \
  "https://download.ovaijisuan.com/suanli-assistant/win32-x64/versions/<version>/<artifact>.exe"

# 同步是否跟上发布
journalctl -u suanli-installer-sync -n 20
python3 -c "import json;d=json.load(open('/srv/downloads/suanli-assistant/.state.json'));print({k.split('/')[0] for k in d}, {v['version'] for v in d.values()})"
```

## 已知坑

1. **Caddy 的自动 80→443 跳转优先级高于自定义 `:80` 站点**，会把 EO 回源打成 308；必须
   `auto_https disable_redirects`，再在 `:80` 里显式 `redir`。
2. **同步失败时不能让 `<target>/latest/` 继续指向旧字节**：`sync.py` 在放弃时会先 `unlink` 那个
   浮动链接，让请求落到 R2 回退，否则用户会下到上一个版本。
3. 同步自己**直连 R2**（`SUANLI_SYNC_BASE`），不要走 CDN——否则会变成
   「本机 → 边缘 → 本机 → 回退 R2」的多余往返。
