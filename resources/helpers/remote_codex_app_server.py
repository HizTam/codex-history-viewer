"""Inspect and stop narrowly identified VS Code stdio servers on Linux."""

import errno
import json
import os
import re
import select
import signal
import stat
import sys
import time

PROC = "/proc"
MAX_PROCESSES = 10000
MAX_CANDIDATES = 100
MAX_HISTORY_ENTRIES = 50000
STOP_WAIT_MS = 45000
EXE_PATTERN = re.compile(
    r"/(?:\.vscode-server|\.vscode-server-insiders)/extensions/"
    r"openai\.chatgpt-([0-9][0-9A-Za-z.+-]{0,79})/bin/"
    r"linux-(?:x86_64|aarch64)/codex$"
)
HISTORY_PATTERN = re.compile(r"rollout-[^/\x00]+\.jsonl(?:\.zst)?$")


def read_bytes(file_path, limit=65536):
    with open(file_path, "rb") as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise ValueError("limit")
    return data


def process_stat(pid):
    data = read_bytes(os.path.join(PROC, str(pid), "stat"), 8192).decode("utf-8")
    fields = data[data.rindex(")") + 2:].split()
    return fields[0], int(fields[1]), fields[19]


def host_relation(pid, host_pid):
    # Unknown ancestry must never become permission to stop a process.
    seen = set()
    try:
        for _ in range(64):
            if pid == host_pid:
                return "currentHost"
            if pid in (0, 1):
                return "otherHost"
            if pid in seen:
                return "unknownParent"
            seen.add(pid)
            _, pid, _ = process_stat(pid)
    except (OSError, ValueError, IndexError, UnicodeError):
        return "unknownParent"
    return "unknownParent"


def valid_args(args):
    # Match the known extension launch grammar, excluding daemon and network modes.
    rest = args[1:]
    while len(rest) >= 2 and rest[0] in ("-c", "--config"):
        if "=" not in rest[1]:
            return False
        rest = rest[2:]
    return rest in (["app-server"], ["app-server", "--analytics-default-enabled"])


def inspect_process(pid, host_pid):
    folder = os.path.join(PROC, str(pid))
    state, ppid, ticks = process_stat(pid)
    if pid <= 1 or state in ("Z", "X") or not ticks.isdecimal():
        return None
    status = read_bytes(os.path.join(folder, "status")).decode("utf-8")
    uid_match = re.search(r"^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$", status, re.M)
    if not uid_match or any(int(uid) != os.getuid() for uid in uid_match.groups()):
        return None
    executable = os.readlink(os.path.join(folder, "exe"))
    clean_exe = executable.removesuffix(" (deleted)")
    match = EXE_PATTERN.search(clean_exe)
    if not match:
        return None
    args_raw = read_bytes(os.path.join(folder, "cmdline"))
    args = args_raw.rstrip(b"\0").decode("utf-8").split("\0")
    if not valid_args(args) or args[0] != clean_exe:
        return None
    for descriptor in ("0", "1"):
        # Node/libuv implements spawn stdio="pipe" using socket pairs on Linux.
        if not re.fullmatch(r"(?:pipe|socket):\[\d+\]", os.readlink(os.path.join(folder, "fd", descriptor))):
            return None
    executable_stat = os.stat(os.path.join(folder, "exe"))
    _, current_parent, current_ticks = process_stat(pid)
    if ticks != current_ticks or ppid != current_parent:
        return None
    return {
        "pid": pid, "ppid": ppid, "ticks": ticks, "uid": os.getuid(),
        "executable": executable, "device": str(executable_stat.st_dev),
        "inode": str(executable_stat.st_ino), "args": args,
        "version": match.group(1), "hostRelation": host_relation(pid, host_pid),
    }


def history_updated(root):
    if not os.path.isdir(root):
        return None
    latest = None
    pending = [(root, 0)]
    visited = 0
    deadline = time.monotonic() + 3
    while pending:
        folder, depth = pending.pop()
        with os.scandir(folder) as entries:
            for entry in entries:
                visited += 1
                if visited > MAX_HISTORY_ENTRIES or time.monotonic() > deadline:
                    raise ValueError("limit")
                if entry.is_symlink():
                    continue
                if entry.is_dir(follow_symlinks=False):
                    if depth >= 8:
                        raise ValueError("limit")
                    pending.append((entry.path, depth + 1))
                elif HISTORY_PATTERN.fullmatch(entry.name) and entry.is_file(follow_symlinks=False):
                    modified = int(entry.stat(follow_symlinks=False).st_mtime * 1000)
                    latest = modified if latest is None else max(latest, modified)
    return latest


def associated_updated(pid, root):
    latest = None
    folder = os.path.join(PROC, str(pid))
    try:
        with os.scandir(os.path.join(folder, "fd")) as entries:
            for index, entry in enumerate(entries):
                if index >= 2048:
                    return None
                try:
                    target = os.readlink(entry.path)
                    if not HISTORY_PATTERN.fullmatch(os.path.basename(target)):
                        continue
                    if os.path.commonpath([root, os.path.realpath(target)]) != root:
                        continue
                    info = read_bytes(os.path.join(folder, "fdinfo", entry.name), 8192).decode("utf-8")
                    flags = re.search(r"^flags:\s+([0-7]+)$", info, re.M)
                    if not flags or int(flags.group(1), 8) & os.O_ACCMODE == os.O_RDONLY:
                        continue
                    file_stat = os.stat(entry.path)
                    if stat.S_ISREG(file_stat.st_mode):
                        modified = int(file_stat.st_mtime * 1000)
                        latest = modified if latest is None else max(latest, modified)
                except (FileNotFoundError, ProcessLookupError):
                    continue
    except (OSError, ValueError, UnicodeError):
        return None
    return latest


def require_pidfd():
    if sys.version_info < (3, 9) or not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise NotImplementedError()
    descriptor = os.pidfd_open(os.getpid())
    try:
        signal.pidfd_send_signal(descriptor, 0)
    finally:
        os.close(descriptor)


def scan(host_pid, root):
    require_pidfd()
    boot_match = re.search(rb"^btime (\d+)$", read_bytes(os.path.join(PROC, "stat"), 1048576), re.M)
    if not boot_match:
        raise ValueError("boot")
    boot = int(boot_match.group(1))
    ticks_per_second = os.sysconf("SC_CLK_TCK")
    candidates = []
    partial = False
    deadline = time.monotonic() + 5
    with os.scandir(PROC) as entries:
        count = 0
        for entry in entries:
            if not entry.name.isdecimal():
                continue
            count += 1
            if count > MAX_PROCESSES or len(candidates) >= MAX_CANDIDATES or time.monotonic() > deadline:
                partial = True
                break
            try:
                identity = inspect_process(int(entry.name), host_pid)
                if identity:
                    updated = associated_updated(identity["pid"], root)
                    if inspect_process(identity["pid"], host_pid) != identity:
                        continue
                    candidates.append({
                        "identity": identity,
                        "startedAt": int((boot + int(identity["ticks"]) / ticks_per_second) * 1000),
                        "historyUpdatedAt": updated,
                    })
            except (FileNotFoundError, ProcessLookupError):
                continue
            except PermissionError:
                # Other users' processes are outside the scope of this operation.
                if entry.stat(follow_symlinks=False).st_uid == os.getuid():
                    partial = True
            except (OSError, ValueError, IndexError, UnicodeError):
                partial = True
    history_complete = True
    try:
        updated = history_updated(root)
    except (OSError, ValueError):
        updated = None
        history_complete = False
    candidates.sort(key=lambda item: (item["startedAt"], item["identity"]["pid"]))
    return {"status": "ok", "candidates": candidates, "partial": partial,
            "historyUpdatedAt": updated, "historyComplete": history_complete}


def stop(host_pid, expected, allow_current_host=False):
    require_pidfd()
    if not isinstance(expected, dict) or type(expected.get("pid")) is not int or expected["pid"] <= 1:
        return {"status": "stale"}
    descriptor = os.pidfd_open(expected["pid"])
    sent = False
    try:
        poller = select.poll()
        poller.register(descriptor, select.POLLIN)
        current = inspect_process(expected["pid"], host_pid)
        if not current or current != expected or poller.poll(0):
            return {"status": "stale"}
        # Current-host termination requires explicit confirmation; unknown ancestry is never allowed.
        relation = current["hostRelation"]
        if relation != "otherHost" and not (relation == "currentHost" and allow_current_host is True):
            return {"status": "stale"}
        # The descriptor pins the original process even if its PID is later reused.
        signal.pidfd_send_signal(descriptor, signal.SIGTERM)
        sent = True
        return {"status": "stopped" if poller.poll(STOP_WAIT_MS) else "pending"}
    except OSError:
        if sent:
            return {"status": "unknown"}
        raise
    finally:
        os.close(descriptor)


def main():
    try:
        request = json.loads(read_bytes_stdin())
        if not isinstance(request, dict) or request.get("hostPid") != os.getppid():
            raise ValueError("host")
        if request.get("operation") == "probe":
            # Check interpreter/kernel capabilities without inspecting or stopping other processes.
            require_pidfd()
            result = {"status": "ok"}
        elif request.get("operation") == "scan":
            root = request.get("root")
            if not isinstance(root, str) or len(root) > 4096 or not os.path.isabs(root) or "\0" in root:
                raise ValueError("root")
            result = scan(request["hostPid"], os.path.realpath(root))
        elif request.get("operation") == "stop":
            result = stop(request["hostPid"], request.get("identity"), request.get("allowCurrentHost", False))
        else:
            raise ValueError("operation")
    except (ProcessLookupError, FileNotFoundError):
        result = {"status": "stale"}
    except PermissionError:
        result = {"status": "permission"}
    except NotImplementedError:
        result = {"status": "unsupported"}
    except OSError as error:
        result = {"status": "unsupported" if error.errno in (errno.ENOSYS, errno.EINVAL) else "failed"}
    except (ValueError, TypeError, KeyError, IndexError, UnicodeError):
        result = {"status": "failed"}
    # Never emit paths, arguments, or exception messages on failure.
    sys.stdout.buffer.write((json.dumps(result, ensure_ascii=True) + "\n").encode("utf-8"))


def read_bytes_stdin():
    raw = sys.stdin.buffer.read(16385)
    if len(raw) > 16384:
        raise ValueError("request")
    return raw.decode("utf-8")


if __name__ == "__main__":
    main()
