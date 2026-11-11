#!/usr/bin/env python3
"""Serve the synced 蒜狸小助手 installers to EdgeOne.

Only the pieces a CDN origin needs: GET/HEAD, one HTTP range per request, and the same cache headers
the release pipeline writes into R2 — ``/versions/`` is immutable for a year, ``/latest/`` floats on
five minutes. Everything else is refused, so this port can be opened to the edge nodes without also
exposing a directory listing or a shell.

The free EdgeOne plan does not expose an origin-IP allowlist (its documented IP feed is retired and the
"源站防护" feature is paid-only), so reachability alone is not proof that a request is the CDN. The
server therefore requires a shared secret header that only the CDN's origin requests carry: without it
every path answers 403, so a port scanner learns nothing and downloads nothing.
"""

import http.client
import os
import re
import ssl
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = "/srv/downloads"
BIND = os.environ.get("SUANLI_FILES_BIND", "0.0.0.0")
PORT = int(os.environ.get("SUANLI_FILES_PORT", "8080"))
# 本地还没有这个文件时（刚发版、同步还没跑完），由本服务自己去 R2 取，而不是回 404。
# 这样「同步空窗期」也永远能下到正确的包，只是那一次走得慢一点。
UPSTREAM = os.environ.get("SUANLI_FILES_UPSTREAM", "aijisuan.kdns.fr").strip()

TOKEN = os.environ.get("SUANLI_FILES_TOKEN", "").strip()
TOKEN_HEADER = "X-Origin-Token"

# 发布流水线在 publish 之后调这个路径，让本机立刻去同步新版本，而不是等 15 分钟的定时器。
SYNC_PATH = "/suanli-assistant/__sync"
# 触发方式写一个标记文件，由 systemd 的 path 单元去起同步任务：服务本身保持 NoNewPrivileges
# 和只读沙箱，不需要 sudo，也不需要能调 systemctl。
SYNC_FLAG = os.environ.get("SUANLI_SYNC_FLAG", "/run/suanli/sync.request")
SYNC_MIN_INTERVAL = 120
_last_sync = 0.0
CHUNK = 1 << 20

RANGE = re.compile(r"^bytes=(\d*)-(\d*)$")


def cache_control(relative):
    """Match what the publisher sets on the object in R2, so the CDN keeps behaving the same."""
    if "/versions/" in relative:
        return "public, max-age=31536000, immutable"
    if "/latest/" in relative:
        return "public, max-age=300"
    return "no-store"


class Handler(BaseHTTPRequestHandler):
    server_version = "suanli-files"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def resolve(self):
        """Map the request path onto ROOT, refusing anything that escapes it or is not a file."""
        path = self.path.split("?", 1)[0]
        if not path.startswith("/"):
            return None
        relative = os.path.normpath(path.lstrip("/"))
        if relative.startswith("..") or os.path.isabs(relative) or relative.startswith("."):
            return None
        full = os.path.join(ROOT, relative)
        if not os.path.isfile(full):
            return None
        return relative, full

    def authorized(self):
        """A request without the shared secret never reaches the filesystem."""
        if not TOKEN:
            return True
        return self.headers.get(TOKEN_HEADER, "") == TOKEN

    def proxy(self, relative, with_body):
        """Fetch the object from the R2 custom domain when the local copy is not there yet."""
        if not UPSTREAM:
            self.send_error(404)
            return
        headers = {"Host": UPSTREAM, "Accept-Encoding": "identity"}
        for name in ("Range", "If-Range"):
            if self.headers.get(name):
                headers[name] = self.headers.get(name)
        context = ssl.create_default_context()
        connection = http.client.HTTPSConnection(UPSTREAM, 443, timeout=60, context=context)
        try:
            connection.request("GET", "/" + relative, headers=headers)
            response = connection.getresponse()
        except (OSError, http.client.HTTPException) as error:
            sys.stderr.write("upstream fetch failed: %s\n" % error)
            self.send_error(502)
            connection.close()
            return
        try:
            self.send_response(response.status)
            for name in ("Content-Type", "Content-Range", "Content-Length", "Accept-Ranges",
                         "Cache-Control", "ETag", "Last-Modified"):
                value = response.getheader(name)
                if value:
                    self.send_header(name, value)
            self.end_headers()
            # 流式转发：一个 319MB 的包不能整个读进内存（服务有 MemoryMax 限制）
            if with_body:
                while True:
                    chunk = response.read(CHUNK)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        finally:
            connection.close()
        sys.stderr.write("upstream %s for /%s\n" % (response.status, relative))

    def respond(self, with_body):
        if not self.authorized():
            self.send_error(403)
            return
        resolved = self.resolve()
        if resolved is None:
            path = self.path.split("?", 1)[0].lstrip("/")
            if path.startswith("suanli-assistant/"):
                self.proxy(path, with_body)
                return
            self.send_error(404)
            return
        relative, full = resolved
        size = os.path.getsize(full)
        start, end = 0, size - 1
        status = 200

        header = self.headers.get("Range")
        if header:
            match = RANGE.match(header.strip())
            if not match:
                self.send_error(400)
                return
            first, last = match.group(1), match.group(2)
            if first == "" and last == "":
                self.send_error(400)
                return
            if first == "":
                start = max(0, size - int(last))
            else:
                start = int(first)
            if last != "" and first != "":
                end = min(size - 1, int(last))
            if start >= size or start > end:
                self.send_response(416)
                self.send_header("Content-Range", "bytes */%d" % size)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            status = 206

        self.send_response(status)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", cache_control(relative))
        self.send_header("ETag", '"%d-%d"' % (size, int(os.path.getmtime(full))))
        if status == 206:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.end_headers()

        if not with_body:
            return
        with open(full, "rb") as source:
            source.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = source.read(min(CHUNK, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def do_POST(self):
        """Publish hook: kick a sync so a brand-new version lands before users ask for it."""
        global _last_sync
        if self.path.split("?", 1)[0] != SYNC_PATH:
            self.send_error(404)
            return
        if not self.authorized():
            self.send_error(403)
            return
        now = time.time()
        if now - _last_sync < SYNC_MIN_INTERVAL:
            self.send_response(429)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        _last_sync = now
        try:
            with open(SYNC_FLAG, "w") as flag:
                flag.write("%d\n" % int(now))
        except OSError as error:
            sys.stderr.write("sync trigger failed: %s\n" % error)
            self.send_error(500)
            return
        self.send_response(202)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        self.respond(True)

    def do_HEAD(self):
        self.respond(False)


def main():
    if not os.path.isdir(ROOT):
        sys.stderr.write("%s does not exist yet\n" % ROOT)
    server = ThreadingHTTPServer((BIND, PORT), Handler)
    server.daemon_threads = True
    print("serving %s on %s:%d" % (ROOT, BIND, PORT), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
