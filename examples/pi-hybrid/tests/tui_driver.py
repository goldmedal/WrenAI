"""Drive the explicitly supplied limited TUI using a local fixture session."""

import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 180, 0, 0))
buffer = b""


def until(marker):
    global buffer
    deadline = time.monotonic() + 25
    while marker not in buffer:
        if time.monotonic() > deadline:
            raise RuntimeError("TUI fixture timed out")
        if select.select([fd], [], [], 0.1)[0]:
            chunk = os.read(fd, 65536)
            if not chunk:
                raise RuntimeError("TUI exited early")
            if b"\x1b[6n" in chunk:
                os.write(fd, b"\x1b[1;1R")
            buffer += chunk
    buffer = b""


try:
    until(b"epoch=1")
    reference = 0
    for selection, epoch in [("blind", 1), ("schema", 2), ("business", 3)]:
        if epoch > 1:
            os.write(fd, f"/policy {selection}\r".encode())
            until(f"epoch={epoch}".encode())
            os.write(fd, f"/evidence {reference}\r".encode())
            until(b"Evidence unavailable in this epoch")
        os.write(fd, b"How many orders are there?\r")
        until(b"VERIFIED_VALUE=12")
        reference += 1
        os.write(fd, f"/evidence {reference}\r".encode())
        until(b'"value": 12')
        os.write(fd, b"Provide the weekly orders report.\r")
        until(b"VERIFIED_WEEKS=2025-12-29:3,2026-01-05:4,2026-01-12:5")
        reference += 1
        os.write(fd, f"/evidence {reference}\r".encode())
        until(b'"kind": "weekly_orders"')
        os.write(fd, b"How many orders in the second week? Query that week again.\r")
        until(b"VERIFIED_WEEKS=2026-01-05:4")
        reference += 1
        os.write(fd, f"/evidence {reference}\r".encode())
        until(b'"end_week": "2026-01-12"')
        os.write(fd, b"/evidence\r")
        until(b"Completion time is not data freshness.")
    os.write(fd, b"/metadata\r")
    until(b"Available within deployment policy:")
    for command, epoch, expected in [
        (
            "/metadata knowledge.rules=weekly-target",
            4,
            b"TARGET_WEEKS=2026-01-05:4,2026-01-12:5",
        ),
        ("/metadata knowledge.rules=business-rules", 5, b"CLARIFY_TARGET:"),
        ("/metadata schema.structure=structure knowledge.sql=*", 6, b"CLARIFY_TARGET:"),
        ("/metadata none", 7, b"CLARIFY_TARGET:"),
        ("/policy business", 8, b"TARGET_WEEKS=2026-01-05:4,2026-01-12:5"),
        ("/policy blind", 9, b"CLARIFY_TARGET:"),
    ]:
        os.write(fd, f"{command}\r".encode())
        until(f"epoch={epoch}".encode())
        os.write(fd, f"/evidence {reference}\r".encode())
        until(b"Evidence unavailable in this epoch")
        os.write(fd, b"Which weeks met the order-volume target?\r")
        until(expected)
        if expected.startswith(b"TARGET_WEEKS"):
            reference += 1
            os.write(fd, f"/evidence {reference}\r".encode())
            until(b'"kind": "weekly_orders"')
        else:
            os.write(fd, b"/evidence\r")
            until(b"Evidence unavailable in this epoch")
    os.write(fd, b"/metadata context=*\r")
    until(b"Invalid metadata selection.")
    os.write(fd, b"/quit\r")
    deadline = time.monotonic() + 10
    while True:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            if os.waitstatus_to_exitcode(status) != 0:
                raise RuntimeError("TUI failed")
            break
        if time.monotonic() > deadline:
            raise RuntimeError("TUI did not stop")
        if select.select([fd], [], [], 0.1)[0]:
            try:
                os.read(fd, 65536)
            except OSError:
                pass
    print("TUI_FIXTURE_OK")
finally:
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os.close(fd)
