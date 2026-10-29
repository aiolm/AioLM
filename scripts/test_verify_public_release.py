"""Regression checks for public metadata, download integrity and release isolation."""
from __future__ import annotations

import base64
from copy import deepcopy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

SPEC = importlib.util.spec_from_file_location("verify_public_release", Path(__file__).with_name("verify-public-release.py"))
VERIFY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFY)
VERSION = "1.2.3"
SHA = "a" * 40


def asset(name, data=b"payload\n", identity=1):
    return {"id": identity, "name": name, "state": "uploaded", "size": len(data),
            "digest": "sha256:" + hashlib.sha256(data).hexdigest(),
            "browser_download_url": f"https://github.com/aiolm/AioLM/releases/download/v{VERSION}/{name}"}


def release():
    return {"id": 41, "tag_name": "v" + VERSION, "draft": False, "prerelease": False,
            "published_at": "2026-01-01T00:00:00Z",
            "html_url": "https://github.com/aiolm/AioLM/releases/tag/v" + VERSION,
            "assets": [asset(name, identity=index) for index, name in enumerate(sorted(VERIFY.expected_names(VERSION)), 1)]}


class MetadataTests(unittest.TestCase):
    def test_published_stable_latest_and_exact_tag_commit_are_required(self):
        current = release()
        self.assertEqual(len(VERIFY.validate_release(current, current, VERSION, SHA, SHA)), 10)
        variants = [dict(current, draft=True), dict(current, prerelease=True),
                    dict(current, published_at=None), dict(current, tag_name="v1.2.2"),
                    dict(current, html_url="https://example.invalid/release")]
        for bad in variants:
            with self.subTest(bad=bad.get("tag_name")), self.assertRaises(RuntimeError):
                VERIFY.validate_release(bad, current, VERSION, SHA, SHA)
        with self.assertRaisesRegex(RuntimeError, "latest"):
            VERIFY.validate_release(current, dict(current, id=42), VERSION, SHA, SHA)
        with self.assertRaisesRegex(RuntimeError, "expected commit"):
            VERIFY.validate_release(current, current, VERSION, SHA, "b" * 40)

    def test_names_ids_sizes_digests_and_public_urls_are_checked(self):
        good = release()["assets"]
        changes = [
            lambda values: values.pop(),
            lambda values: values.append(deepcopy(values[0])),
            lambda values: values[0].update(name="../install.sh"),
            lambda values: values[0].update(id=values[1]["id"]),
            lambda values: values[0].update(size=0),
            lambda values: values[0].update(size=True),
            lambda values: values[0].update(size=VERIFY.MAX_ASSET_BYTES + 1),
            lambda values: values[0].update(state="new"),
            lambda values: values[0].update(digest=None),
            lambda values: values[0].update(digest="sha256:" + "X" * 64),
            lambda values: values[0].update(browser_download_url="https://example.invalid/download"),
        ]
        for change in changes:
            values = deepcopy(good)
            change(values)
            with self.subTest(change=changes.index(change)), self.assertRaises(RuntimeError):
                VERIFY.validate_assets(values, VERSION)
        values = deepcopy(good)
        for value in values:
            value["size"] = VERIFY.MAX_ASSET_BYTES
        with self.assertRaisesRegex(RuntimeError, "total size"):
            VERIFY.validate_assets(values, VERSION)

    def test_only_stable_versions_and_full_commit_ids_are_accepted(self):
        for value in ("../1.2.3", "1.2.3-rc.1", "v1.2.3", "01.2.3", "1.2", "1.2.3\n"):
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                VERIFY.expected_names(value)
        for value in ("a" * 7, "A" * 40, "x" * 40, SHA + "\n"):
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                VERIFY.commit_sha(value)

    def test_tag_peeling_handles_lightweight_annotated_and_invalid_objects(self):
        self.assertEqual(VERIFY.tag_commit("v" + VERSION, lambda _: {"object": {"type": "commit", "sha": SHA}}), SHA)
        annotated = "b" * 40
        objects = {"git/ref/tags/v" + VERSION: {"object": {"type": "tag", "sha": annotated}},
                   "git/tags/" + annotated: {"object": {"type": "commit", "sha": SHA}}}
        self.assertEqual(VERIFY.tag_commit("v" + VERSION, objects.__getitem__), SHA)
        with self.assertRaisesRegex(RuntimeError, "Cyclic"):
            VERIFY.tag_commit("v" + VERSION, lambda _: {"object": {"type": "tag", "sha": annotated}})
        with self.assertRaisesRegex(RuntimeError, "commit"):
            VERIFY.tag_commit("v" + VERSION, lambda _: {"object": {"type": "tree", "sha": SHA}})


class Response(io.BytesIO):
    status = 200

    def __init__(self, data, *, url="https://release-assets.githubusercontent.com/example", length=None):
        super().__init__(data)
        self.url = url
        self.headers = {"Content-Length": str(len(data) if length is None else length)}

    def geturl(self):
        return self.url


class Opener:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = 0

    def open(self, request, timeout):
        self.calls += 1
        value = next(self.responses)
        if isinstance(value, BaseException):
            raise value
        return value


class DownloadTests(unittest.TestCase):
    def test_public_download_retries_transport_errors_then_checks_bytes(self):
        data = b"synthetic installer\n"
        opener = Opener([urllib.error.URLError("temporary transport failure"), Response(data)])
        with tempfile.TemporaryDirectory() as directory:
            result = VERIFY.download(asset("install.sh", data), Path(directory), opener=opener, pause=lambda _: None)
            self.assertEqual((Path(directory) / "install.sh").read_bytes(), data)
            self.assertEqual(result["sha256"], hashlib.sha256(data).hexdigest())
            self.assertFalse((Path(directory) / "install.sh.part").exists())
        self.assertEqual(opener.calls, 2)

    def test_size_hash_and_redirect_mismatches_do_not_leave_downloads(self):
        good = b"installer\n"
        responses = [Response(b"wrongbyte\n", length=len(good)),
                     Response(good + b"extra", length=len(good)),
                     Response(good, url="http://github.com/example"),
                     Response(good, url="https://github.com.evil.invalid/example"),
                     Response(good, length=1)]
        for response in responses:
            with self.subTest(url=response.url), tempfile.TemporaryDirectory() as directory:
                opener = Opener([response])
                with self.assertRaises(RuntimeError):
                    VERIFY.download(asset("install.sh", good), Path(directory), opener=opener, pause=lambda _: None)
                self.assertEqual(list(Path(directory).iterdir()), [])
                self.assertEqual(opener.calls, 1)

    def test_unsafe_names_and_existing_destinations_are_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(RuntimeError, "Unsafe"):
                VERIFY.download(asset("../install.sh"), root)
            existing = root / "install.sh"
            existing.write_bytes(b"preserved")
            with self.assertRaisesRegex(RuntimeError, "already exists"):
                VERIFY.download(asset("install.sh"), root)
            self.assertEqual(existing.read_bytes(), b"preserved")

    def test_only_documented_github_release_hosts_and_https_are_accepted(self):
        for url in ("https://github.com/path", "https://objects.githubusercontent.com/path?signature=public",
                    "https://release-assets.githubusercontent.com/path"):
            VERIFY.trusted_url(url)
        for url in ("file:///tmp/asset", "http://github.com/path", "https://user:pass@github.com/path",
                    "https://github.com:8443/path", "https://evil.githubusercontent.com/path"):
            with self.subTest(url=url), self.assertRaises(RuntimeError):
                VERIFY.trusted_url(url)


class ManifestTests(unittest.TestCase):
    def test_exact_nine_payload_hashes_exclude_the_manifest(self):
        names = sorted(VERIFY.expected_names(VERSION) - {"checksums.txt"})
        text = "".join("a" * 64 + "  " + name + "\n" for name in names)
        self.assertEqual(set(VERIFY.checksum_records(text.encode(), VERSION)), set(names))
        variants = [text.replace("\n", "\r\n"), text.rstrip("\n"), text + text.splitlines()[0] + "\n",
                    text.replace(names[0], "../install.sh"), text.replace("a" * 64, "invalid", 1),
                    text.replace(names[0], "checksums.txt"), text + "\n"]
        for raw in variants:
            with self.subTest(raw=raw[:80]), self.assertRaises(RuntimeError):
                VERIFY.checksum_records(raw.encode(), VERSION)

    def test_manifest_hashes_match_downloads_and_posix_scripts_keep_lf(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            records = []
            lines = []
            for index, name in enumerate(sorted(VERIFY.expected_names(VERSION) - {"checksums.txt"}), 1):
                data = (name + "\n").encode()
                (root / name).write_bytes(data)
                digest = hashlib.sha256(data).hexdigest()
                records.append({"name": name, "sha256": digest})
                lines.append(digest + "  " + name + "\n")
            manifest = "".join(lines).encode()
            (root / "checksums.txt").write_bytes(manifest)
            records.append({"name": "checksums.txt", "sha256": hashlib.sha256(manifest).hexdigest()})
            self.assertEqual(VERIFY.verify_checksums(root, records, VERSION)["matched"], 9)
            broken = deepcopy(records)
            broken[0]["sha256"] = "0" * 64
            with self.assertRaisesRegex(RuntimeError, "mismatch"):
                VERIFY.verify_checksums(root, broken, VERSION)
            (root / "install.sh").write_bytes(b"bad\r\n")
            with self.assertRaisesRegex(RuntimeError, "line endings"):
                VERIFY.verify_checksums(root, records, VERSION)


def synthetic_runtime():
    strings = b"\0.shstrtab\0.digest_md5\0"
    digest_at = 64 + len(strings)
    body = strings + bytes(range(16)) + b"runtime code"
    shoff = 64 + len(body)
    header = bytearray(64)
    header[:6] = b"\x7fELF\x02\x01"
    header[8:11] = b"AI\x02"
    struct.pack_into("<H", header, 18, 62)
    struct.pack_into("<Q", header, 0x28, shoff)
    struct.pack_into("<HHH", header, 0x3A, 64, 3, 1)

    def section(name, offset, size):
        result = bytearray(64)
        struct.pack_into("<I", result, 0, name)
        struct.pack_into("<QQ", result, 0x18, offset, size)
        return bytes(result)

    runtime = bytes(header) + body + bytes(64) + section(1, 64, len(strings)) + section(11, digest_at, 16)
    return runtime + b"squashfs payload", digest_at, shoff


class RuntimeAndIsolationTests(unittest.TestCase):
    def test_deb_version_and_architecture_fail_before_extraction(self):
        for field, bad_value in (("Version", "1.2.2"), ("Architecture", "arm64"), ("Package", "other-package")):
            calls = []

            def runner(argv):
                calls.append(argv)
                self.assertEqual(argv[:2], ["dpkg-deb", "-f"])
                return bad_value if argv[-1] == field else {"Version": VERSION, "Architecture": "amd64", "Package": "aio-lm"}[argv[-1]]

            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory, patch.object(VERIFY, "command", side_effect=runner):
                with self.assertRaisesRegex(RuntimeError, "DEB version/package/architecture"):
                    VERIFY.verify_deb(Path(directory), VERSION, Path(directory))
                self.assertTrue(all("--extract" not in call for call in calls))

    def test_only_the_md5_image_digest_is_normalized(self):
        image, digest_at, _ = synthetic_runtime()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "installer.AppImage"
            path.write_bytes(image)
            prefix, result = VERIFY.normalized_appimage_runtime(path)
            self.assertEqual(prefix[digest_at:digest_at + 16], bytes(16))
            self.assertEqual(prefix[:digest_at], image[:digest_at])
            self.assertEqual(prefix[digest_at + 16:], image[digest_at + 16:len(prefix)])
            self.assertEqual(result["normalized_bytes"], 16)

    def test_invalid_runtime_magic_section_bounds_and_digest_are_rejected(self):
        image, _, shoff = synthetic_runtime()
        variants = []
        bad = bytearray(image)
        bad[8] = 0
        variants.append(bad)
        bad = bytearray(image)
        struct.pack_into("<Q", bad, 0x28, VERIFY.MAX_RUNTIME_BYTES)
        variants.append(bad)
        bad = bytearray(image)
        struct.pack_into("<Q", bad, shoff + 128 + 0x20, 17)
        variants.append(bad)
        for data in variants:
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "installer.AppImage"
                path.write_bytes(data)
                with self.assertRaises(RuntimeError):
                    VERIFY.normalized_appimage_runtime(path)
        self.assertEqual(VERIFY.runtime_pin("RUNTIME_SHA256=" + "c" * 64 + "\n"), "c" * 64)
        with self.assertRaises(RuntimeError):
            VERIFY.runtime_pin("RUNTIME_SHA256=" + "c" * 64 + "\nRUNTIME_SHA256=" + "d" * 64 + "\n")

    def test_verification_sources_must_match_the_exact_release_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "source.mjs").write_bytes(b"export const value = 1;\n")
            fetch = lambda _: {"encoding": "base64", "content": base64.b64encode(b"export const value = 2;\n").decode()}
            with self.assertRaisesRegex(RuntimeError, "differs"):
                VERIFY.verified_source("source.mjs", SHA, root, fetch)

    @unittest.skipUnless(os.name == "posix" and os.uname().machine in ("x86_64", "amd64"), "Linux CLI isolation check")
    def test_cli_smoke_receives_no_inherited_credentials_or_personal_home(self):
        captured = {}

        def runner(argv, *, timeout, env):
            captured.update(env)
            self.assertNotIn("GH_TOKEN", env)
            self.assertNotIn("AWS_SECRET_ACCESS_KEY", env)
            self.assertNotIn("AIOLM_HOME", env)
            self.assertTrue(Path(env["HOME"]).is_dir())
            self.assertNotEqual(env["HOME"], os.environ.get("HOME"))
            return VERIFY.CLI_SUCCESS + " synthetic smoke\n"

        with tempfile.TemporaryDirectory() as directory, patch.object(VERIFY, "verified_source", return_value={"path": "smoke"}), \
                patch.object(VERIFY, "command", side_effect=runner), patch.dict(os.environ, {"GH_TOKEN": "synthetic", "AWS_SECRET_ACCESS_KEY": "synthetic"}):
            result = VERIFY.cli_smoke(Path(directory) / "cli", Path(directory), SHA, Path(directory), "node")
            self.assertTrue(result["passed"])
            self.assertFalse(Path(captured["HOME"]).exists(), "Disposable CLI home must be removed")

    def test_failed_public_verification_keeps_a_structured_report(self):
        current = release()
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(VERIFY.shutil, "which", return_value="synthetic-tool"), \
                patch.object(VERIFY, "command", return_value="v22.0.0\n"), \
                patch.object(VERIFY, "api", return_value=current), \
                patch.object(VERIFY, "tag_commit", return_value=SHA), \
                patch.object(VERIFY, "download", side_effect=RuntimeError("synthetic bad checksum")):
            output = Path(directory) / "results"
            with self.assertRaisesRegex(RuntimeError, "bad checksum"):
                VERIFY.main(["--version", VERSION, "--expected-sha", SHA, "--output-dir", str(output)])
            report = json.loads((output / "verification-report.json").read_text())
            self.assertEqual(report["status"], "failed")
            self.assertEqual(report["expected_sha"], SHA)
            self.assertIn("synthetic bad checksum", report["error"])
            self.assertIn("Public release verification: failed", (output / "summary.md").read_text())


if __name__ == "__main__":
    unittest.main()
