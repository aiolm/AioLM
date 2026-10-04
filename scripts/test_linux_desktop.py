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
