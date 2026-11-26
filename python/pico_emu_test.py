"""Run MicroPython code on an emulated Raspberry Pi Pico from Python (for example from pytest).

This is a thin wrapper around the ``pico-emu-test`` command line tool, which needs Node.js 22 or
newer. It starts a fresh emulated board for every call, so calls are independent of each other.

    from pico_emu_test import run

    result = run("pico", exec="print(1 + 1)")
    assert result.ok and result.stdout == "2\\n"

The command is found, in order, from the ``PICO_EMU_TEST_CLI`` environment variable (a path to
``pico-emu-test.js``), from the ``bin`` directory next to this module when it sits inside a checkout
of the repository, and finally as ``pico-emu-test`` on the PATH (``npm install -g pico-emu-test``).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping, Sequence, Union

__all__ = ["Result", "run", "find_cli"]

PathLike = Union[str, "os.PathLike[str]"]


class CliNotFound(RuntimeError):
    """Raised when the pico-emu-test command cannot be located."""


@dataclass
class Result:
    """Outcome of one run."""

    exit_code: int
    stdout: str
    stderr: str
    steps: list = field(default_factory=list)
    emulated_ms: float = 0.0
    wall_ms: float = 0.0
    error: str = ""

    @property
    def ok(self) -> bool:
        """True when every step ran without a Python exception and all expectations held."""
        return self.exit_code == 0


def find_cli() -> list[str]:
    """Return the command line prefix that starts pico-emu-test."""
    override = os.environ.get("PICO_EMU_TEST_CLI")
    if override:
        return ["node", override]
    local = Path(__file__).resolve().parent.parent / "bin" / "pico-emu-test.js"
    if local.is_file():
        return ["node", str(local)]
    installed = shutil.which("pico-emu-test")
    if installed:
        return [installed]
    raise CliNotFound(
        "pico-emu-test not found. Install it with 'npm install -g pico-emu-test' "
        "or set PICO_EMU_TEST_CLI to the path of bin/pico-emu-test.js."
    )


def run(
    firmware: PathLike,
    *,
    exec: Union[str, Sequence[str], None] = None,
    script: Union[PathLike, Sequence[PathLike], None] = None,
    files: Union[Mapping[str, PathLike], None] = None,
    expect: Union[str, Sequence[str], None] = None,
    timeout: float = 30.0,
    boot_timeout: float = 20.0,
    bootrom: Union[PathLike, None] = None,
    flash_image: Union[PathLike, None] = None,
) -> Result:
    """Boot ``firmware`` and run code on it.

    Args:
        firmware: path of a ``.uf2`` file, or ``"pico"`` / ``"pico-w"`` for the official image.
        exec: Python code, or a list of snippets, run in order.
        script: path of a Python file, or a list of paths, run after ``exec``.
        files: ``{path on the board: local file}`` copied to a RAM filesystem before running.
        expect: text (or list of texts) that must appear in the output.
        timeout: wall-clock limit in seconds for each snippet or script.
        boot_timeout: wall-clock limit in seconds to reach the MicroPython prompt.
        bootrom: RP2040 boot ROM file; by default the official one is downloaded once.
        flash_image: raw image (for example a LittleFS filesystem) copied into flash at 0xA0000.

    Returns:
        A :class:`Result`. A Python exception on the board is reported in ``result``, not raised.
    """
    cmd = find_cli() + [os.fspath(firmware), "--json", "--timeout", str(int(timeout * 1000))]
    cmd += ["--boot-timeout", str(int(boot_timeout * 1000))]
    if bootrom is not None:
        cmd += ["--bootrom", os.fspath(bootrom)]
    if flash_image is not None:
        cmd += ["--flash-image", os.fspath(flash_image)]
    for remote, local in (files or {}).items():
        cmd += ["--put", f"{os.fspath(local)}={remote}"]
    for code in _as_list(exec):
        cmd += ["--exec", code]
    for path in _as_list(script):
        cmd += ["--script", os.fspath(path)]
    for text in _as_list(expect):
        cmd += ["--expect", text]

    # A generous outer limit: the CLI enforces the per-step limits itself.
    steps = len(_as_list(exec)) + len(_as_list(script))
    outer = boot_timeout + timeout * max(steps, 1) + 60
    done = subprocess.run(cmd, capture_output=True, text=True, timeout=outer, check=False)
    try:
        report = json.loads(done.stdout)
    except json.JSONDecodeError:
        return Result(done.returncode, done.stdout, done.stderr, error=done.stderr.strip())
    steps_out = report.get("steps", [])
    return Result(
        exit_code=report.get("exitCode", done.returncode),
        stdout="".join(s.get("stdout", "") for s in steps_out),
        stderr="".join(s.get("stderr", "") for s in steps_out) or done.stderr,
        steps=steps_out,
        emulated_ms=report.get("emulatedMs", 0.0),
        wall_ms=report.get("wallMs", 0.0),
        error=report.get("error", ""),
    )


def _as_list(value):
    if value is None:
        return []
    if isinstance(value, (str, os.PathLike)):
        return [value]
    return list(value)


if __name__ == "__main__":  # pragma: no cover - convenience
    sys.exit(run(sys.argv[1], exec=sys.argv[2:]).exit_code)
