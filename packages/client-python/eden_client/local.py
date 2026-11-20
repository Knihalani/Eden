"""Fail-open owner of one local Eden process. The caller owns registration of ``close`` at exit."""

from __future__ import annotations

import json
import os
import re
import secrets
import signal
import subprocess
import sys
import threading
import time
import urllib.request
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


_HOLDER = (
    # Keeps the detached server's stdin pipe open past the spawning process's exit; dies with the server.
    "import os,sys,time\n"
    "p=int(sys.argv[1])\n"
    "if sys.platform=='win32':\n"
    " import ctypes\n"
    " k=ctypes.windll.kernel32\n"
    " while True:\n"
    "  h=k.OpenProcess(0x1000,False,p)\n"
    "  if not h: break\n"
    "  k.CloseHandle(h)\n"
    "  time.sleep(60)\n"
    "else:\n"
    " while True:\n"
    "  try: os.kill(p,0)\n"
    "  except OSError: break\n"
    "  except Exception: pass\n"
    "  time.sleep(60)\n"
)


class LocalEden:
    """Serialize startup/restarts; each successful endpoint carries a fresh generation and token.

    ``share_path`` is for agents whose events each run in their own process (Claude Code's hooks):
    the first process starts a detached server (a tiny holder keeps its lifetime pipe open), writes
    the endpoint there, and every later process attaches to it instead of spawning a fresh Eden —
    which would lose the session state (delivered packets, checked parties) the check depends on.
    """

    def __init__(self, binary, data_dir, *, sources_file=None, user_sources_file=None, log_path=None,
                 base_env: Optional[Mapping[str, str]] = None, ready_timeout=10.0, share_path=None):
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
        self._share = Path(share_path) if share_path else None
        self._attached = False

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
                        match = re.fullmatch(rb"EDEN_LOCAL_READY ([0-9]{1,5})\r?", line)
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
        self._attached = False
        if process is None:
            return
        if self._share is not None and process.poll() is None:
            return  # a shared server outlives this process by design
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

    def _sources_sig(self):
        """The configured source files' identity: a server started before they existed/changed is stale."""
        sig = []
        for p in (self._sources, self._users):
            if not p:
                continue
            try:
                st = Path(p).expanduser().resolve().stat()
                sig.append([str(p), st.st_mtime_ns, st.st_size])
            except Exception:
                sig.append([str(p), None, None])
        return sig

    def _attach(self):
        """A live shared server recorded by an earlier process, else None (and the stale file removed).

        A recorded daemon that predates the current source configuration is stopped and replaced,
        else new sessions would keep attaching to a server that knows no sources. Its pid is only
        signalled when it answered healthz — the file pairs pid with the server, so the pid is still
        that daemon's (a recycled dead pid belongs to something else and is left alone)."""
        try:
            data = json.loads(self._share.read_text())
            url, token, generation = str(data["url"]), str(data["token"]), str(data["generation"])
        except Exception:
            return None
        stale = data.get("sources", []) != self._sources_sig()
        try:
            # Bypass proxies: some environments route loopback through a refusing HTTP proxy.
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            req = urllib.request.Request(f"{url}/healthz", headers={"Authorization": f"Bearer {token}"})
            with opener.open(req, timeout=2) as resp:
                if resp.status != 200:
                    raise ValueError(f"healthz answered {resp.status}")
        except Exception:
            try:
                self._share.unlink(missing_ok=True)
            except Exception:
                pass
            return None
        if stale:
            try:
                os.kill(int(data["pid"]), signal.SIGTERM)
            except Exception:
                pass
            try:
                self._share.unlink(missing_ok=True)
            except Exception:
                pass
            return None
        self._attached = True
        self._endpoint = (url, token, generation)
        return self._endpoint

    def _write_share(self):
        try:
            self._share.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            tmp = self._share.with_name(self._share.name + ".tmp")
            tmp.write_text(json.dumps({"url": self._endpoint[0], "token": self._endpoint[1],
                                       "pid": self._process.pid, "generation": self._endpoint[2],
                                       "sources": self._sources_sig()}))
            os.chmod(tmp, 0o600)
            tmp.replace(self._share)
        except Exception:
            pass

    def _spawn_shared(self, token):
        """Spawn detached: stderr appends to the log file (no pipe to block on), and a holder process
        keeps the lifetime pipe's write end open past this process's exit, dying with the server."""
        err = None
        if self._log_path:
            try:
                self._log_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                err = open(self._log_path, "ab")
            except Exception:
                err = None
        rfd, wfd = os.pipe()
        try:
            env = self._child_env(token)
            # The share file's directory is the daemon's durable home (D1994).
            env["EDEN_LOCAL_STATE_DIR"] = str(self._share.parent)
            proc = subprocess.Popen(
                [self._binary], stdin=rfd, stdout=subprocess.PIPE,
                stderr=err if err is not None else subprocess.DEVNULL,
                close_fds=True, env=env, start_new_session=True,
            )
        except Exception:
            os.close(wfd)
            if err is not None:
                err.close()
            raise
        os.close(rfd)
        try:
            if sys.platform == "win32":  # pass_fds is POSIX-only; the holder inherits the handle
                os.set_inheritable(wfd, True)
                subprocess.Popen([sys.executable, "-c", _HOLDER, str(proc.pid)],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, close_fds=False)
            else:
                subprocess.Popen([sys.executable, "-c", _HOLDER, str(proc.pid)],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, close_fds=True, pass_fds=(wfd,),
                                 start_new_session=True)
        finally:
            os.close(wfd)
        return proc

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
                if self._attached:
                    return self._endpoint
                if self._share is not None:
                    attached = self._attach()
                    if attached is not None:
                        return attached
                if time.monotonic() < self._retry_at:
                    return None
                self._started = 0.0
                if sys.platform == "darwin":
                    # A plugin installed by Finder/ditto keeps the download's quarantine xattr, and the kernel
                    # refuses exec of an unsigned quarantined binary (EPERM); stripping it is harmless otherwise.
                    try:
                        subprocess.run(["xattr", "-d", "com.apple.quarantine", self._binary],
                                       capture_output=True, timeout=10)
                    except (OSError, subprocess.TimeoutExpired):
                        pass
                token = secrets.token_urlsafe(32)
                if self._share is None:
                    self._process = subprocess.Popen(
                        [self._binary], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE if self._log_path else subprocess.DEVNULL,
                        close_fds=True, env=self._child_env(token),
                    )
                else:
                    self._process = self._spawn_shared(token)
                ready, result = threading.Event(), []
                thread = threading.Thread(target=self._stdout, args=(self._process.stdout, ready, result), daemon=True)
                self._threads = [thread]
                if self._log_path and self._share is None:
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
                port = result[0]
                # A shared daemon's generation must be unique across processes' restarts, or a
                # long-lived attacher's client cache would keep a replaced daemon's endpoint.
                generation = (f"{self._generation}:{secrets.token_hex(8)}" if self._share is not None
                              else self._generation)
                self._endpoint = (f"http://127.0.0.1:{port}", token, generation)
                if self._share is not None:
                    self._write_share()
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
                if self._share is not None:
                    self._attached = False  # the next endpoint() call re-probes the recorded server
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
