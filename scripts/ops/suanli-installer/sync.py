#!/usr/bin/env python3
"""Keep the current 蒜狸小助手 installers on this host.

The release pipeline publishes to R2 and serves them through EdgeOne; this box keeps a local copy so a
domestic download can be served without paying for a cross-border origin pull every time.

Every run reads the published ``latest.json`` (it already carries ``size`` and ``sha256``) and compares
that against the copy recorded beside the file:

* same checksum  -> nothing happens, not even a request for the package;
* different      -> the package is fetched as byte ranges in parallel, assembled beside the old file,
                    verified as a whole, and only then swapped in — the directory never stops serving
                    a complete file, and a truncated download can never reach it;
* leftovers      -> packages the release no longer points at are removed after the swap.

One connection to the CDN is capped around 0.5–1.2 MB/s here while several run at ~8 MB/s together, so a
single package is split into ranges instead of being pulled on one connection. ``SUANLI_SYNC_ROOT``
overrides the destination, which is what makes a rehearsal safe on a production host.
"""

import fcntl
import hashlib
import json
import os
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

ROOT = os.environ.get("SUANLI_SYNC_ROOT", "/srv/downloads/suanli-assistant")
# 直接取 R2 的自定义域名，而不是走 CDN：同步是我们自己的后台流量，没必要绕一圈
# （走 CDN 时请求会先到本机源站、再触发回退到 R2，白白多一跳，还占用 CDN 额度）。
BASE = os.environ.get("SUANLI_SYNC_BASE", "https://aijisuan.kdns.fr/suanli-assistant")
TARGETS = ("win32-x64", "darwin-arm64")
STATE = os.path.join(ROOT, ".state.json")
LOCK = "/var/lock/suanli-installer-sync.lock"

# Ranges per package: enough to saturate the link, few enough that three packages never open a swarm.
SEGMENTS = 6
# Below this size splitting costs more than it saves.
SEGMENT_MIN_SIZE = 32 << 20


def run_curl(args, timeout):
    """Run curl with the flags every request here needs; return (ok, stdout)."""
    completed = subprocess.run(
        ["curl", "-fsS", "-L", "--retry", "3", "--retry-delay", "5",
         "--connect-timeout", "20", "--max-time", str(timeout)] + args,
        text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    return completed.returncode == 0, completed.stdout


def http_text(url):
    ok, body = run_curl([url], 60)
    return body if ok else None


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def range_count(size):
    if size < SEGMENT_MIN_SIZE:
        return 1
    return max(1, min(SEGMENTS, size // SEGMENT_MIN_SIZE))


def fetch_segment(url, start, end, destination, timeout=3600):
    """Fetch one inclusive byte range; the CDN answers ranges with 206."""
    ok, _ = run_curl(["-r", "%d-%d" % (start, end), "-o", destination, url], timeout)
    if not ok:
        return 0
    return os.path.getsize(destination)


def download(url, destination, size):
    """Assemble the object from parallel ranges; returns True when every byte arrived."""
    pieces = range_count(size)
    if pieces == 1:
        return fetch_segment(url, 0, size - 1, destination) == size

    bounds = []
    step = size // pieces
    for index in range(pieces):
        start = index * step
        end = size - 1 if index == pieces - 1 else start + step - 1
        bounds.append((start, end))

    parts = ["%s.part%d" % (destination, index) for index in range(pieces)]
    with ThreadPoolExecutor(max_workers=pieces) as pool:
        sizes = list(pool.map(
            lambda item: fetch_segment(url, item[1][0], item[1][1], parts[item[0]]),
            list(enumerate(bounds)),
        ))

    wanted = [end - start + 1 for start, end in bounds]
    if sizes != wanted:
        for part in parts:
            if os.path.exists(part):
                os.unlink(part)
        return False

    with open(destination, "wb") as assembled:
        for part in parts:
            with open(part, "rb") as piece:
                shutil.copyfileobj(piece, assembled, 1 << 20)
    for part in parts:
        os.unlink(part)
    return os.path.getsize(destination) == size


def load_state():
    try:
        with open(STATE) as handle:
            return json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_state(state):
    temporary = STATE + ".tmp"
    with open(temporary, "w") as handle:
        json.dump(state, handle, indent=2, sort_keys=True)
    os.replace(temporary, STATE)


def current_files():
    """Read every target index; return the packages the release currently points at.

    Each entry is keyed by the path it is served under, mirroring the bucket layout, because the CDN
    will ask this host for exactly the key it asked R2 for:

        <target>/versions/<version>/<artifact>   immutable, what the feed and latest.json link
        <target>/latest/<stable>                 the floating name a page can hard-code

    Both names are hard links to one downloaded copy, so mirroring costs one file per package.
    """
    wanted = {}
    for target in TARGETS:
        body = http_text("%s/%s/latest.json" % (BASE, target))
        if body is None:
            sys.stderr.write("no index for %s; keeping what is on disk\n" % target)
            continue
        try:
            index = json.loads(body)
        except json.JSONDecodeError:
            sys.stderr.write("unreadable index for %s; keeping what is on disk\n" % target)
            continue
        version = index.get("version")
        for entry in index.get("files") or []:
            url = entry.get("url")
            stable = entry.get("stableUrl")
            if not url or not stable:
                continue
            artifact = url.rsplit("/", 1)[-1]
            wanted["%s/versions/%s/%s" % (target, version, artifact)] = {
                "url": url,
                "size": entry.get("size"),
                "sha256": entry.get("sha256"),
                "version": version,
                "link": "%s/latest/%s" % (target, stable.rsplit("/", 1)[-1]),
            }
    return wanted


def sync(name, wanted, state):
    """Fetch one package when the published identity differs from the local copy."""
    path = os.path.join(ROOT, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    recorded = state.get(name) or {}

    # Without a state file (first run, or the last run was interrupted) the file on disk is adopted
    # only after hashing it: guessing "same" from size alone would keep serving a wrong package.
    if os.path.exists(path) and not recorded and os.path.getsize(path) == wanted["size"]:
        if sha256_of(path) == wanted["sha256"]:
            state[name] = dict(wanted)
            recorded = state[name]

    same = (
        os.path.exists(path)
        and recorded.get("sha256") == wanted["sha256"]
        and recorded.get("size") == wanted["size"]
        and os.path.getsize(path) == wanted["size"]
    )
    if same:
        print("up to date %s (%s)" % (name, wanted.get("version")), flush=True)
        return

    link = os.path.join(ROOT, wanted["link"])

    def give_up(reason):
        """Drop the stale floating name instead of leaving it pointing at the previous release."""
        if os.path.lexists(link):
            os.unlink(link)
            print("unlinked stale %s" % wanted["link"], flush=True)
        state.pop(name, None)
        sys.stderr.write("%s for %s\n" % (reason, name))

    print("fetching %s (%s, %d ranges)" % (name, wanted.get("version"), range_count(wanted["size"])), flush=True)
    partial = path + ".new"
    attempts = 3
    for attempt in range(1, attempts + 1):
        if download(wanted["url"], partial, wanted["size"]):
            actual = sha256_of(partial)
            if actual == wanted["sha256"]:
                break
            sys.stderr.write("checksum mismatch for %s (attempt %d): got %s\n" % (name, attempt, actual))
        else:
            sys.stderr.write("download failed for %s (attempt %d)\n" % (name, attempt))
        if os.path.exists(partial):
            os.unlink(partial)
        if attempt == attempts:
            give_up("giving up")
            return
        time.sleep(5)

    os.replace(partial, path)
    os.makedirs(os.path.dirname(link), exist_ok=True)
    if os.path.lexists(link):
        os.unlink(link)
    os.link(path, link)
    state[name] = {
        "sha256": wanted["sha256"],
        "size": wanted["size"],
        "version": wanted.get("version"),
        "url": wanted["url"],
    }
    print("synced %s (%s)" % (name, wanted.get("version")), flush=True)


def prune(wanted, state):
    """Drop packages and version directories the release no longer points at."""
    keep_links = {entry["link"] for entry in wanted.values()}
    for current, directories, files in list(os.walk(ROOT))[::-1]:
        for name in files:
            full = os.path.join(current, name)
            relative = os.path.relpath(full, ROOT)
            if relative.startswith(".") or ".part" in name or name.endswith(".new"):
                continue
            if relative in wanted or relative in keep_links:
                continue
            os.unlink(full)
            state.pop(relative, None)
            print("removed stale %s" % relative, flush=True)
        for name in directories:
            full = os.path.join(current, name)
            if name == "versions" or os.path.relpath(full, ROOT) in {w.split("/versions/")[0] for w in wanted}:
                continue
            if not os.listdir(full):
                os.rmdir(full)


def main():
    os.makedirs(ROOT, exist_ok=True)
    lock = open(LOCK, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("already running", flush=True)
        return

    for name in os.listdir(ROOT):
        if ".part" in name or name.endswith(".new"):
            os.unlink(os.path.join(ROOT, name))

    wanted = current_files()
    if not wanted:
        sys.stderr.write("no published index reachable; nothing to do\n")
        return

    state = load_state()
    # Packages go one at a time; each one is already parallel across ranges, so overlapping them too
    # would just open eighteen connections to the same edge node.
    for name, entry in sorted(wanted.items()):
        sync(name, entry, state)
    prune(wanted, state)
    save_state(state)


if __name__ == "__main__":
    main()
