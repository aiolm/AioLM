"""Synthetic installed-source fixtures; no engine or personal environment."""
import pathlib
import tempfile
import unittest

namespace = {}
exec(pathlib.Path(__file__).with_name("vllm_speech_capabilities.py").read_text(encoding="utf-8"), namespace)
scan = namespace["scan_speech_registry"]


class SpeechRegistryTests(unittest.TestCase):
    def test_registered_source_distinguishes_whisper_dual_task_and_non_speech(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            source = root / "model_executor/models/speech.py"
            source.parent.mkdir(parents=True)
            source.write_text("class WhisperForConditionalGeneration(SupportsTranscription):\n supports_transcription_only = True\nclass ChatSpeech(SupportsTranscription):\n pass\nclass TextOnly:\n pass\nclass ExplicitOff(SupportsTranscription):\n supports_transcription = False\n", encoding="utf-8")
            out = {}
            scan(out, root, {name: ("speech", name) for name in ["WhisperForConditionalGeneration", "ChatSpeech", "TextOnly", "ExplicitOff"]})
            self.assertEqual(out["transcription_architectures"], ["ChatSpeech", "WhisperForConditionalGeneration"])
            self.assertEqual(out["transcription_only_architectures"], ["WhisperForConditionalGeneration"])
            self.assertEqual(out["translation_architectures"], ["WhisperForConditionalGeneration"])

    def test_missing_sources_cycles_unknown_bases_and_unsafe_registry_are_conservative(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            source = root / "model_executor/models/synthetic.py"
            source.parent.mkdir(parents=True)
            source.write_text("class A(B):\n pass\nclass B(A):\n pass\nclass Unknown(ExternalSpeech):\n pass\n", encoding="utf-8")
            out = {}
            scan(out, root, {"A": ("synthetic", "A"), "Unknown": ("synthetic", "Unknown"), "Missing": ("missing", "Missing"), "Escape": ("../escape", "Escape")})
            self.assertEqual(out["transcription_architectures"], [])
            self.assertEqual(out["transcription_scan"], 1)


if __name__ == "__main__":
    unittest.main()
