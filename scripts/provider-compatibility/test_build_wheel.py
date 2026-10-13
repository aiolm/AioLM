import base64
import csv
import hashlib
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from build_wheel import build_wheel, patch_vllm

VLLM_SOURCE = '''class VLLMValidationError(ValueError):
    pass

class Connector:
    def load(self, allowed_local_media_path, filepath):
        if allowed_local_media_path is None:
            raise RuntimeError(
                "Cannot load local files without `--allowed-local-media-path`."
            )
        if not filepath.startswith(allowed_local_media_path):
            raise ValueError(
                f"The file path {filepath} must be a subpath "
                f"of `--allowed-local-media-path {allowed_local_media_path}`."
            )
        return filepath
'''


class CompatibilityWheelBuild(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "vllm-0.30.0+cpu-py3-none-any.whl"
        self.info = "vllm-0.30.0+cpu.dist-info"
        with zipfile.ZipFile(self.source, "w") as wheel:
            wheel.writestr("vllm/multimodal/media/connector.py", VLLM_SOURCE)
            wheel.writestr(self.info + "/METADATA", "Metadata-Version: 2.1\nName: vllm\nVersion: 0.30.0+cpu\n")
            wheel.writestr(self.info + "/RECORD", "")
            wheel.writestr(self.info + "/licenses/LICENSE", "Synthetic license fixture; preserve these bytes.")
            executable = zipfile.ZipInfo("vllm/native-helper")
            executable.external_attr = 0o100755 << 16
            wheel.writestr(executable, b"synthetic native fixture")
        self.original = self.source.read_bytes()
        self.digest = hashlib.sha256(self.original).hexdigest()

    def build(self):
        return build_wheel(self.source, self.root, self.digest, "vllm")

    def test_preserves_source_license_executable_attributes_and_records_a_local_version(self):
        audit = self.build()
        self.assertEqual(self.source.read_bytes(), self.original)
        self.assertEqual(audit["local_version"], "0.30.0+cpu.aiolm.media1")
        with zipfile.ZipFile(self.root / audit["output_filename"]) as wheel:
            info = "vllm-0.30.0+cpu.aiolm.media1.dist-info"
            self.assertEqual(wheel.read(info + "/licenses/LICENSE"), b"Synthetic license fixture; preserve these bytes.")
            self.assertEqual(wheel.getinfo("vllm/native-helper").external_attr, 0o100755 << 16)
            self.assertIn(b"Version: 0.30.0+cpu.aiolm.media1\n", wheel.read(info + "/METADATA"))
            provenance = json.loads(wheel.read(info + "/aiolm_compatibility.json"))
            self.assertEqual(provenance["source_wheel_sha256"], self.digest)
            for name, digest, length in csv.reader(io.StringIO(wheel.read(info + "/RECORD").decode())):
                if name.endswith("/RECORD"):
                    self.assertEqual((digest, length), ("", ""))
                    continue
                data = wheel.read(name)
                self.assertEqual(int(length), len(data))
                self.assertEqual(digest, "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip("="))

    def test_validation_correction_retains_the_file_allowlist(self):
        namespace = {}
        exec(patch_vllm(VLLM_SOURCE), namespace)
        connector = namespace["Connector"]()
        error = namespace["VLLMValidationError"]
        with self.assertRaises(error):
            connector.load(None, "/outside/image.png")
        with self.assertRaises(error):
            connector.load("/allowed/", "/outside/image.png")
        self.assertEqual(connector.load("/allowed/", "/allowed/image.png"), "/allowed/image.png")
        with self.assertRaises(ValueError):
            patch_vllm(VLLM_SOURCE.replace("raise RuntimeError", "raise Exception"))

    def test_rejects_a_wrong_source_hash_and_preserves_existing_output(self):
        with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
            build_wheel(self.source, self.root, "0" * 64, "vllm")
        audit = self.build()
        output = self.root / audit["output_filename"]
        before = output.read_bytes()
        with self.assertRaises(FileExistsError):
            self.build()
        self.assertEqual(output.read_bytes(), before)
        self.assertEqual(self.source.read_bytes(), self.original)

    def test_cancelled_build_removes_only_its_new_output(self):
        with patch("build_wheel.zipfile.ZipFile.writestr", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.build()
        self.assertEqual(list(self.root.glob("*.whl")), [self.source])
        self.assertEqual(self.source.read_bytes(), self.original)


class MlxStreamPreflight(unittest.IsolatedAsyncioTestCase):
    async def test_preflight_failure_and_cancellation_finalize_once_without_double_counting_overflow(self):
        import asyncio
        import types
        from build_wheel import patch_mlx_preflight
        source = 'async def handler(endpoint, model, preflight, audio=None):\n    try:\n        await preflight()\n    except PromptTooLongError as e:\n        runtime.metrics.record_failure(endpoint=endpoint, model=model, stream=True, error=str(e))\n        raise HTTPException(status_code=400, detail=str(e))\n\n\ndef _build_structured_logits_processors():\n    pass\n'
        class Metrics:
            def __init__(self):
                self.in_flight, self.failures = 1, 0
            def record_failure(self, **kwargs):
                self.in_flight -= 1
                self.failures += 1
        class PromptTooLongError(ValueError):
            pass
        class HTTPException(Exception):
            def __init__(self, status_code, detail):
                self.status_code = status_code
                super().__init__(detail)
        cases = (ValueError("invalid synthetic waveform"), ValueError("Unable to detect audio format from bytes"), asyncio.CancelledError(), PromptTooLongError("synthetic overflow"))
        for error in cases:
            async def preflight():
                raise error
            for text, corrected in ((source, False), (patch_mlx_preflight(source), True)):
                metrics = Metrics()
                namespace = {"runtime": types.SimpleNamespace(metrics=metrics), "PromptTooLongError": PromptTooLongError, "HTTPException": HTTPException}
                exec(text, namespace)
                overflow = isinstance(error, PromptTooLongError)
                invalid_audio = corrected and str(error) == "Unable to detect audio format from bytes"
                with self.assertRaises(HTTPException if overflow or invalid_audio else type(error)) as caught:
                    await namespace["handler"]("/chat/completions", "Synthetic", preflight, ["synthetic audio"])
                if overflow or invalid_audio:
                    self.assertEqual(caught.exception.status_code, 400)
                else:
                    self.assertIs(caught.exception, error)
                self.assertEqual((metrics.in_flight, metrics.failures), (0, 1) if corrected or overflow else (1, 0))
        metrics = Metrics()
        error = ValueError("Unable to detect audio format from bytes")
        async def preflight_without_audio():
            raise error
        namespace = {"runtime": types.SimpleNamespace(metrics=metrics), "PromptTooLongError": PromptTooLongError, "HTTPException": HTTPException}
        exec(patch_mlx_preflight(source), namespace)
        with self.assertRaises(ValueError) as caught:
            await namespace["handler"]("/chat/completions", "Synthetic", preflight_without_audio)
        self.assertIs(caught.exception, error)
        self.assertEqual((metrics.in_flight, metrics.failures), (0, 1))


if __name__ == "__main__":
    unittest.main()
