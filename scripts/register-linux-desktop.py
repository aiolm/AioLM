#!/usr/bin/env python3
"""Register a development binary or a verified AppImage with the Linux desktop."""

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

MARKER = "X-AioLM-Managed=true"


def desktop_value(value):
    return str(value).replace("\\", "\\\\").replace("\n", "\\n").replace("\r", "\\r")


def exec_value(path):
    # Desktop Exec has its own quoting rules; it is not a shell command.
    value = str(path).replace("%", "%%")
    for character in ("\\", '"', "`", "$"):
        value = value.replace(character, "\\" + character)
    return desktop_value('"' + value + '"')


def register(executable, icon, data_home, development=False):
    entry = data_home / "applications/aiolm.desktop"
    if entry.exists() and MARKER not in entry.read_text():
        raise RuntimeError(f"Refusing to replace an unmanaged desktop entry: {entry}")
    if development and entry.exists() and "NoDisplay=false" in entry.read_text().splitlines():
        # The installed AppImage already supplies the same window identity.
        # Keep its menu launcher when working on a development checkout.
        return entry
    target_icon = data_home / "icons/hicolor/128x128/apps/aiolm-local.png"
    target_icon.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(icon, target_icon)
    entry.parent.mkdir(parents=True, exist_ok=True)
    entry.write_text("\n".join([
        "[Desktop Entry]", "Type=Application",
        "Name=AioLM (Development)" if development else "Name=AioLM",
        # GIO checks argv[0] before expanding %% to a literal percent sign.
        # A fixed launcher also handles AppImages stored in paths containing %.
        f"Exec=/usr/bin/env -- {exec_value(executable)}", f"Icon={desktop_value(target_icon)}",
        "StartupWMClass=aiolm", "Terminal=false", "Categories=Development;",
        f"NoDisplay={'true' if development else 'false'}", MARKER, "",
    ]))
    return entry


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dev", action="store_true", help="register this checkout's development binary")
    mode.add_argument("--appimage", type=Path, help="register an already verified AppImage at a stable path")
    mode.add_argument("--remove", action="store_true", help="remove only this helper's local registration")
    args = parser.parse_args()
    if sys.platform != "linux":
        parser.error("desktop registration is Linux-only")
    data_home = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local/share")
    if not data_home.is_absolute():
        data_home = Path.home() / ".local/share"
    if args.remove:
        entry = data_home / "applications/aiolm.desktop"
        if entry.exists():
            if MARKER not in entry.read_text():
                raise RuntimeError(f"Refusing to remove an unmanaged desktop entry: {entry}")
            entry.unlink()
            (data_home / "icons/hicolor/128x128/apps/aiolm-local.png").unlink(missing_ok=True)
        return
    if args.dev:
        root = Path(__file__).resolve().parent.parent
        target = Path(os.environ.get("CARGO_TARGET_DIR") or root / ".codex-target")
        if not target.is_absolute():
            target = Path.cwd() / target
        entry = register(target / "debug/aiolm", root / "src-tauri/icons/128x128.png", data_home, True)
    else:
        executable = args.appimage.expanduser().resolve(strict=True)
        if not executable.is_file() or not os.access(executable, os.X_OK):
            parser.error("AppImage must be an executable file (chmod +x)")
        # Only run this on the verified package the user explicitly selected.
        with tempfile.TemporaryDirectory(prefix="aiolm-icon-") as temporary:
            icon = "usr/share/icons/hicolor/128x128/apps/aiolm.png"
            subprocess.run([str(executable), "--appimage-extract", icon], cwd=temporary,
                           check=True, stdout=subprocess.DEVNULL, timeout=60)
            entry = register(executable, Path(temporary) / "squashfs-root" / icon, data_home)
    print(f"Registered AioLM desktop icon: {entry}")


if __name__ == "__main__":
    main()
