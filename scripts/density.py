#!/usr/bin/env python3
"""Density probe for the computer-host control API.

Starts N instances with PUT /v1/instances/{key} desired=running, prints one
JSON object per line, then stops and deletes only keys under the given prefix.

Token is read from COMPUTER_CONTROL_TOKEN or --token-file. It is never printed.

    COMPUTER_CONTROL_TOKEN=dev-token python3 scripts/density.py \\
      --url http://127.0.0.1:9090 --count 20 --batch 10

Ctrl-C without --keep still cleans up keys this run created. --cleanup-only
deletes leftover prefix keys from a previous interrupted run.

Only prefixes that start with "density" are accepted, so this will not touch
ApeMind instance keys (ci*). Do not point --url at production.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import statistics
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, NamedTuple

USER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
PREFIX_RE = re.compile(r"^density[A-Za-z0-9_-]{0,24}$")


class BatchResult(NamedTuple):
    ok: int
    fail: int
    lat_s: dict[str, float | None]
    fail_codes: dict[str, int]


def assert_safe_prefix(prefix: str) -> str:
    if not PREFIX_RE.fullmatch(prefix):
        raise ValueError(
            'prefix must match ^density[A-Za-z0-9_-]{0,24}$ so the probe cannot touch ci* homes'
        )
    return prefix


def instance_keys(prefix: str, start: int, count: int) -> list[str]:
    assert_safe_prefix(prefix)
    if start < 1 or count < 1:
        raise ValueError("start and count must be >= 1")
    keys: list[str] = []
    width = max(4, len(str(start + count - 1)))
    for index in range(start, start + count):
        key = f"{prefix}{index:0{width}d}"
        if not USER_ID_RE.fullmatch(key):
            raise ValueError(f"generated key is not a valid instance id: {key}")
        keys.append(key)
    return keys


def owns_key(prefix: str, key: str) -> bool:
    return USER_ID_RE.fullmatch(key) is not None and key.startswith(prefix)


def latency_stats(samples: list[float]) -> dict[str, float | None]:
    if not samples:
        return {"min": None, "p50": None, "p95": None, "max": None}
    ordered = sorted(samples)
    p95 = ordered[max(0, int(len(ordered) * 0.95) - 1)]
    return {
        "min": round(min(samples), 3),
        "p50": round(statistics.median(samples), 3),
        "p95": round(p95, 3),
        "max": round(max(samples), 3),
    }


def rss_summary(instances: list[dict[str, Any]], prefix: str) -> dict[str, Any]:
    running = [
        inst
        for inst in instances
        if inst.get("status") == "running" and owns_key(prefix, str(inst.get("user_id") or ""))
    ]
    rss = [int(inst.get("rss_bytes") or 0) for inst in running]
    rss = [n for n in rss if n > 0]
    return {
        "density_running": len(running),
        "rss_mib_min": round(min(rss) / 1048576, 1) if rss else None,
        "rss_mib_p50": round(statistics.median(rss) / 1048576, 1) if rss else None,
        "rss_mib_max": round(max(rss) / 1048576, 1) if rss else None,
        "rss_mib_sum": round(sum(rss) / 1048576, 1) if rss else 0,
    }


def should_stop(batch: BatchResult, health: dict[str, Any], batch_size: int) -> str | None:
    if batch.fail >= max(3, batch_size // 2):
        return "too many failures in this batch"
    instances = health.get("instances") if isinstance(health.get("instances"), dict) else {}
    running = int(instances.get("running") or 0)
    maximum = int(instances.get("max") or 0)
    if maximum and running >= maximum:
        return "at max_instances"
    if "507:" in "".join(batch.fail_codes):
        return "host returned 507 capacity"
    return None


def summarize_rows(rows: list[tuple[str, int, float, dict[str, Any], str]]) -> BatchResult:
    ok_rows = [row for row in rows if row[1] == 200 and row[3].get("status") == "running"]
    fail_rows = [row for row in rows if row not in ok_rows]
    fail_codes: dict[str, int] = {}
    for _key, status, _elapsed, body, err in fail_rows:
        reason = f"{status}:{(body.get('error') or err or body.get('status') or 'unknown')}"
        fail_codes[reason] = fail_codes.get(reason, 0) + 1
    return BatchResult(
        ok=len(ok_rows),
        fail=len(fail_rows),
        lat_s=latency_stats([row[2] for row in ok_rows]),
        fail_codes=fail_codes,
    )


def emit(event: str, **payload: Any) -> None:
    print(json.dumps({"event": event, **payload}, ensure_ascii=False), flush=True)


def load_token(token_file: str | None) -> str:
    if token_file:
        token = open(token_file, encoding="utf-8").read().strip()
    else:
        token = (os.environ.get("COMPUTER_CONTROL_TOKEN") or "").strip()
    if not token:
        raise SystemExit("set COMPUTER_CONTROL_TOKEN or pass --token-file")
    return token


class ControlClient:
    def __init__(self, url: str, token: str, timeout: float) -> None:
        self.url = url.rstrip("/")
        self.token = token
        self.timeout = timeout

    def request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        timeout: float | None = None,
    ) -> tuple[int, dict[str, Any], str]:
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(
            f"{self.url}{path}",
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout or self.timeout) as resp:
                raw = resp.read()
                payload = json.loads(raw) if raw else {}
                return resp.status, payload if isinstance(payload, dict) else {}, ""
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            try:
                payload = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                payload = {}
            text = raw.decode("utf-8", "replace")[:200]
            return exc.code, payload if isinstance(payload, dict) else {}, text

    def healthz(self) -> dict[str, Any]:
        status, body, err = self.request("GET", "/healthz", timeout=20)
        if status != 200:
            raise SystemExit(f"healthz {status} {err or body}")
        return body

    def list_instances(self) -> list[dict[str, Any]]:
        status, body, err = self.request("GET", "/v1/instances", timeout=20)
        if status != 200:
            raise SystemExit(f"list instances {status} {err or body}")
        items = body.get("instances")
        return items if isinstance(items, list) else []

    def ensure(self, key: str, desired: str) -> tuple[str, int, float, dict[str, Any], str]:
        started = time.monotonic()
        status, body, err = self.request(
            "PUT",
            f"/v1/instances/{key}",
            {"desired": desired},
        )
        return key, status, time.monotonic() - started, body, err

    def delete(self, key: str) -> tuple[str, int]:
        status, _body, _err = self.request("DELETE", f"/v1/instances/{key}", timeout=30)
        return key, status


def run_pool(fn, items: list[str], concurrency: int):
    rows = []
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futs = {pool.submit(fn, item): item for item in items}
        for fut in as_completed(futs):
            rows.append(fut.result())
    return rows


def cleanup(client: ControlClient, keys: list[str], prefix: str, concurrency: int) -> None:
    owned = [key for key in keys if owns_key(prefix, key)]
    if not owned:
        return
    emit("cleanup", phase="stop", count=len(owned))
    run_pool(lambda key: client.ensure(key, "stopped"), owned, concurrency)
    emit("cleanup", phase="delete", count=len(owned))
    run_pool(client.delete, owned, concurrency)
    emit("cleanup", phase="done", healthz=client.healthz())


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default=os.environ.get("COMPUTER_CONTROL_URL", "http://127.0.0.1:9090"))
    parser.add_argument("--token-file", help="file containing the control token; otherwise COMPUTER_CONTROL_TOKEN")
    parser.add_argument("--prefix", default="density", help="instance key prefix; must start with density")
    parser.add_argument("--count", type=int, default=20, help="how many instances to start")
    parser.add_argument("--start", type=int, default=1, help="first numeric suffix")
    parser.add_argument("--batch", type=int, default=10, help="keys started per wave")
    parser.add_argument("--concurrency", type=int, default=5, help="in-flight ensure calls")
    parser.add_argument("--timeout", type=float, default=120, help="per-ensure timeout seconds")
    parser.add_argument("--keep", action="store_true", help="leave started instances running")
    parser.add_argument(
        "--cleanup-only",
        action="store_true",
        help="stop and delete existing prefix keys, then exit",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        prefix = assert_safe_prefix(args.prefix)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc
    if args.batch < 1 or args.concurrency < 1:
        raise SystemExit("--batch and --concurrency must be >= 1")

    client = ControlClient(args.url, load_token(args.token_file), args.timeout)
    created: list[str] = []
    keep = args.keep

    def handle_stop(_signum: int, _frame: Any) -> None:
        emit("interrupt", keep=keep)
        if not keep:
            cleanup(client, created, prefix, args.concurrency)
        raise SystemExit(130)

    signal.signal(signal.SIGINT, handle_stop)
    signal.signal(signal.SIGTERM, handle_stop)

    if args.cleanup_only:
        leftovers = [str(inst.get("user_id") or "") for inst in client.list_instances()]
        leftovers = [key for key in leftovers if owns_key(prefix, key)]
        cleanup(client, leftovers, prefix, args.concurrency)
        return 0

    emit("baseline", **client.healthz(), url=args.url, prefix=prefix, count=args.count)
    try:
        remaining = args.count
        cursor = args.start
        while remaining > 0:
            size = min(args.batch, remaining)
            keys = instance_keys(prefix, cursor, size)
            wall = time.monotonic()
            rows = run_pool(lambda key: client.ensure(key, "running"), keys, args.concurrency)
            created.extend(keys)
            batch = summarize_rows(rows)
            health = client.healthz()
            emit(
                "batch",
                first=keys[0],
                last=keys[-1],
                ok=batch.ok,
                fail=batch.fail,
                lat_s=batch.lat_s,
                fail_codes=batch.fail_codes,
                batch_wall_s=round(time.monotonic() - wall, 3),
                instances=health.get("instances"),
                load1=health.get("load1"),
                rss=rss_summary(client.list_instances(), prefix),
            )
            reason = should_stop(batch, health, size)
            if reason:
                emit("stop", reason=reason)
                break
            remaining -= size
            cursor += size
    finally:
        if created and not keep:
            cleanup(client, created, prefix, args.concurrency)
        elif created and keep:
            emit("kept", count=len(created), prefix=prefix)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
