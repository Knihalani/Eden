"""Fail-open owner of one local Eden process. The caller owns registration of ``close`` at exit."""

from __future__ import annotations

import json
import os
import re
import secrets
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Mapping, Optional


_RUNTIME = frozenset("PATH SYSTEMROOT WINDIR COMSPEC PATHEXT TEMP TMP TMPDIR HOME USERPROFILE LOCALAPPDATA APPDATA "
                     "LANG LC_ALL LC_CTYPE TZ".split())
_LOG_CAP = 1024 * 1024


def _credential_names(value):
    if isinstance(value, dict):
        if set(value) == {"env"} and isinstance(value["env"], str):
            yield value["env"]
        for child in value.values():
            yield from _credential_names(child)
    elif isinstance(value, list):
        for child in value:
            yield from _credential_names(child)


def _allowed(name):
    upper = name.upper()
    return (upper not in _RUNTIME and upper not in {"HOST", "PORT", "PROXY", "OPENROUTER_API_KEY"}
            and not upper.endswith("_PROXY")
            and not upper.startswith(("EDEN_", "LD_", "DYLD_", "PYTHON", "BUN_", "NODE_")))


class LocalEden:
    """Serialize startup/restarts; each successful endpoint carries a fresh generation and token."""

    def __init__(self, binary, data_dir, *, sources_file=None, user_sources_file=None, log_path=None,
                 base_env: Optional[Mapping[str, str]] = None, ready_timeout=10.0):
        self._binary = str(binary)
        self._home = str(data_dir)
        self._sources = sources_file
        self._users = user_sources_file
        self._log_path = Path(log_path) if log_path else None
        self._env = dict(os.environ if base_env is None else base_env)
        self._timeout = max(0.01, min(float(ready_timeout), 10.0))
        self._lock = threading.Lock()
        self._process = None
        self._threads = []
        self._endpoint = None
        self._generation = 0
        self._closed = False
        self._retry_at = 0.0
        self._backoff = 1.0
        self._started = 0.0
        self._warned = set()

    def _warn(self, problem):
        if problem not in self._warned:
            self._warned.add(problem)
            try:
                print(f"[eden] local server: {problem}", file=sys.stderr)
            except Exception:
                pass

    def _child_env(self, token):
        env = {k: v for k, v in self._env.items() if k in _RUNTIME}
        if self._users:
            try:
                with open(self._users, encoding="utf-8") as source:
                    names = set(_credential_names(json.load(source)))
                for name in names:
                    if _allowed(name) and name in self._env:
                        env[name] = self._env[name]
            except Exception:
                pass
        env.update(EDEN_LOCAL="1", EDEN_LOCAL_TOKEN=token, HOST="127.0.0.1", PORT="0", EDEN_HOME=self._home)
        for key, value in (("EDEN_SOURCES_FILE", self._sources), ("EDEN_USER_SOURCES_FILE", self._users)):
            if value:
                env[key] = str(value)
        return env

    def _stdout(self, pipe, ready, result):
        total = 0
        line = bytearray()
        try:
            while True:
                chunk = os.read(pipe.fileno(), 4096)
                if not chunk:
                    return
                if ready.is_set():
                    continue
                for byte in chunk:
                    total += 1
                    if total > 65536 or len(line) > 1024:
                        result.append(None)
                        ready.set()
                        break
                    if byte == 10:
                        match = re.fullmatch(rb"EDEN_LOCAL_READY ([0-9]{1,5})", line)
                        if match:
                            port = int(match[1])
                            result.append(port if 1 <= port <= 65535 else None)
                            ready.set()
                            break
                        line.clear()
                    else:
                        line.append(byte)
        except Exception:
            pass
        finally:
            if not ready.is_set():
                result.append(None)
                ready.set()
            pipe.close()

    def _stderr(self, pipe):
        log = None
        try:
            path = self._log_path
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            for existing in (path, Path(str(path) + ".1")):
                if existing.exists() and existing.stat().st_size > _LOG_CAP:
                    with open(existing, "r+b") as old:
                        old.truncate(_LOG_CAP)
            log = open(path, "ab")
            while True:
                chunk = os.read(pipe.fileno(), 8192)
                if not chunk:
                    break
                if log.tell() + len(chunk) > _LOG_CAP:
                    log.close()
                    os.replace(path, str(path) + ".1")
                    log = open(path, "wb")
                log.write(chunk)
                log.flush()
        except Exception:
            # Even an unwritable log must not block the child's stderr pipe.
            try:
                while os.read(pipe.fileno(), 8192):
                    pass
            except Exception:
                pass
        finally:
            if log is not None:
                log.close()
            pipe.close()

    def _stop(self):
        process = self._process
        self._process = None
        self._endpoint = None
        if process is None:
            return
        try:
            process.stdin.close()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=0.5)
        except Exception:
            try:
                process.kill()
                process.wait(timeout=0.5)
            except Exception:
                pass
        for thread in self._threads:
            thread.join(timeout=0.1)
        self._threads = []

    def _failure(self, problem):
        if self._started and time.monotonic() - self._started >= 60:
            self._backoff = 1.0
        self._stop()
        self._retry_at = time.monotonic() + self._backoff
        self._backoff = min(60.0, self._backoff * 2)
        self._warn(problem)

    def endpoint(self):
        """Return ``(loopback URL, bearer token, generation)`` or None, never an exception."""
        with self._lock:
            try:
                if self._closed:
                    return None
                if self._process is not None:
                    if self._process.poll() is None:
                        return self._endpoint
                    self._failure("child exited")
                if time.monotonic() < self._retry_at:
                    return None
                self._started = 0.0
                token = secrets.token_urlsafe(32)
                self._process = subprocess.Popen(
                    [self._binary], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE if self._log_path else subprocess.DEVNULL,
                    close_fds=True, env=self._child_env(token),
                )
                ready, result = threading.Event(), []
                thread = threading.Thread(target=self._stdout, args=(self._process.stdout, ready, result), daemon=True)
                self._threads = [thread]
                if self._log_path:
                    self._threads.append(threading.Thread(target=self._stderr, args=(self._process.stderr,), daemon=True))
                for worker in self._threads:
                    worker.start()
                ready.wait(self._timeout)
                if not result or result[0] is None or self._process.poll() is not None:
                    self._process.kill()
                    self._failure("child did not become ready")
                    return None
                self._generation += 1
                self._started = time.monotonic()
                self._endpoint = (f"http://127.0.0.1:{result[0]}", token, self._generation)
                return self._endpoint
            except Exception:
                self._failure("could not start child")
                return None

    def failed(self, generation):
        """A failed connection prompts a poll, not termination of a live child."""
        try:
            with self._lock:
                if generation == self._generation and self._process is not None and self._process.poll() is not None:
                    self._failure("child exited")
        except Exception:
            pass

    def close(self):
        """Close the lifetime pipe, then terminate/kill an uncooperative child. Safe for atexit."""
        try:
            with self._lock:
                self._closed = True
                self._stop()
        except Exception:
            pass
