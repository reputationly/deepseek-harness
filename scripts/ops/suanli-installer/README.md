# Suanli Assistant domestic installer origin

English | [中文](README.zh.md)

<a id="summary"></a>

## Summary

Use a domestic installer origin to reduce cold-download latency while Cloudflare R2 remains the source of release pointers and the fallback for missing packages. EdgeOne serves downloads at `download.ovaijisuan.com`. This setup works without paid EdgeOne prefetch, origin protection or origin failover.

<a id="table-of-contents"></a>

## Table of Contents

- [Layout](#layout)
- [Deployment](#deployment)
- [EdgeOne rules](#edgeone-rules)
- [Acceptance](#acceptance)
- [Known issues](#known-issues)
- [Dev Note](#dev-note)

<a id="layout"></a>

## Layout

```
User --> EdgeOne edge --(hit)--> cached response
                   \--(miss)--> <origin-host>:80 (Caddy) --> 127.0.0.1:8080 (serve.py)
                                                              |-- local file: serve
                                                              \-- missing: proxy aijisuan.kdns.fr
```

- `sync.py`: reads published `latest.json`, including `size` and `sha256`, every fifteen minutes. Unchanged files are not downloaded. Changed files use six concurrent HTTP Range requests, are verified and atomically replaced, then hard-linked from `<target>/latest/<stable>` to the versioned file: two names share one set of bytes.
- `serve.py`: listens only on loopback and supports GET/HEAD and Range. `/versions/` receives one-year immutable caching; `/latest/` receives five minutes. Requests require `X-Origin-Token`. Missing files proxy to R2, so the interval between publication and synchronization is slow once rather than returning 404.
- After `publish`, the release workflow POSTs to `https://<origin-host>/suanli-assistant/__sync`. `suanli-installer-sync.path` starts synchronization immediately instead of waiting for the fifteen-minute timer.

<a id="deployment"></a>

## Deployment

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

## EdgeOne rules

Apply the origin override only to installer files, leaving pointers and non-domestic traffic unchanged. Add a child rule under the `download.ovaijisuan.com` rule:

- Condition: `${http.request.file_extension} in ['exe', 'dmg', 'zip', 'blockmap']`
- Actions, in order:
  1. `ModifyOrigin` → `IPDomain` / `<origin-host>` / `http` / 80
  2. `HostHeader` → `custom` / `<origin-host>`
  3. `ModifyRequestHeader` → `set` / `X-Origin-Token` / `<origin-token>`

Keep the parent rule's HTTPS enforcement, origin cache policy and range fetching. `nightly.yml` and `latest.json` do not match the extension condition and continue using R2. Local copies can lag by fifteen minutes and must not determine the current version.

The local replica replaces unavailable free-plan prefetch; `serve.py` implements fallback to R2 when origin failover is unavailable.

<a id="acceptance"></a>

## Acceptance

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

## Known issues

1. Caddy's automatic 80→443 redirect takes precedence over a custom `:80` site and can turn EdgeOne origin fetches into 308 responses. Set `auto_https disable_redirects`, then declare `redir` explicitly in `:80`.
2. Failed synchronization must not leave `<target>/latest/` pointing at old bytes. Before giving up, `sync.py` unlinks that floating link so requests fall back to R2 rather than serve the previous version.
3. Synchronization connects directly to R2 through `SUANLI_SYNC_BASE`. Going through the CDN adds a loop from this machine to the edge, back to this machine, then to fallback R2.

<a id="dev-note"></a>

## Dev Note

None.
