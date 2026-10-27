"""Synthetic installed-source fixtures; no engine or personal environment."""
import ast
import collections
import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

SPEECH_SOURCE = pathlib.Path(__file__).with_name("vllm_speech_capabilities.py").read_text(encoding="utf-8")
namespace = {}
exec(SPEECH_SOURCE, namespace)
scan = namespace["scan_speech_registry"]
FIELDS = ("transcription_architectures", "transcription_only_architectures",
          "translation_architectures", "transcription_scan")


def package(name, **attributes):
    result = types.ModuleType(name)
    result.__path__ = []
    vars(result).update(attributes)
    return result


def execute_production_entry(root, entries):
    registry = package("vllm.model_executor.models.registry", _MULTIMODAL_MODELS=entries)
    models = package("vllm.model_executor.models", registry=registry)
    executor = package("vllm.model_executor", models=models)
    vllm = package("vllm", __file__=str(root / "__init__.py"), model_executor=executor)
    modules = {"vllm": vllm, "vllm.model_executor": executor,
               "vllm.model_executor.models": models,
               "vllm.model_executor.models.registry": registry}
    record = {"variant": "standard", "version": "synthetic-classification-context",
              "errors": ["synthetic fixture establishes no engine readiness"]}
    with patch.dict(sys.modules, modules):
        exec(compile(SPEECH_SOURCE, "vllm_speech_capabilities.py", "exec"), {"out": record})
    return {name: record[name] for name in FIELDS}


def source_file(root, source, module="speech"):
    path = root / "model_executor" / "models" / (module + ".py")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(source, encoding="utf-8")
    return path


def expected_flags(source, names, **runtime_globals):
    # Python's own class construction and attribute lookup provide an
    # independent oracle for these synthetic, executable local hierarchies.
    exec(compile(source, "synthetic_speech_hierarchy.py", "exec"), runtime_globals)
    supported = [name for name in names if getattr(runtime_globals[name], "supports_transcription", False)]
    exclusive = [name for name in supported if getattr(runtime_globals[name], "supports_transcription_only", False)]
    return {"transcription_architectures": sorted(supported),
            "transcription_only_architectures": sorted(exclusive),
            "translation_architectures": [], "transcription_scan": 1}


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
    def test_shared_module_avoids_reparse_and_next_scan_is_fresh(self):
        source = """class SupportsTranscription:
 supports_transcription = True
 supports_transcription_only = False
class Alpha(SupportsTranscription): pass
class Beta(SupportsTranscription): pass
class Gamma(SupportsTranscription): pass
class Delta(SupportsTranscription): pass
"""
        names = ("Alpha", "Beta", "Gamma", "Delta")
        entries = {name: ("speech", name) for name in names}
        with tempfile.TemporaryDirectory(prefix="aiolm-capability-reuse-") as directory:
            root = pathlib.Path(directory)
            path = source_file(root, source)
            original_read = pathlib.Path.read_text
            reads = collections.Counter()

            def observed_read(candidate, *args, **kwargs):
                if candidate == path:
                    reads["source"] += 1
                return original_read(candidate, *args, **kwargs)

            with patch.object(pathlib.Path, "read_text", observed_read), patch("ast.parse", wraps=ast.parse) as parsed:
                first = execute_production_entry(root, entries)
                first_counts = (reads["source"], parsed.call_count)
                # The second real invocation must see changed installed bytes.
                source_file(root, source.replace("class Beta(SupportsTranscription)", "class Beta"))
                reads.clear()
                parsed.reset_mock()
                second = execute_production_entry(root, entries)
                second_counts = (reads["source"], parsed.call_count)
            expected = {"transcription_architectures": sorted(names),
                        "transcription_only_architectures": [], "translation_architectures": [],
                        "transcription_scan": 1}
            refreshed = {**expected, "transcription_architectures": sorted(set(names) - {"Beta"})}
            print("CAPABILITY_SHARED_SOURCE", "counts=", [first_counts, second_counts],
                  "first=", first, "refreshed=", second)
            self.assertEqual(first, expected)
            self.assertEqual(second, refreshed)
            self.assertEqual(first_counts, (4, 1))
            self.assertEqual(second_counts, (4, 1))

    def test_changed_source_is_reparsed_during_the_same_scan(self):
        source = """class SupportsTranscription:
 supports_transcription = True
 supports_transcription_only = False
class Alpha(SupportsTranscription): pass
class Beta(SupportsTranscription): pass
class Gamma(SupportsTranscription): pass
class Delta(SupportsTranscription): pass
"""
        changed = source.replace("class Beta(SupportsTranscription)", "class Beta")
        names = ("Alpha", "Beta", "Gamma", "Delta")
        with tempfile.TemporaryDirectory(prefix="aiolm-capability-live-source-") as directory:
            root = pathlib.Path(directory)
            path = source_file(root, source)
            original_read = pathlib.Path.read_text
            reads = 0

            def observed_read(candidate, *args, **kwargs):
                nonlocal reads
                text = original_read(candidate, *args, **kwargs)
                if candidate == path:
                    reads += 1
                    if reads == 1:
                        # Change only the owned fixture after the first actual
                        # read has its immutable bytes, before the next entry.
                        path.write_text(changed, encoding="utf-8")
                return text

            with patch.object(pathlib.Path, "read_text", observed_read), patch("ast.parse", wraps=ast.parse) as parsed:
                actual = execute_production_entry(root, {name: ("speech", name) for name in names})
                parses = parsed.call_count
            expected = {"transcription_architectures": ["Alpha", "Delta", "Gamma"],
                        "transcription_only_architectures": [], "translation_architectures": [],
                        "transcription_scan": 1}
            print("CAPABILITY_LIVE_SOURCE", "reads=", reads, "parses=", parses,
                  "expected=", expected, "actual=", actual)
            self.assertEqual(actual, expected)
            self.assertEqual(reads, 4)
            self.assertEqual(parses, 2)

    def test_local_multiple_inheritance_respects_actual_python_flag_precedence(self):
        source = """class SupportsTranscription:
 supports_transcription = True
 supports_transcription_only = False
class Disabled:
 supports_transcription = False
class Enabled(SupportsTranscription): pass
class Child(Disabled, Enabled): pass
class NonExclusive:
 supports_transcription_only = False
class Exclusive(SupportsTranscription):
 supports_transcription_only = True
class Dual(NonExclusive, Exclusive): pass
"""
        names = ("Child", "Dual")
        runtime_classes = {}
        # Ordinary synthetic Python classes establish expected MRO behavior;
        # there is no model import, numerical pass or mirrored AST helper.
        exec(compile(source, "synthetic_flag_precedence.py", "exec"), runtime_classes)
        supported = [name for name in names if getattr(runtime_classes[name], "supports_transcription", False)]
        exclusive = [name for name in supported if getattr(runtime_classes[name], "supports_transcription_only", False)]
        expected = {"transcription_architectures": sorted(supported),
                    "transcription_only_architectures": sorted(exclusive),
                    "translation_architectures": [], "transcription_scan": 1}
        with tempfile.TemporaryDirectory(prefix="aiolm-capability-mro-") as directory:
            root = pathlib.Path(directory)
            source_file(root, source)
            actual = execute_production_entry(root, {name: ("speech", name) for name in names})
        print("CAPABILITY_FLAG_PRECEDENCE", "expected=", expected, "actual=", actual)
        self.assertEqual(actual, expected)
    def test_diamonds_and_direct_overrides_follow_python_c3_lookup(self):
        source = """class SupportsTranscription:
 supports_transcription = True
 supports_transcription_only = False
class Base(SupportsTranscription): pass
class Left(Base): pass
class DisabledRight(Base):
 supports_transcription = False
class Diamond(Left, DisabledRight): pass
class ExclusiveRight(Base):
 supports_transcription_only = True
class SpeechDiamond(Left, ExclusiveRight): pass
class DeepDiamond(SpeechDiamond): pass
class DirectOn(Diamond):
 supports_transcription: bool = True
class DirectOff(DeepDiamond):
 supports_transcription = False
class DirectDual(DeepDiamond):
 supports_transcription_only: bool = False
class AnnotationOnly(DeepDiamond):
 supports_transcription: bool
 supports_transcription_only: bool
class UnknownOwnValue(DeepDiamond):
 supports_transcription = runtime_flag
"""
        names = ("Diamond", "SpeechDiamond", "DeepDiamond", "DirectOn", "DirectOff",
                 "DirectDual", "AnnotationOnly", "UnknownOwnValue")
        expected = expected_flags(source, names, runtime_flag=False)
        self.assertEqual(expected["transcription_architectures"],
                         ["AnnotationOnly", "DeepDiamond", "DirectDual", "DirectOn", "SpeechDiamond"])
        self.assertEqual(expected["transcription_only_architectures"],
                         ["AnnotationOnly", "DeepDiamond", "SpeechDiamond"])
        with tempfile.TemporaryDirectory(prefix="aiolm-speech-diamond-") as directory:
            root = pathlib.Path(directory)
            source_file(root, source)
            self.assertEqual(execute_production_entry(root, {name: ("speech", name) for name in names}), expected)

    def test_local_protocol_definition_and_opaque_external_bases_keep_distinct_evidence(self):
        source = """class SupportsTranscription:
 supports_transcription = False
 supports_transcription_only = True
class LocalOff(SupportsTranscription): pass
class LocalOn(SupportsTranscription):
 supports_transcription = True
 supports_transcription_only = False
"""
        names = ("LocalOff", "LocalOn")
        with tempfile.TemporaryDirectory(prefix="aiolm-speech-local-protocol-") as directory:
            root = pathlib.Path(directory)
            path = source_file(root, source)
            self.assertEqual(execute_production_entry(root, {name: ("speech", name) for name in names}),
                             expected_flags(source, names))
            path.write_text("""class Unknown(ImportedSpeech): pass
class AttributeUnknown(interfaces.SupportsTranscription): pass
class Mixed(nn.Module, SupportsTranscription): pass
class Reversed(SupportsTranscription, nn.Module): pass
class Disabled:
 supports_transcription = False
class MixedOff(nn.Module, Disabled, SupportsTranscription): pass
class DirectOn(ImportedSpeech):
 supports_transcription = True
class WhisperForConditionalGeneration(nn.Module, SupportsTranscription):
 supports_transcription_only = True
""", encoding="utf-8")
            names = ("Unknown", "AttributeUnknown", "Mixed", "Reversed", "MixedOff", "DirectOn",
                     "WhisperForConditionalGeneration")
            entries = {name: ("speech", name) for name in names}
            entries["WhisperAlias"] = ("speech", "WhisperForConditionalGeneration")
            self.assertEqual(execute_production_entry(root, entries),
                             {"transcription_architectures": ["DirectOn", "Mixed", "Reversed", "WhisperAlias",
                                                              "WhisperForConditionalGeneration"],
                              "transcription_only_architectures": ["WhisperAlias", "WhisperForConditionalGeneration"],
                              "translation_architectures": ["WhisperForConditionalGeneration"],
                              "transcription_scan": 1})

    def test_cycles_duplicates_and_inconsistent_local_mro_never_grant_speech(self):
        source = """class A(B):
 supports_transcription = True
class B(A): pass
class SupportsTranscription:
 supports_transcription = True
class X: pass
class Y: pass
class First(X, Y): pass
class Second(Y, X): pass
class Inconsistent(First, Second):
 supports_transcription = True
class Duplicate(SupportsTranscription, SupportsTranscription):
 supports_transcription = True
class ObjectFirst(object, SupportsTranscription): pass
class Healthy(SupportsTranscription): pass
"""
        names = ("A", "B", "Inconsistent", "Duplicate", "ObjectFirst", "Healthy")
        with tempfile.TemporaryDirectory(prefix="aiolm-speech-invalid-mro-") as directory:
            root = pathlib.Path(directory)
            source_file(root, source)
            self.assertEqual(execute_production_entry(root, {name: ("speech", name) for name in names}),
                             {"transcription_architectures": ["Healthy"], "transcription_only_architectures": [],
                              "translation_architectures": [], "transcription_scan": 1})

    def test_only_latest_module_summary_is_reused_and_all_entries_still_stat_and_read(self):
        with tempfile.TemporaryDirectory(prefix="aiolm-speech-latest-source-") as directory:
            root = pathlib.Path(directory)
            first = source_file(root, "class First(SupportsTranscription): pass\n", "first")
            second = source_file(root, "class Second(SupportsTranscription): pass\n", "second")
            entries = {"First": ("first", "First"), "Second": ("second", "Second"),
                       "FirstAgain": ("first", "First"), "FirstRepeated": ("first", "First")}
            reads, stats = collections.Counter(), collections.Counter()
            original_read, original_stat = pathlib.Path.read_text, pathlib.Path.stat

            def observed_read(candidate, *args, **kwargs):
                if candidate in (first, second):
                    reads[candidate.name] += 1
                return original_read(candidate, *args, **kwargs)

            def observed_stat(candidate, *args, **kwargs):
                if candidate in (first, second):
                    stats[candidate.name] += 1
                return original_stat(candidate, *args, **kwargs)

            with patch.object(pathlib.Path, "read_text", observed_read), \
                    patch.object(pathlib.Path, "stat", observed_stat), patch("ast.parse", wraps=ast.parse) as parsed:
                actual = execute_production_entry(root, entries)
                parses = parsed.call_count
            self.assertEqual(actual, {"transcription_architectures": sorted(entries),
                                      "transcription_only_architectures": [], "translation_architectures": [],
                                      "transcription_scan": 1})
            self.assertEqual(reads, {"first.py": 3, "second.py": 1})
            self.assertEqual(stats, reads)
            self.assertEqual(parses, 3)

    def test_unregistered_graph_does_not_change_selected_classification(self):
        source = "class Root(SupportsTranscription): pass\n" + "".join(
            f"class Unregistered{index}({('Root' if index == 0 else 'Unregistered' + str(index - 1))}): pass\n"
            for index in range(240))
        source += """class UnregisteredCycle(UnregisteredCycle):
 supports_transcription = True
class Registered(SupportsTranscription): pass
class TextOnly: pass
"""
        entries = {"Registered": ("speech", "Registered"), "Alias": ("speech", "Registered"),
                   "TextOnly": ("speech", "TextOnly"), "MissingClass": ("speech", "MissingClass")}
        with tempfile.TemporaryDirectory(prefix="aiolm-speech-unregistered-") as directory:
            root = pathlib.Path(directory)
            source_file(root, source)
            with patch("ast.parse", wraps=ast.parse) as parsed:
                actual = execute_production_entry(root, entries)
            self.assertEqual(actual, {"transcription_architectures": ["Alias", "Registered"],
                                      "transcription_only_architectures": [], "translation_architectures": [],
                                      "transcription_scan": 1})
            self.assertEqual(parsed.call_count, 1)

    def test_deep_selected_local_chain_and_next_call_refresh_without_recursive_walker(self):
        source = "class Root(SupportsTranscription):\n supports_transcription_only = True\n" + "".join(
            f"class Chain{index}({('Root' if index == 0 else 'Chain' + str(index - 1))}): pass\n"
            for index in range(1100))
        entries = {"Deep": ("speech", "Chain1099"), "DeepAlias": ("speech", "Chain1099")}
        with tempfile.TemporaryDirectory(prefix="aiolm-speech-deep-local-") as directory:
            root = pathlib.Path(directory)
            path = source_file(root, source)
            first = execute_production_entry(root, entries)
            path.write_text(source.replace("supports_transcription_only = True", "supports_transcription_only = False"),
                            encoding="utf-8")
            second = execute_production_entry(root, entries)
            expected = {"transcription_architectures": ["Deep", "DeepAlias"],
                        "transcription_only_architectures": ["Deep", "DeepAlias"],
                        "translation_architectures": [], "transcription_scan": 1}
            self.assertEqual(first, expected)
            self.assertEqual(second, {**expected, "transcription_only_architectures": []})


if __name__ == "__main__":
    unittest.main()
