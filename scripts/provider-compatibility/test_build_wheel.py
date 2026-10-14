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


class Gemma4AudioPacking(unittest.TestCase):
    def test_padding_between_recordings_cannot_take_the_next_recordings_token_slots(self):
        import ast
        import math
        import types
        from build_wheel import patch_mlx_gemma4_audio

        source = '\n\nclass MultimodalEmbedder(nn.Module):\n    pass\n\nclass Model:\n    def embeddings(self):\n        if True:\n            def _encode_audio(feat):\n                enc, _ = self.audio_tower(feat, mask)\n                return self.embed_audio(enc)\n'
        tree = ast.parse(patch_mlx_gemma4_audio(source))
        function = next(item for item in tree.body if isinstance(item, ast.FunctionDef) and item.name == '_pack_audio_features')

        class Tensor:
            def __init__(self, values, shape):
                self.values, self.shape = list(values), tuple(shape)
                assert len(self.values) == math.prod(self.shape)
            def reshape(self, *shape):
                if -1 in shape:
                    shape = tuple(len(self.values) // math.prod(d for d in shape if d != -1) if d == -1 else d for d in shape)
                return Tensor(self.values, shape)
            def tolist(self):
                assert len(self.shape) == 1
                return self.values

        def take(features, positions, axis):
            self.assertEqual(axis, 0)
            width = features.shape[-1]
            return Tensor([value for index in positions for value in features.values[index * width:(index + 1) * width]], (len(positions), width))

        namespace = {'mx': types.SimpleNamespace(take=take, array=lambda values, dtype: values, int32=int)}
        exec(compile(ast.Module(body=[function], type_ignores=[]), 'gemma4.py', 'exec'), namespace)
        pack = namespace['_pack_audio_features']
        # Encoder padding can become nonzero after the learned projection.
        features = Tensor([10, 11, 20, 21, 90, 91, 30, 31, 40, 41, 50, 51], (2, 3, 2))
        packed = pack(features, Tensor([False, False, True, False, False, False], (2, 3)))
        self.assertEqual(packed.values, [10, 11, 20, 21, 30, 31, 40, 41, 50, 51])
        self.assertNotEqual(features.values[:10], packed.values, 'upstream scattering includes the first recording padding and drops the final observation')
        self.assertEqual(pack(features, Tensor([False] * 6, (2, 3))).values, features.values)
        with self.assertRaisesRegex(ValueError, 'no valid frames'):
            pack(features, Tensor([True] * 6, (2, 3)))
        with self.assertRaisesRegex(ValueError, 'upstream source differs'):
            patch_mlx_gemma4_audio(source.replace('enc, _ =', 'enc, changed ='))


if __name__ == "__main__":
    unittest.main()
