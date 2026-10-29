#!/usr/bin/env python3
"""Verify a published AioLM release without installing packages or changing GitHub."""
from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

REPOSITORY = "aiolm/AioLM"
REPO_ROOT = Path(__file__).resolve().parent.parent
MAX_ASSET_BYTES = 2 * 1024**3
MAX_TOTAL_BYTES = 4 * 1024**3
MAX_RUNTIME_BYTES = 32 * 1024**2
CLI_SUCCESS = "Native CLI smoke passed:"
LIMITS = [
    "Package installation, updater installation and desktop UI acceptance are separate checks.",
    "Dedicated engine/device inference and model response quality are not certified here.",
    "This check does not resolve SmolVLM F09 or complete overall Linux/original update-UI validation.",
]


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def release_version(value):
    require(isinstance(value, str) and re.fullmatch(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)", value),
            "Version must be a stable major.minor.patch value")
    return value


def commit_sha(value):
    require(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{40}", value),
            "Expected a full lowercase commit SHA")
    return value


def expected_names(version):
    release_version(version)
    return {
        f"AioLM_{version}_x64-setup.exe", f"AioLM_{version}_x64_en-US.msi",
        f"AioLM_{version}_amd64.deb", f"AioLM_{version}_amd64.AppImage",
        f"AioLM_{version}_aarch64.dmg", f"AioLM_{version}_x64.dmg",
        "install.ps1", "install.sh", "register-linux-desktop.py", "checksums.txt",
    }


def command(argv, *, timeout=120, env=None):
    completed = subprocess.run([str(value) for value in argv], capture_output=True,
                               text=True, timeout=timeout, check=False, env=env)
    require(completed.returncode == 0,
            f"Command failed ({completed.returncode}): {Path(str(argv[0])).name}: {completed.stderr.strip()}")
    return completed.stdout


def api(endpoint):
    # gh uses its normal configured identity; no credential is copied into a
    # URL, downloaded script, command argument or verification report.
    return json.loads(command(["gh", "api", "--method", "GET", f"repos/{REPOSITORY}/{endpoint}"]))


def tag_commit(tag, fetch=api):
    obj = fetch(f"git/ref/tags/{tag}")["object"]
    seen = set()
    for _ in range(5):
        sha = commit_sha(obj.get("sha"))
        require(sha not in seen, "Cyclic annotated tag")
        seen.add(sha)
        if obj.get("type") == "commit":
            return sha
        require(obj.get("type") == "tag", "Tag must resolve to a commit")
        obj = fetch(f"git/tags/{sha}")["object"]
    raise RuntimeError("Too many nested annotated tags")


def trusted_url(url):
    parsed = urllib.parse.urlsplit(url)
    require(parsed.scheme == "https" and not parsed.username and not parsed.password
            and parsed.port in (None, 443) and not parsed.fragment,
            "Asset URL must use credential-free HTTPS")
    require(parsed.hostname == "github.com" or parsed.hostname == "release-assets.githubusercontent.com"
            or parsed.hostname == "objects.githubusercontent.com",
            "Asset redirect is outside the GitHub release download hosts")


class CheckedRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        trusted_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def validate_assets(assets, version):
    names = expected_names(version)
    require(isinstance(assets, list) and len(assets) == len(names), "Expected exactly ten release assets")
    require(all(isinstance(asset, dict) for asset in assets), "Invalid release asset metadata")
    actual_names = [asset.get("name") for asset in assets]
    require(all(isinstance(name, str) for name in actual_names) and set(actual_names) == names
            and len(set(actual_names)) == len(actual_names), "Missing, duplicate or unexpected release asset names")
    ids = [asset.get("id") for asset in assets]
    require(all(type(value) is int and value > 0 for value in ids) and len(set(ids)) == len(ids),
            "Missing or duplicate release asset IDs")
    for asset in assets:
        size = asset.get("size")
        require(type(size) is int and 0 < size <= MAX_ASSET_BYTES and asset.get("state") == "uploaded",
                f"Empty, oversized or incomplete asset: {asset['name']}")
        require(isinstance(asset.get("digest"), str)
                and re.fullmatch(r"sha256:[0-9a-f]{64}", asset["digest"]),
                f"Missing SHA-256 API digest: {asset['name']}")
        expected = f"https://github.com/{REPOSITORY}/releases/download/v{version}/{asset['name']}"
        require(asset.get("browser_download_url") == expected, f"Unexpected asset URL: {asset['name']}")
        trusted_url(expected)
    require(sum(asset["size"] for asset in assets) <= MAX_TOTAL_BYTES, "Release download exceeds the total size limit")
    return assets


def validate_release(release, latest, version, expected_sha, resolved_sha):
    tag = f"v{release_version(version)}"
    require(release.get("tag_name") == tag and release.get("draft") is False
            and release.get("prerelease") is False and bool(release.get("published_at")),
            "Release is not published stable/non-draft")
    require(type(release.get("id")) is int and release["id"] > 0
            and latest.get("id") == release["id"] and latest.get("tag_name") == tag,
            "Release is not the current latest release")
    require(release.get("html_url") == f"https://github.com/{REPOSITORY}/releases/tag/{tag}",
            "Unexpected public release URL")
    require(commit_sha(resolved_sha) == commit_sha(expected_sha), "Release tag source does not match the expected commit")
    return validate_assets(release.get("assets"), version)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(asset, directory, *, opener=None, attempts=3, pause=time.sleep):
    # Metadata must be validated before this function is called. Check the
    # basename again so this helper cannot accidentally write outside its run.
    name = asset["name"]
    require(re.fullmatch(r"[A-Za-z0-9_.-]+", name) and name not in (".", ".."), "Unsafe asset filename")
    require(type(asset.get("size")) is int and 0 < asset["size"] <= MAX_ASSET_BYTES, "Invalid download size")
    trusted_url(asset["browser_download_url"])
    require(1 <= attempts <= 3, "Download attempts must be bounded")
    opener = opener or urllib.request.build_opener(CheckedRedirect())
    partial, final = directory / (name + ".part"), directory / name
    require(not partial.exists() and not final.exists(), "Download destination already exists")
    for attempt in range(attempts):
        started = time.monotonic()
        try:
            request = urllib.request.Request(asset["browser_download_url"], headers={"User-Agent": "AioLM-release-verifier"})
            with opener.open(request, timeout=60) as response, partial.open("xb") as stream:
                trusted_url(response.geturl())
                require(response.status == 200, "Unexpected asset response status")
                length = response.headers.get("Content-Length")
                require(length is None or int(length) == asset["size"], "Asset Content-Length mismatch")
                count = 0
                while chunk := response.read(1024 * 1024):
                    count += len(chunk)
                    require(count <= asset["size"], "Asset exceeded its declared download size")
                    require(time.monotonic() - started <= 600, "Asset download exceeded ten minutes")
                    stream.write(chunk)
            require(count == asset["size"], f"Asset size mismatch: {name}")
            digest = sha256(partial)
            require(asset.get("digest") == "sha256:" + digest, f"GitHub API SHA-256 mismatch: {name}")
            partial.rename(final)
            return {"name": name, "id": asset["id"], "bytes": count, "sha256": digest, "api_digest_verified": True}
        except (OSError, urllib.error.URLError) as error:
            partial.unlink(missing_ok=True)
            retryable = not isinstance(error, urllib.error.HTTPError) or error.code == 429 or error.code >= 500
            if attempt + 1 == attempts or not retryable:
                raise
            pause(2 ** attempt)
        except Exception:
            partial.unlink(missing_ok=True)
            raise
    raise RuntimeError("Asset download did not complete")


def checksum_records(raw, version):
    require(raw.endswith(b"\n") and b"\r" not in raw, "checksums.txt must use LF and end with LF")
    try:
        lines = raw.decode("ascii").removesuffix("\n").split("\n")
    except UnicodeDecodeError as error:
        raise RuntimeError("checksums.txt must be ASCII") from error
    records = {}
    for line in lines:
        match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9_.-]+)", line)
        require(match is not None, "Invalid checksums.txt record")
        digest, name = match.groups()
        require(name not in records, "Duplicate checksums.txt entry")
        records[name] = digest
    require(len(records) == 9 and set(records) == expected_names(version) - {"checksums.txt"},
            "checksums.txt must cover exactly the nine payloads")
    return records


def verify_checksums(directory, assets, version):
    records = checksum_records((directory / "checksums.txt").read_bytes(), version)
    actual = {asset["name"]: asset["sha256"] for asset in assets}
    require(len(actual) == len(assets) == 10, "Duplicate downloaded asset record")
    for name, digest in records.items():
        require(actual.get(name) == digest, f"checksums.txt SHA-256 mismatch: {name}")
    for name in ("install.sh", "register-linux-desktop.py"):
        content = (directory / name).read_bytes()
        require(content and content.endswith(b"\n") and b"\r" not in content,
                f"Noncanonical script line endings: {name}")
    return {"entries": 9, "matched": 9, "line_endings": "LF"}


def verified_source(path, expected_sha, repo_root, fetch=api):
    source = fetch(f"contents/{path}?ref={expected_sha}")
    require(source.get("encoding") == "base64", "Unexpected GitHub source encoding")
    remote = base64.b64decode("".join(source["content"].splitlines()), validate=True)
    require((repo_root / path).read_bytes() == remote, f"Local verification source differs from the release commit: {path}")
    return {"path": path, "source_commit": expected_sha, "sha256": hashlib.sha256(remote).hexdigest()}


def runtime_pin(text):
    matches = re.findall(r"^RUNTIME_SHA256=([0-9a-f]{64})$", text, re.MULTILINE)
    require(len(matches) == 1, "Expected exactly one valid AppImage runtime SHA-256 pin")
    return matches[0]


def normalized_appimage_runtime(appimage):
    # Bounded ELF prefix only: the SquashFS payload is never executed or read
    # into memory. The product guard is also invoked after this extraction.
    with appimage.open("rb") as stream:
        header = stream.read(64)
        require(len(header) == 64 and header[:6] == b"\x7fELF\x02\x01"
                and int.from_bytes(header[18:20], "little") == 62, "Expected an x86-64 ELF64 AppImage runtime")
        require(header[8:11] == b"AI\x02", "Missing AppImage type2 magic")
        shoff = int.from_bytes(header[0x28:0x30], "little")
        shentsize = int.from_bytes(header[0x3a:0x3c], "little")
        shnum = int.from_bytes(header[0x3c:0x3e], "little")
        shstrndx = int.from_bytes(header[0x3e:0x40], "little")
        end = shoff + shentsize * shnum
        require(shoff >= 64 and shentsize == 64 and shnum > 0 and shstrndx < shnum,
                "Invalid runtime ELF section layout")
        require(64 < end < appimage.stat().st_size and end <= MAX_RUNTIME_BYTES, "AppImage runtime prefix exceeds its bounds")
        stream.seek(0)
        prefix = bytearray(stream.read(end))
    require(len(prefix) == end, "Truncated AppImage runtime prefix")

    def section(index):
        at = shoff + index * shentsize
        return (int.from_bytes(prefix[at:at + 4], "little"),
                int.from_bytes(prefix[at + 0x18:at + 0x20], "little"),
                int.from_bytes(prefix[at + 0x20:at + 0x28], "little"))

    _, names_at, names_size = section(shstrndx)
    require(64 <= names_at < shoff and names_at + names_size <= shoff, "Invalid runtime section string table")
    strings = prefix[names_at:names_at + names_size]
    digests = []
    for index in range(shnum):
        name, offset, size = section(index)
        require(name < len(strings), "Invalid runtime section name offset")
        terminator = strings.find(b"\0", name)
        require(terminator >= name, "Unterminated runtime section name")
        if strings[name:terminator] == b".digest_md5":
            digests.append((offset, size))
    require(len(digests) == 1, "Expected exactly one runtime .digest_md5 section")
    offset, size = digests[0]
    require(size == 16 and 64 <= offset and offset + size <= shoff, "Unexpected runtime .digest_md5 bounds")
    prefix[offset:offset + size] = bytes(size)
    return bytes(prefix), {"prefix_bytes": end, "normalized_section": ".digest_md5", "normalized_bytes": size}


def verify_appimage(directory, version, repo_root, expected_sha, output, node):
    sources = [verified_source(f"scripts/appimage-runtime/{name}", expected_sha, repo_root)
               for name in ("runtime.mjs", "pins.conf")]
    pin = runtime_pin((repo_root / "scripts/appimage-runtime/pins.conf").read_text(encoding="utf-8"))
    image = directory / f"AioLM_{version}_amd64.AppImage"
    prefix, result = normalized_appimage_runtime(image)
    require(hashlib.sha256(prefix).hexdigest() == pin, "Downloaded AppImage runtime differs from the released pin")
    candidate = output / "embedded-runtime.normalized"
    candidate.write_bytes(prefix)
    # Reuse the shipping implementation as the final authority rather than
    # accepting this verifier's ELF parser as a substitute for product guards.
    driver = output / "check-runtime.mjs"
    module_url = (repo_root / "scripts/appimage-runtime/runtime.mjs").as_uri()
    driver.write_text("import { readVerifiedRuntime, verifyEmbeddedRuntime } from " + json.dumps(module_url) + ";\n"
                      "const [image, candidate] = process.argv.slice(2);\n"
                      "verifyEmbeddedRuntime(image, readVerifiedRuntime(candidate));\n"
                      "console.log('Pinned AppImage runtime verified');\n", encoding="utf-8")
    stdout = command([node, driver, image, candidate])
    require("Pinned AppImage runtime verified" in stdout, "Product AppImage guards did not finish")
    result.update({"passed": True, "sha256": pin, "sources": sources, "appimage_executed": False,
                   "product_guards": ["readVerifiedRuntime", "verifyEmbeddedRuntime"]})
    return result


def verify_deb(directory, version, output):
    package = directory / f"AioLM_{version}_amd64.deb"
    fields = {name: command(["dpkg-deb", "-f", package, name]).strip()
              for name in ("Package", "Version", "Architecture")}
    require(fields == {"Package": "aio-lm", "Version": version, "Architecture": "amd64"}, "Unexpected DEB version/package/architecture")
    extraction = output / "deb-extracted"
    extraction.mkdir()
    command(["dpkg-deb", "--extract", package, extraction])
    executable = extraction / "usr/bin/aiolm-cli"
    require(executable.is_file() and not executable.is_symlink() and os.access(executable, os.X_OK), "DEB is missing its executable CLI")
    with executable.open("rb") as stream:
        header = stream.read(64)
    require(len(header) == 64 and header[:6] == b"\x7fELF\x02\x01"
            and int.from_bytes(header[18:20], "little") == 62, "DEB CLI is not x86-64 ELF64")
    return executable, {"control": fields, "cli_elf": "ELF64 x86-64", "cli_sha256": sha256(executable),
                        "installation": "not performed; extraction only"}


def cli_smoke(executable, repo_root, expected_sha, output, node):
    require(sys.platform == "linux" and os.uname().machine in ("x86_64", "amd64"), "CLI smoke requires a Linux x86-64 host")
    source = verified_source("scripts/smoke-native-cli.mjs", expected_sha, repo_root)
    # A deliberately small environment keeps the release binary away from
    # inherited API credentials and personal settings. The existing smoke
    # creates another disposable home for every migration source it exercises.
    with tempfile.TemporaryDirectory(prefix="aiolm-public-cli-") as temporary:
        home = Path(temporary) / "home"
        home.mkdir()
        env = {"PATH": os.environ.get("PATH", os.defpath), "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
               "TZ": "UTC", "HOME": str(home), "USERPROFILE": str(home), "TMPDIR": temporary,
               "XDG_CONFIG_HOME": str(home / "config"), "XDG_DATA_HOME": str(home / "data"),
               "XDG_CACHE_HOME": str(home / "cache")}
        stdout = command([node, repo_root / "scripts/smoke-native-cli.mjs", executable], timeout=180, env=env)
    (output / "cli-smoke.stdout.log").write_text(stdout, encoding="utf-8")
    require(CLI_SUCCESS in stdout, "Native CLI smoke did not report success")
    return {"passed": True, "source": source, "home": "disposable", "environment": "credential-free allowlist",
            "package_installed": False, "model_or_engine_inference": False}


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def snapshot(release):
    return {"id": release["id"], "tag_name": release["tag_name"], "draft": release["draft"],
            "prerelease": release["prerelease"], "assets": sorted(
                [{key: asset[key] for key in ("id", "name", "size", "state", "digest", "browser_download_url")}
                 for asset in release["assets"]], key=lambda item: item["name"])}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--expected-sha", required=True)
    parser.add_argument("--output-dir", type=Path, required=True, help="A new or empty directory; existing results are never overwritten")
    parser.add_argument("--repo-root", type=Path, default=REPO_ROOT)
    parser.add_argument("--node", default="node")
    parser.add_argument("--execute-cli", action="store_true", help="Run the verified DEB CLI with a disposable home; never install the package")
    args = parser.parse_args(argv)
    version, expected_sha = release_version(args.version), commit_sha(args.expected_sha)
    output = args.output_dir
    require(not output.is_symlink(), "Output directory must not be a symlink")
    output.mkdir(parents=True, exist_ok=True)
    require(not any(output.iterdir()), "Output directory must be empty")
    output, repo_root = output.resolve(), args.repo_root.resolve()
    report = {"status": "running", "repository": REPOSITORY, "version": version,
              "expected_sha": expected_sha, "started_at": datetime.now(timezone.utc).isoformat(), "limits": LIMITS}
    try:
        require(shutil.which("gh") and shutil.which("dpkg-deb") and shutil.which(args.node), "Required tools: gh, dpkg-deb, Node")
        report["node_version"] = command([args.node, "--version"]).strip()
        release = api(f"releases/tags/v{version}")
        latest = api("releases/latest")
        resolved_sha = tag_commit(f"v{version}")
        assets = validate_release(release, latest, version, expected_sha, resolved_sha)
        report["release"] = {"url": release["html_url"], "id": release["id"], "tag_sha": resolved_sha,
                             "stable": True, "draft": False, "latest": True}
        write_json(output / "release.json", release)
        require(shutil.disk_usage(output).free > sum(asset["size"] for asset in assets) * 4 + 512 * 1024**2,
                "Insufficient free space for public downloads and DEB extraction")
        directory = output / "assets"
        directory.mkdir()
        report["assets"] = []
        for asset in sorted(assets, key=lambda item: (item["name"] != "checksums.txt", item["name"])):
            result = download(asset, directory)
            report["assets"].append(result)
            print(f"Verified download: {result['name']} ({result['bytes']} bytes)", flush=True)
        report["checksums"] = verify_checksums(directory, report["assets"], version)
        report["appimage_runtime"] = verify_appimage(directory, version, repo_root, expected_sha, output, args.node)
        executable, report["deb"] = verify_deb(directory, version, output)
        report["cli"] = cli_smoke(executable, repo_root, expected_sha, output, args.node) if args.execute_cli else {"executed": False, "reason": "--execute-cli was not requested"}
        after = api(f"releases/tags/v{version}")
        validate_release(after, api("releases/latest"), version, expected_sha, tag_commit(f"v{version}"))
        require(snapshot(after) == snapshot(release), "Public release assets changed during verification")
        report["status"] = "passed"
    except Exception as error:
        report["status"] = "failed"
        report["error"] = str(error)
        raise
    finally:
        report["finished_at"] = datetime.now(timezone.utc).isoformat()
        write_json(output / "verification-report.json", report)
        summary = [f"## Public release verification: {report['status']}", "",
                   f"- Version: v{version}", f"- Source commit: {expected_sha}"]
        if "release" in report:
            summary.append(f"- Public release: {report['release']['url']}")
        if report["status"] == "passed":
            summary += ["- Ten assets downloaded; all nine checksums and all ten API digests matched.",
                        "- Stable, non-draft, latest; DEB version/amd64 and pinned AppImage runtime verified.",
                        "- Clean-home CLI smoke: " + ("passed" if args.execute_cli else "not requested")]
        summary += ["", *LIMITS]
        (output / "summary.md").write_text("\n".join(summary) + "\n", encoding="utf-8")
    print(f"Public release verification passed: {release['html_url']}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"Public release verification failed: {error}", file=sys.stderr)
        sys.exit(1)
