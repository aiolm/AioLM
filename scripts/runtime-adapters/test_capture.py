import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "adapter_capture", Path(__file__).with_name("create_adapter.py")
)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


def capture_driver(mode, result_path, extra):
    result_path = Path(result_path)
    try:
        if mode == "unicode":
            value = adapter.capture(
                [
                    sys.executable,
                    "-c",
                    "import sys, time; "
                    "data = (chr(0x1f600) * 70000).encode(); "
                    "sys.stdout.buffer.write(data[:1]); sys.stdout.buffer.flush(); "
                    "time.sleep(0.02); sys.stdout.buffer.write(data[1:])",
                ]
            )
            result = {"status": "ok", "value": value}
        elif mode in ("bad", "bad-nonzero"):
            suffix = "sys.exit(7)" if mode == "bad-nonzero" else "pass"
            try:
                adapter.capture(
                    [
                        sys.executable,
                        "-c",
                        "import sys; sys.stdout.buffer.write(b'a' * 65536 + b'\\xff'); "
                        + suffix,
                    ]
                )
            except BaseException as error:
                result = {"status": "error", "error": type(error).__name__}
            else:
                result = {"status": "returned"}
        elif mode == "descendant":
            pid_path, stop_path, done_path = map(Path, extra)
            grandchild = (
                "import os, pathlib, sys, time\n"
                "pathlib.Path(sys.argv[1]).write_text(str(os.getpid()), encoding='ascii')\n"
                "while not pathlib.Path(sys.argv[2]).exists():\n"
                "    time.sleep(0.01)\n"
                "pathlib.Path(sys.argv[3]).write_text('stopped')\n"
            )
            child = (
                "import pathlib, subprocess, sys, time\n"
                f"subprocess.Popen([sys.executable, '-c', {grandchild!r}, "
                f"{str(pid_path)!r}, {str(stop_path)!r}, {str(done_path)!r}], close_fds=False)\n"
                f"stop = pathlib.Path({str(stop_path)!r})\n"
                "while not stop.exists():\n"
                "    time.sleep(0.01)\n"
            )
            with patch.object(adapter, "_CAPTURE_TIMEOUT", 0.2):
                try:
                    adapter.capture([sys.executable, "-c", child])
                except subprocess.TimeoutExpired:
                    result = {"status": "timeout"}
                else:
                    result = {"status": "returned"}
        else:
            raise ValueError("unknown capture driver mode")
    except BaseException as error:
        result = {"status": "driver-error", "error": type(error).__name__}
    result_path.write_text(json.dumps(result, ensure_ascii=True), encoding="utf-8")
    return 0 if result.get("status") in ("ok", "error", "timeout") else 1


def wait_for(path):
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        if path.is_file():
            return True
        time.sleep(0.01)
    return path.is_file()


class CaptureTests(unittest.TestCase):
    def command(self, body):
        return [sys.executable, "-c", body]

    def run_driver(self, mode, result_path, *extra):
        driver = subprocess.Popen(
            [
                sys.executable,
                "-X",
                "utf8",
                "-B",
                str(Path(__file__).absolute()),
                "--capture-driver",
                mode,
                str(result_path),
                *map(str, extra),
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            code = driver.wait(timeout=5)
        except subprocess.TimeoutExpired:
            driver.kill()
            driver.wait()
            self.fail("capture driver exceeded its watchdog")
        self.assertEqual(code, 0)
        self.assertTrue(result_path.is_file())
        return json.loads(result_path.read_text(encoding="utf-8"))

    def test_concurrent_drain_preserves_stdout_first_prefix(self):
        value = adapter.capture(
            self.command(
                "import sys; "
                "sys.stdout.buffer.write(b'o' * (256 * 1024)); "
                "sys.stdout.buffer.flush(); "
                "sys.stderr.buffer.write(b'e' * (256 * 1024))"
            )
        )
        self.assertEqual(value, "o" * 65536)

    def test_small_stdout_keeps_stderr_prefix(self):
        value = adapter.capture(
            self.command(
                "import sys; sys.stdout.write('out'); "
                "sys.stderr.write('e' * 100000)"
            )
        )
        self.assertEqual(value, "out" + "e" * (65536 - 3))

    def test_unicode_split_decoder_and_universal_newlines(self):
        with tempfile.TemporaryDirectory() as area:
            result = self.run_driver("unicode", Path(area) / "result.json")
        self.assertEqual(result, {"status": "ok", "value": chr(0x1f600) * 65536})

        value = adapter.capture(
            self.command(
                "import sys; sys.stdout.buffer.write(b'a\\r'); "
                "sys.stdout.buffer.flush(); sys.stdout.buffer.write(b'\\nb\\r\\nc')"
            )
        )
        self.assertEqual(value, "a\nb\nc")

    def test_bad_encoding_after_retained_prefix_is_not_dropped(self):
        with tempfile.TemporaryDirectory() as area:
            result = self.run_driver("bad", Path(area) / "result.json")
        self.assertEqual(result, {"status": "error", "error": "UnicodeDecodeError"})

    def test_active_locale_matches_stdlib_for_ascii_output(self):
        command = self.command(
            "import sys; sys.stdout.buffer.write(b'a\\r\\nb\\r'); "
            "sys.stderr.buffer.write(b'err')"
        )
        expected = subprocess.run(command, capture_output=True, text=True, timeout=15)
        self.assertEqual(
            adapter.capture(command),
            (expected.stdout + expected.stderr)[: adapter._CAPTURE_LIMIT],
        )

    def test_nonzero_after_large_output_keeps_failure_contract(self):
        with self.assertRaisesRegex(
            ValueError, "runtime version/help probe failed; inspect the selected installation"
        ):
            adapter.capture(
                self.command(
                    "import sys; "
                    "sys.stdout.buffer.write(b'o' * (256 * 1024)); "
                    "sys.stderr.buffer.write(b'e' * (256 * 1024)); "
                    "sys.exit(7)"
                )
            )

    def test_nonzero_malformed_output_keeps_generic_error_priority(self):
        with tempfile.TemporaryDirectory() as area:
            result = self.run_driver("bad-nonzero", Path(area) / "result.json")
        self.assertEqual(result, {"status": "error", "error": "ValueError"})

    def test_timeout_kills_direct_child(self):
        with tempfile.TemporaryDirectory() as area:
            survived = Path(area) / "survived"
            with patch.object(adapter, "_CAPTURE_TIMEOUT", 0.05):
                with self.assertRaises(subprocess.TimeoutExpired) as raised:
                    adapter.capture(
                        self.command(
                            f"import pathlib, time; time.sleep(0.4); "
                            f"pathlib.Path({str(survived)!r}).write_text('survived')"
                        )
                    )
            self.assertEqual(raised.exception.timeout, 0.05)
            time.sleep(0.5)
            self.assertFalse(survived.exists())

    def test_timeout_does_not_wait_for_descendant_holding_pipe(self):
        with tempfile.TemporaryDirectory() as area:
            root = Path(area)
            pid_file = root / "grandchild.pid"
            stop_file = root / "grandchild.stop"
            done_file = root / "grandchild.done"
            result = root / "driver.json"
            driver = subprocess.Popen(
                [
                    sys.executable,
                    "-X",
                    "utf8",
                    "-B",
                    str(Path(__file__).absolute()),
                    "--capture-driver",
                    "descendant",
                    str(result),
                    str(pid_file),
                    str(stop_file),
                    str(done_file),
                ],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            hung = False
            try:
                try:
                    driver.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    hung = True
                    driver.kill()
                    driver.wait()
            finally:
                stop_file.write_text("stop", encoding="ascii")
            self.assertFalse(hung, "capture driver exceeded its watchdog")
            self.assertEqual(driver.returncode, 0)
            self.assertTrue(wait_for(pid_file))
            self.assertEqual(json.loads(result.read_text(encoding="utf-8")), {"status": "timeout"})
            self.assertTrue(wait_for(done_file))


if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] == "--capture-driver":
        raise SystemExit(capture_driver(sys.argv[2], sys.argv[3], sys.argv[4:]))
    unittest.main()
