#!/usr/bin/env python3
"""Exercise installed GUI data preservation and FUSE on disposable hosted Linux."""
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.request


def run(args, **kwargs):
    kwargs.setdefault("timeout", 180)
    return subprocess.run(args, check=True, **kwargs)


def desktop(application, evidence, marker=None):
    """Use WebKitGTK's real automation endpoint, without a frontend mock."""
    driver = subprocess.Popen(["WebKitWebDriver", "--port=4444"], stdout=subprocess.DEVNULL)
    session = None

    def request(method, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request("http://127.0.0.1:4444" + path, data=data,
                                     headers={"Content-Type": "application/json"}, method=method)
        with urllib.request.urlopen(req, timeout=45) as response:
            return json.load(response)["value"]

    def execute(script, *args):
        return request("POST", f"/session/{session}/execute/sync", {"script": script, "args": args})

    try:
        for _ in range(100):
            try:
                request("GET", "/status")
                break
            except OSError:
                if driver.poll() is not None:
                    raise RuntimeError("WebKitWebDriver exited")
                time.sleep(.1)
        created = request("POST", "/session", {"capabilities": {"alwaysMatch": {
            "webkitgtk:browserOptions": {"binary": str(application), "args": []}
        }}})
        session = created["sessionId"]
        for _ in range(100):
            text = execute("return document.body.innerText")
            if len(text.strip()) > 100:
                break
            time.sleep(.1)
        assert len(text.strip()) > 100, "blank desktop window"
        assert execute("return document.title").startswith("AioLM")
        assert execute("return location.href") == "tauri://localhost"
        assert not execute("return !!document.querySelector('vite-error-overlay')")
        if marker == "seed":
            execute("localStorage.setItem('aiolm-linux-upgrade-marker','synthetic-preserved')")
        elif marker == "verify":
            assert execute("return localStorage.getItem('aiolm-linux-upgrade-marker')") == "synthetic-preserved"
        evidence.write_bytes(base64.b64decode(request("GET", f"/session/{session}/screenshot")))
        # Use the application's actual close handler, including child cleanup.
        execute("window.__TAURI_INTERNALS__.invoke('plugin:window|close',{label:'main'})")
        return {"title": "AioLM", "nonblank": True, "nativeOrigin": True, "marker": marker}
    finally:
        if session:
            try:
                request("DELETE", f"/session/{session}")
            except (OSError, KeyError):
                pass
        driver.terminate()
        driver.wait(timeout=10)


def child(bundle, evidence):
    assert not Path("/usr/bin/aiolm").exists(), "refuse to replace an existing app"
    debs = list((bundle / "deb").glob("*.deb"))
    images = list((bundle / "appimage").glob("*.AppImage"))
    assert len(debs) == len(images) == 1
    deb, appimage = debs[0], images[0]
    result = {}
    # This is a package-manager upgrade fixture, not a claimed historic release.
    # Production binaries are unchanged; only the predecessor package version differs.
    with tempfile.TemporaryDirectory(prefix="aiolm-predecessor-") as directory:
        root = Path(directory)
        tree = root / "package"
        run(["dpkg-deb", "-R", str(deb), str(tree)], stdout=subprocess.DEVNULL)
        control = tree / "DEBIAN/control"
        lines = control.read_text().splitlines()
        version = next(line.split(":", 1)[1].strip() for line in lines if line.startswith("Version:"))
        control.write_text("\n".join("Version: " + version + "~acceptance0" if line.startswith("Version:") else line for line in lines) + "\n")
        predecessor = root / "predecessor.deb"
        run(["dpkg-deb", "--root-owner-group", "-b", str(tree), str(predecessor)], stdout=subprocess.DEVNULL)
        try:
            run(["sudo", "apt-get", "install", "-y", str(predecessor)])
            run(["/usr/bin/aiolm-cli", "config", "set", "ctx_size", "7777"], stdout=subprocess.DEVNULL)
            result["beforeUpgrade"] = desktop(Path("/usr/bin/aiolm"), evidence / "before-upgrade.png", "seed")
            run(["sudo", "apt-get", "install", "-y", str(deb)])
            config = json.loads(subprocess.check_output(["/usr/bin/aiolm-cli", "config", "get"]))
            assert config["ctx_size"] == 7777
            result["afterUpgrade"] = desktop(Path("/usr/bin/aiolm"), evidence / "after-upgrade.png", "verify")
            result["packageUpgrade"] = {"from": version + "~acceptance0", "to": version,
                                        "syntheticPredecessor": True, "configPreserved": True}
        finally:
            run(["sudo", "apt-get", "remove", "-y", "aio-lm"])
        assert not Path("/usr/bin/aiolm").exists()
        assert json.loads(Path(os.environ["AIOLM_HOME"], "config.json").read_text())["ctx_size"] == 7777
    assert Path("/dev/fuse").exists(), "runner has no FUSE device; FUSE acceptance is not complete"
    appimage.chmod(0o755)
    # A mounted AppImage must expose a fuse filesystem, not the extraction fallback.
    mount = subprocess.Popen([str(appimage), "--appimage-mount"], stdout=subprocess.PIPE, text=True)
    try:
        mountpoint = mount.stdout.readline().strip()
        assert mountpoint and Path(mountpoint).is_dir(), "AppImage did not mount"
        mounts = Path("/proc/self/mountinfo").read_text()
        assert any(mountpoint in line and "fuse" in line for line in mounts.splitlines())
        result["fuseMounted"] = True
        run(["node", "scripts/smoke-native-cli.mjs", str(Path(mountpoint, "usr/bin/aiolm-cli"))])
        result["appimageGui"] = desktop(appimage, evidence / "appimage-fuse.png")
    finally:
        mount.terminate()
        mount.wait(timeout=10)
    (evidence / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print("Installed GUI upgrade fixture preserved config/WebKit storage; FUSE AppImage GUI and CLI passed.")


def main():
    assert sys.platform == "linux"
    assert os.environ.get("GITHUB_ACTIONS") == "true"
    assert os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted", "requires disposable GitHub runner"
    bundle = Path(".codex-target/release/bundle").resolve()
    evidence = Path("tmp/linux-package-acceptance").resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    if len(sys.argv) > 1 and sys.argv[1] == "child":
        child(bundle, evidence)
        return
    with tempfile.TemporaryDirectory(prefix="aiolm-desktop-", dir=os.environ["RUNNER_TEMP"]) as directory:
        env = {k: v for k, v in os.environ.items() if not k.startswith(("AIOLM_", "LLAMA_BOARD_"))
               and k not in ("DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "APPIMAGE_EXTRACT_AND_RUN")}
        for key, sub in {"HOME": "home", "USERPROFILE": "home", "APPDATA": "roaming", "LOCALAPPDATA": "local",
                         "XDG_CONFIG_HOME": "config", "XDG_DATA_HOME": "data", "XDG_CACHE_HOME": "cache",
                         "XDG_RUNTIME_DIR": "run", "AIOLM_HOME": "aiolm"}.items():
            path = Path(directory, sub)
            path.mkdir(mode=0o700, exist_ok=True)
            env[key] = str(path)
        env.update(GDK_BACKEND="x11", TAURI_WEBVIEW_AUTOMATION="true", WEBKIT_DISABLE_DMABUF_RENDERER="1")
        run(["xvfb-run", "-a", "-s", "-screen 0 1280x900x24", "dbus-run-session", "--",
             sys.executable, __file__, "child"], env=env, timeout=600)


if __name__ == "__main__":
    main()
