"""Desktop registration must preserve user entries and literal executable paths."""

import importlib.util
from pathlib import Path
import tempfile
import shutil
import subprocess
import time
import unittest

spec = importlib.util.spec_from_file_location("desktop", Path(__file__).with_name("register-linux-desktop.py"))
desktop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(desktop)


class PassthroughPath:
    """Delegate a temporary path while hooking one exact desktop entry."""

    def __init__(self, path, target, on_exists=None, on_read_text=None):
        self.path = path if isinstance(path, Path) else Path(path)
        self.target = target if isinstance(target, Path) else Path(target)
        self.on_exists = on_exists
        self.on_read_text = on_read_text

    def __truediv__(self, child):
        return type(self)(self.path / child, self.target, self.on_exists, self.on_read_text)

    @property
    def parent(self):
        return type(self)(self.path.parent, self.target, self.on_exists, self.on_read_text)

    def exists(self):
        if self.path == self.target and self.on_exists:
            return self.on_exists(self.path)
        return self.path.exists()

    def read_text(self, *args, **kwargs):
        if self.path == self.target and self.on_read_text:
            return self.on_read_text(self.path)
        return self.path.read_text(*args, **kwargs)

    def __fspath__(self):
        return self.path.__fspath__()

    def __str__(self):
        return str(self.path)

    def __getattr__(self, name):
        return getattr(self.path, name)


class DesktopRegistrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="aiolm-desktop-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.icon = self.root / "source.png"
        self.icon.write_bytes(b"synthetic icon")
        self.data = self.root / "user data"

    def test_development_window_has_matching_identity_without_menu_launcher(self):
        entry = desktop.register(self.root / "debug/aiolm", self.icon, self.data, True)
        self.assertEqual(entry.name, "aiolm.desktop")
        self.assertIn("StartupWMClass=aiolm\n", entry.read_text())
        self.assertIn("NoDisplay=true\n", entry.read_text())
        self.assertEqual((self.data / "icons/hicolor/128x128/apps/aiolm-local.png").read_bytes(), self.icon.read_bytes())

    def test_appimage_registration_updates_owned_entry_and_shows_launcher(self):
        desktop.register(self.root / "old.AppImage", self.icon, self.data, True)
        entry = desktop.register(self.root / "new.AppImage", self.icon, self.data)
        self.assertIn("NoDisplay=false\n", entry.read_text())
        self.assertIn("new.AppImage", entry.read_text())
        self.assertNotIn("old.AppImage", entry.read_text())

    def test_unmanaged_entry_and_icon_are_preserved(self):
        entry = self.data / "applications/aiolm.desktop"
        entry.parent.mkdir(parents=True)
        entry.write_text("[Desktop Entry]\nName=User launcher\n")
        with self.assertRaisesRegex(RuntimeError, "unmanaged"):
            desktop.register(self.root / "aiolm", self.icon, self.data)
        self.assertEqual(entry.read_text(), "[Desktop Entry]\nName=User launcher\n")
        self.assertFalse((self.data / "icons").exists())

    def test_development_does_not_replace_an_installed_appimage_launcher(self):
        entry = desktop.register(self.root / "installed.AppImage", self.icon, self.data)
        original = entry.read_text()
        desktop.register(self.root / "debug/aiolm", self.icon, self.data, True)
        self.assertEqual(entry.read_text(), original)

    def test_development_preserves_appimage_replaced_after_entry_read(self):
        replacement_icon = self.root / "replacement.png"
        replacement_icon.write_bytes(b"replacement icon")
        entry = desktop.register(self.root / "old.AppImage", self.icon, self.data, True)
        entry.chmod(0o640)
        state = {"reads": [], "replacement": None}

        def read_text(path):
            text = path.read_text()
            state["reads"].append(text)
            if len(state["reads"]) == 1:
                replacement = desktop.register(self.root / "new.AppImage", replacement_icon, self.data)
                state["replacement"] = {
                    "text": replacement.read_text(),
                    "icon": (self.data / "icons/hicolor/128x128/apps/aiolm-local.png").read_bytes(),
                    "mode": replacement.stat().st_mode & 0o777,
                }
            return text

        data = PassthroughPath(self.data, entry, on_read_text=read_text)
        result = Path(desktop.register(self.root / "debug/aiolm", self.icon, data, True))
        self.assertEqual(result.read_text(), state["replacement"]["text"])
        self.assertIn("NoDisplay=false\n", result.read_text())
        self.assertIn("new.AppImage", result.read_text())
        self.assertEqual((self.data / "icons/hicolor/128x128/apps/aiolm-local.png").read_bytes(),
                         state["replacement"]["icon"])
        self.assertEqual(result.stat().st_mode & 0o777, state["replacement"]["mode"])

    def test_development_preserves_appimage_created_after_entry_was_absent(self):
        replacement_icon = self.root / "replacement.png"
        replacement_icon.write_bytes(b"replacement icon")
        target = self.data / "applications/aiolm.desktop"
        state = {"exists": 0, "replacement": None}

        def exists(path):
            state["exists"] += 1
            if state["exists"] == 1:
                replacement = desktop.register(self.root / "late.AppImage", replacement_icon, self.data)
                state["replacement"] = {
                    "text": replacement.read_text(),
                    "icon": (self.data / "icons/hicolor/128x128/apps/aiolm-local.png").read_bytes(),
                    "mode": replacement.stat().st_mode & 0o777,
                }
                return False
            return path.exists()

        data = PassthroughPath(self.data, target, on_exists=exists)
        result = Path(desktop.register(self.root / "debug/aiolm", self.icon, data, True))
        self.assertEqual(result.read_text(), state["replacement"]["text"])
        self.assertIn("NoDisplay=false\n", result.read_text())
        self.assertIn("late.AppImage", result.read_text())
        self.assertEqual((self.data / "icons/hicolor/128x128/apps/aiolm-local.png").read_bytes(),
                         state["replacement"]["icon"])
        self.assertEqual(result.stat().st_mode & 0o777, state["replacement"]["mode"])

    def test_exec_quotes_spaces_and_escapes_field_codes_and_shell_characters(self):
        self.assertEqual(desktop.exec_value('/tmp/a b%u$`"\\/aiolm'),
                         '"/tmp/a b%%u\\\\$\\\\`\\\\"\\\\\\\\/aiolm"')

    def test_path_newlines_cannot_inject_desktop_fields(self):
        entry = desktop.register(self.root / "app\nHidden=true", self.icon, self.data)
        self.assertNotIn("\nHidden=true", entry.read_text())
        self.assertIn("app\\nHidden=true", entry.read_text())

    @unittest.skipUnless(shutil.which("gio"), "GIO desktop launcher is unavailable")
    def test_gio_launches_literal_appimage_path_with_reserved_characters(self):
        executable = self.root / 'AioLM 100%u $ ` " \\ test.AppImage'
        result = self.root / "launched"
        executable.write_text("#!/usr/bin/python3\nfrom pathlib import Path\n"
                              f"Path({str(result)!r}).write_text('ok')\n")
        executable.chmod(0o755)
        entry = desktop.register(executable, self.icon, self.data)
        subprocess.run(["gio", "launch", str(entry)], check=True, capture_output=True, timeout=10)
        deadline = time.monotonic() + 5
        while not result.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(result.read_text(), "ok")


if __name__ == "__main__":
    unittest.main()
