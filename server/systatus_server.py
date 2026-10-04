#!/usr/bin/env python3
"""systatus 采集服务：把 Ubuntu 主机的 CPU/RAM/VRAM/GPU/POWER 指标以 JSON 暴露到局域网。

数据源与 GNOME 扩展一致：
  CPU     /proc/stat                     两次采样差值
  RAM     /proc/meminfo                  MemTotal - MemAvailable
  GPU     nvidia-smi                     利用率/显存/功耗/型号
  POWER   RAPL + nvidia-smi              CPU 封装功耗 + GPU 功耗

零第三方依赖，仅用标准库。默认监听 0.0.0.0:8766，GET /metrics 返回快照。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

NVIDIA_SMI = "/usr/bin/nvidia-smi"
RAPL_PKG = "/sys/class/powercap/intel-rapl:0/energy_uj"
RAPL_MAX = "/sys/class/powercap/intel-rapl:0/max_energy_range_uj"

_snapshot: dict = {"ok": False}
_lock = threading.Lock()


def _read_text(path: str):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except (FileNotFoundError, PermissionError, OSError):
        return None


def _monotonic_us() -> int:
    return int(time.monotonic() * 1_000_000)


class Sampler:
    def __init__(self) -> None:
        self.prev_cpu = None          # (total, idle)
        self.prev_energy = None       # (energy_uj, stamp_us)
        self.max_energy = None
        self.rapl_denied = False
        self.has_smi = False
        self.gpu_name = None
        self.cpu_pct = None
        self.cpu_power_w = None

    def read_cpu_pct(self):
        txt = _read_text("/proc/stat")
        if not txt:
            return None
        first = txt.splitlines()[0]
        nums = [int(x) for x in first.split()[1:]]
        if len(nums) < 4:
            return None
        idle = nums[3] + (nums[4] if len(nums) > 4 else 0)
        total = sum(nums)
        pct = None
        if self.prev_cpu:
            dt = total - self.prev_cpu[0]
            di = idle - self.prev_cpu[1]
            if dt > 0:
                pct = (1 - di / dt) * 100.0
        self.prev_cpu = (total, idle)
        return pct

    def read_mem(self):
        txt = _read_text("/proc/meminfo")
        if not txt:
            return None
        total = re.search(r"MemTotal:\s+(\d+)", txt)
        avail = re.search(r"MemAvailable:\s+(\d+)", txt)
        if not total or not avail:
            return None
        total_kb = int(total.group(1))
        used_kb = total_kb - int(avail.group(1))
        return {"usedKb": used_kb, "totalKb": total_kb, "pct": used_kb / total_kb * 100.0}

    def read_cpu_power_w(self):
        raw = _read_text(RAPL_PKG)
        if raw is None:
            self.rapl_denied = True
            return None
        self.rapl_denied = False
        energy = float(raw.strip())
        if self.max_energy is None:
            mx = _read_text(RAPL_MAX)
            self.max_energy = float(mx) if mx and float(mx) > 0 else float("inf")
        now = _monotonic_us()
        watts = None
        if self.prev_energy is not None:
            prev_e, prev_t = self.prev_energy
            d = energy - prev_e
            if d < 0:
                d += self.max_energy
            dt = (now - prev_t) / 1_000_000
            if dt > 0:
                watts = d / 1_000_000 / dt
        self.prev_energy = (energy, now)
        return watts

    def query_gpu(self):
        try:
            out = subprocess.run(
                [NVIDIA_SMI, "--query-gpu=utilization.gpu,memory.used,memory.total,power.draw",
                 "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=3,
            ).stdout.strip()
        except (subprocess.SubprocessError, FileNotFoundError, OSError):
            return None
        if not out:
            return None
        p = [s.strip() for s in out.splitlines()[0].split(",")]

        def num(s):
            try:
                return float(s)
            except ValueError:
                return None

        return {"util": num(p[0]), "memUsed": num(p[1]), "memTotal": num(p[2]), "powerW": num(p[3]) if len(p) > 3 else None}

    def refresh(self):
        self.has_smi = os.path.exists(NVIDIA_SMI)
        self.cpu_pct = self.read_cpu_pct()
        mem = self.read_mem()
        self.cpu_power_w = self.read_cpu_power_w()
        gpu = self.query_gpu() if self.has_smi else None
        if gpu is None and self.has_smi:
            gpu = {"util": None, "memUsed": None, "memTotal": None, "powerW": None, "reading": True}
        if self.has_smi and self.gpu_name is None:
            try:
                n = subprocess.run([NVIDIA_SMI, "--query-gpu=name", "--format=csv,noheader"],
                                   capture_output=True, text=True, timeout=3).stdout.strip()
                self.gpu_name = n.splitlines()[0] if n else None
            except Exception:
                pass
        vram_pct = None
        if gpu and gpu.get("memTotal"):
            vram_pct = gpu["memUsed"] / gpu["memTotal"] * 100.0
        cpu_w = self.cpu_power_w
        gpu_w = gpu.get("powerW") if gpu else None
        total_w = None
        if cpu_w is not None or gpu_w is not None:
            total_w = (cpu_w or 0) + (gpu_w or 0)
        snap = {
            "ok": True,
            "ts": time.time(),
            "cpu": {"pct": self.cpu_pct},
            "mem": mem,
            "gpu": {
                "hasSmi": self.has_smi,
                "name": self.gpu_name,
                "util": gpu.get("util") if gpu else None,
                "memUsed": gpu.get("memUsed") if gpu else None,
                "memTotal": gpu.get("memTotal") if gpu else None,
                "powerW": gpu_w,
                "vramPct": vram_pct,
            },
            "power": {"cpuW": cpu_w, "gpuW": gpu_w, "totalW": total_w},
            "raplDenied": self.rapl_denied,
        }
        with _lock:
            global _snapshot
            _snapshot = snap


def sampler_loop(interval: float):
    s = Sampler()
    s.refresh()          # 建立首次基线（cpu/rapl 此轮为 null）
    time.sleep(interval)
    while True:
        s.refresh()
        time.sleep(interval)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json"):
        data = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.split("?")[0] in ("/metrics", "/"):
            with _lock:
                body = json.dumps(_snapshot)
            self._send(200, body)
        else:
            self._send(404, json.dumps({"error": "not found"}))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8766)
    ap.add_argument("--interval", type=float, default=2.0)
    args = ap.parse_args()

    t = threading.Thread(target=sampler_loop, args=(args.interval,), daemon=True)
    t.start()

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"systatus-server listening on http://{args.host}:{args.port}/metrics")
    srv.serve_forever()


if __name__ == "__main__":
    main()
