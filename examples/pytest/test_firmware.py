"""pytest examples: the same kind of checks, driven from Python.

Run from the repository root:

    python -m pytest examples/pytest
"""

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))

from pico_emu_test import run  # noqa: E402

FIRMWARE = "pico"  # the official MicroPython image; use the path of your own .uf2 for your firmware


def test_arithmetic():
    result = run(FIRMWARE, exec="print(6 * 7)")
    assert result.ok
    assert result.stdout == "42\n"


def test_a_python_error_is_reported_not_raised():
    result = run(FIRMWARE, exec="1 / 0")
    assert not result.ok
    assert result.exit_code == 1
    assert "ZeroDivisionError" in result.stderr


def test_files_are_copied_before_running(tmp_path):
    module = tmp_path / "config.py"
    module.write_text("GREETING = 'hello from a file'\n")
    result = run(FIRMWARE, files={"/config.py": module}, exec="import config\nprint(config.GREETING)")
    assert result.ok, result.error
    assert result.stdout.strip() == "hello from a file"


def test_expect_makes_the_run_fail_when_text_is_missing():
    result = run(FIRMWARE, exec="print('abc')", expect="xyz")
    assert result.exit_code == 4


@pytest.mark.parametrize("sleep_ms", [10, 100])
def test_emulated_time_is_reported(sleep_ms):
    result = run(FIRMWARE, exec=f"import time\ntime.sleep_ms({sleep_ms})")
    assert result.ok
    assert result.emulated_ms >= sleep_ms
