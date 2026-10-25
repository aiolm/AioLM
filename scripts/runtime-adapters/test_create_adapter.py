import argparse
import hashlib
import importlib.util
from unittest.mock import patch
import json
import os
import platform
from pathlib import Path
import struct
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("adapter", Path(__file__).with_name("create_adapter.py"))
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


def text(value):
    raw = value.encode()
    return struct.pack("<Q", len(raw)) + raw


class LoaderProbeTests(unittest.TestCase):
    def test_strata_version_probe_uses_deployment_libraries_without_changing_host_env(self):
        with tempfile.TemporaryDirectory() as area:
            root = Path(area)
            libraries = root / "native libraries"; libraries.mkdir()
            missing = root / "missing libraries"
            exe = root / "engine"; exe.write_bytes(b"synthetic")
            tokenizer = root / "tokenizer"; tokenizer.mkdir()
            for name in ("vocab.json", "merges.txt", "token_type.json"):
                (tokenizer / name).write_text("synthetic")
            config = root / "deployment.json"
            config.write_text(json.dumps({"exe": str(exe), "args": [], "tokenizer": str(tokenizer),
                                         "lib_dirs": [str(libraries), str(missing)],
                                         "env": {"SYNTHETIC_DEPLOYMENT": "enabled"}}))
            revision = "0123456789abcdef0123456789abcdef01234567"
            args = argparse.Namespace(kind="strata", root=str(root), config=str(config), model=str(config),
                                      revision=revision, engine_id="custom.synthetic", runtime_id="r1")
            variable = "PATH" if os.name == "nt" else "LD_LIBRARY_PATH"
            with patch.dict(os.environ, {variable: "synthetic-host-path"}):
                original = dict(os.environ)
                with patch.object(adapter, "capture", side_effect=[revision, "--engine --config --host --port", "synthetic 1.0"]) as capture, patch("builtins.print"):
                    adapter.probe(args)
                native_call = capture.call_args_list[-1]
                self.assertEqual(native_call.args[0], [str(exe), "--version"])
                env = native_call.kwargs["env"]
                self.assertEqual(env[variable], os.pathsep.join([str(libraries), "synthetic-host-path"]))
                self.assertEqual(env["SYNTHETIC_DEPLOYMENT"], "enabled")
                self.assertEqual(dict(os.environ), original)

    def test_gguf_chat_support_requires_its_own_template(self):
        with tempfile.TemporaryDirectory() as area:
            path = Path(area) / "synthetic.gguf"
            fields = [("general.architecture", "qwen2")]
            for template in (None, "{{ messages }}"):
                rows = fields + ([("tokenizer.chat_template", template)] if template else [])
                raw = b"GGUF" + struct.pack("<IQQ", 3, 1, len(rows))
                for key, value in rows:
                    raw += text(key) + struct.pack("<I", 8) + text(value)
                path.write_bytes(raw)
                parsed = adapter.gguf_metadata(path)
                self.assertEqual(bool(parsed.get("tokenizer.chat_template")), template is not None)

    def test_truncated_and_unsupported_models_fail_before_launch(self):
        with tempfile.TemporaryDirectory() as area:
            path = Path(area) / "synthetic.gguf"
            for raw in (b"not GGUF", b"GGUF" + struct.pack("<IQQ", 3, 1, 1), b"GGUF" + struct.pack("<IQQ", 99, 1, 0)):
                path.write_bytes(raw)
                with self.assertRaises(ValueError):
                    adapter.gguf_metadata(path)

    def test_llama_manifest_hashes_shared_libraries_beside_the_server(self):
        with tempfile.TemporaryDirectory() as area:
            root = Path(area)
            server = root / "llama-server.exe"; server.write_bytes(b"synthetic server")
            for name in ("llama.dll", "ggml-cpu.DLL", "libggml.so.1", "libmtmd.dylib", "README.txt"):
                (root / name).write_bytes(b"synthetic")
            output = root / "runtime.json"
            args = argparse.Namespace(kind="llama.cpp", engine_id="custom.synthetic", runtime_id="r1", server=str(server),
                                      python=None, name=None, output=str(output), model=None)
            with patch("builtins.print"):
                adapter.create(args)
            artifacts = json.loads(output.read_text())["artifacts"]
            self.assertEqual(artifacts[0], str(Path(adapter.__file__).absolute()))
            self.assertEqual(sorted(Path(path).name for path in artifacts[1:]),
                             sorted(["llama.dll", "ggml-cpu.DLL", "libggml.so.1", "libmtmd.dylib"]))

    def test_strata_config_cannot_enable_independent_tools_or_lazy_loading(self):
        with tempfile.TemporaryDirectory() as area:
            root = Path(area)
            exe = root / "engine"; exe.write_bytes(b"synthetic")
            tokenizer = root / "tokenizer"; tokenizer.mkdir()
            for name in ("vocab.json", "merges.txt", "token_type.json"):
                (tokenizer / name).write_text("synthetic")
            path = root / "deployment.json"
            base = {"exe": str(exe), "args": [], "tokenizer": str(tokenizer)}
            for key, value in (("lazy_load", True), ("api_key", "synthetic-key"), ("mcp_servers", {"synthetic": {}}), ("before_load", "synthetic")):
                path.write_text(json.dumps({**base, key:value}))
                with self.assertRaises(ValueError):
                    adapter.strata_config(root, path)
            path.write_text(json.dumps(base))
            self.assertEqual(adapter.strata_config(root, path)[1], exe)

    def test_strata_manifest_hashes_native_libraries_and_tokenizer_without_upstream_tests(self):
        with tempfile.TemporaryDirectory() as area:
            root = Path(area)
            engine = root / "engine"; engine.mkdir()
            exe = engine / "strata.exe"; exe.write_bytes(b"synthetic engine")
            local_lib = engine / "runtime.dll"; local_lib.write_bytes(b"synthetic runtime")
            vendor = root / "vendor libraries"; vendor.mkdir()
            vendor_lib = vendor / "libbackend.so.1"; vendor_lib.write_bytes(b"synthetic backend")
            serve = root / "serve"; serve.mkdir()
            server = serve / "server.py"; server.write_text("# synthetic server")
            module = serve / "frontend.py"; module.write_text("# synthetic frontend")
            for number in range(70):
                (serve / f"test_example_{number}.py").write_text("# upstream tests")
            tools = root / "tools"; tools.mkdir()
            tokenizer_module = tools / "strata_tokenizer.py"; tokenizer_module.write_text("# synthetic tokenizer")
            tokenizer = root / "tokenizer"; tokenizer.mkdir()
            for name in ("vocab.json", "merges.txt", "token_type.json"):
                (tokenizer / name).write_text("synthetic")
            config = root / "deployment.json"
            config.write_text(json.dumps({"exe": str(exe), "args": [], "tokenizer": str(tokenizer),
                                         "lib_dirs": [str(vendor)]}))
            output = root / "runtime.json"
            args = argparse.Namespace(kind="strata", engine_id="custom.synthetic", runtime_id="r1", python=None,
                                      root=str(root), config=str(config), name=None, output=str(output),
                                      revision="0123456789abcdef0123456789abcdef01234567")
            with patch("builtins.print"):
                adapter.create(args)
            files = set(json.loads(output.read_text())["artifacts"])
            self.assertEqual(files, {str(Path(adapter.__file__).absolute()), str(exe), str(local_lib),
                                     str(vendor_lib), str(server), str(module), str(tokenizer_module)})
            manifest = json.loads(output.read_text())
            facts = manifest.get("option_metadata", {})
            self.assertEqual(facts.get("engine_id"), args.engine_id)
            self.assertEqual(facts.get("adapter", {}).get("revision"), args.revision)
            reserved = {row["flag"]: row.get("reserved") for row in facts.get("options", [])}
            # The pinned server reads --tokenizer whenever the deployment has
            # no "tokenizer" key, so it could replace the one validated here.
            self.assertEqual(set(reserved), {"--lazy", "--idle-unload", "--before-load", "--mcp-config", "--tokenizer"})
            self.assertTrue(all(reserved.values()), "each ownership refusal explains its reason")

    def test_strata_model_binding_cannot_replace_the_registered_native_build(self):
        with tempfile.TemporaryDirectory() as area:
            root = Path(area)
            for name in ("engine-a", "engine-b"):
                (root / name).write_bytes(b"synthetic engine")
            tokenizer = root / "tokenizer"; tokenizer.mkdir()
            for name in ("vocab.json", "merges.txt", "token_type.json"):
                (tokenizer / name).write_text("synthetic")
            registered, selected = root / "registered.json", root / "selected.json"
            base = {"args": [], "tokenizer": str(tokenizer)}
            registered.write_text(json.dumps({**base, "exe": str(root / "engine-a")}))
            selected.write_text(json.dumps({**base, "exe": str(root / "engine-b")}))
            revision = "0123456789abcdef0123456789abcdef01234567"
            args = argparse.Namespace(kind="strata", root=str(root), config=str(registered), model=str(selected), revision=revision)
            with patch.object(adapter, "capture", side_effect=[revision, "--engine --config --host --port"]):
                with self.assertRaisesRegex(ValueError, "another Strata engine build"):
                    adapter.probe(args)


def synthetic_elf(path, interpreter):
    """A 64-bit little-endian ELF header with one PT_INTERP program header (no code)."""
    name = os.fsencode(interpreter) + b"\0"
    header = b"\x7fELF" + bytes([2, 1, 1]) + bytes(9) + struct.pack("<HHIQQQIHHHHHH", 2, 62, 1, 0, 64, 0, 0, 64, 56, 1, 0, 0, 0)
    program = struct.pack("<IIQQQQQQ", 3, 4, 120, 0, 0, len(name), len(name), 1)
    path.write_bytes(header + program + name)


class StrataLibraryArtifactTests(unittest.TestCase):
    """A system GPU runtime (a ROCm lib folder of 158 aliases, with nested rocm_sysdeps/lib and llvm/lib) behind the
    pinned Strata engine: every alias stays declared, loader-resolved nested libraries are added, bounds hold."""

    def deployment(self, root, exe, lib_dirs, env=None):
        serve = root / "serve"; serve.mkdir(exist_ok=True)
        (serve / "server.py").write_text("# synthetic server")
        tokenizer = root / "tokenizer"; tokenizer.mkdir(exist_ok=True)
        for name in ("vocab.json", "merges.txt", "token_type.json"):
            (tokenizer / name).write_text("synthetic")
        config = root / "deployment.json"
        config.write_text(json.dumps({"exe": str(exe), "args": [], "tokenizer": str(tokenizer),
                                     "lib_dirs": [str(path) for path in lib_dirs], **({"env": env} if env else {})}))
        return config

    def create(self, root, config):
        output = root / "runtime.json"
        output.unlink(missing_ok=True)
        args = argparse.Namespace(kind="strata", engine_id="custom.synthetic", runtime_id="r1", python=None,
                                  root=str(root), config=str(config), name=None, output=str(output),
                                  revision="0123456789abcdef0123456789abcdef01234567")
        with patch("builtins.print"):
            adapter.create(args)
        return json.loads(output.read_text())["artifacts"]

    def test_library_folder_beyond_64_files_registers_up_to_the_registry_bound(self):
        with tempfile.TemporaryDirectory() as area:
            root = Path(area)
            engine = root / "engine"; engine.mkdir()
            exe = engine / "strata"; exe.write_bytes(b"synthetic engine")
            libraries = root / "rocm lib"; libraries.mkdir()
            config = self.deployment(root, exe, [libraries])
            fixed = 3   # the helper, serve/server.py and the engine
            for count in (179 - fixed, 256 - fixed):
                for number in range(count):
                    (libraries / f"libsynthetic{number:03}.so.1").write_bytes(b"synthetic library")
                artifacts = self.create(root, config)
                self.assertEqual(len(artifacts), count + fixed)
            (libraries / "libsynthetic-overflow.so").write_bytes(b"synthetic library")
            with self.assertRaisesRegex(ValueError, r"artifact count \(257 files, at most 256\)"):
                self.create(root, config)

    def test_paths_within_the_count_still_respect_the_serialized_budget(self):
        with tempfile.TemporaryDirectory() as area:
            root = Path(area)
            engine = root / "engine"; engine.mkdir()
            exe = engine / "strata"; exe.write_bytes(b"synthetic engine")
            libraries = root.joinpath(*("d" * 200 for _ in range(4))); libraries.mkdir(parents=True)
            config = self.deployment(root, exe, [libraries])
            for number in range(253):
                (libraries / f"lib{'l' * 230}{number:03}.so").write_bytes(b"synthetic library")
            with self.assertRaisesRegex(ValueError, "256 KiB registration budget"):
                self.create(root, config)

    @unittest.skipUnless(platform.system() == "Linux", "the ELF loader listing is Linux-only")
    def test_loader_resolved_nested_libraries_are_declared_and_their_change_is_visible(self):
        with tempfile.TemporaryDirectory() as area:
            root = Path(area)
            libraries = root / "rocm lib"; (libraries / "rocm_sysdeps" / "lib").mkdir(parents=True)
            (libraries / "llvm" / "lib").mkdir(parents=True)
            top = libraries / "libruntime.so.7"; top.write_bytes(b"synthetic runtime")
            alias = libraries / "libruntime.so"; alias.symlink_to(top.name)
            nested = libraries / "rocm_sysdeps" / "lib" / "libsysdeps_z.so.1"; nested.write_bytes(b"synthetic z")
            compiler = libraries / "llvm" / "lib" / "libLLVM.so.23"; compiler.write_bytes(b"synthetic llvm")
            unrelated = libraries / "llvm" / "lib" / "libunrelated.so.1"; unrelated.write_bytes(b"not linked")
            outside = root / "system" / "libc.so.6"; outside.parent.mkdir(); outside.write_bytes(b"synthetic libc")
            seen = root / "loader-env.txt"
            loader = root / "loader"
            rows = "".join(f"\t{path.name} => {path} (0x00007f00000{index:05x})\\n"
                           for index, path in enumerate((top, nested, compiler, outside)))
            # A synthetic dynamic loader: records the environment and argv it was given, then lists.
            loader.write_text(f'#!/bin/sh\nprintf "%s\\n%s %s\\n%s\\n" "$LD_LIBRARY_PATH" "$1" "$2" "$SYNTHETIC_DEPLOYMENT" > "{seen}"\n'
                              f'printf "\\tlinux-vdso.so.1 (0x00007fff00000000)\\n{rows}\\t/lib64/ld-synthetic.so.2 (0x00007f0000100000)\\n"\n')
            loader.chmod(0o755)
            engine = root / "engine"; engine.mkdir()
            exe = engine / "strata"; synthetic_elf(exe, loader)
            config = self.deployment(root, exe, [libraries], env={"SYNTHETIC_DEPLOYMENT": "enabled"})
            with patch.dict(os.environ, {"LD_LIBRARY_PATH": "synthetic-host-path"}):
                artifacts = self.create(root, config)
            self.assertEqual(seen.read_text().splitlines(),
                             [os.pathsep.join([str(libraries), "synthetic-host-path"]), f"--list {exe}", "enabled"])
            self.assertTrue({str(top), str(alias), str(nested), str(compiler)} <= set(artifacts))
            self.assertNotIn(str(unrelated), artifacts, "unlinked libraries of a nested folder are not swept in")
            self.assertNotIn(str(outside), artifacts, "libraries outside the deployment's roots stay undeclared")
            # The registry hashes every declared path; a changed nested library now changes a declared digest.
            def digests():
                return {path: hashlib.sha256(Path(path).read_bytes()).hexdigest() for path in artifacts}
            before = digests()
            compiler.write_bytes(b"replaced llvm")
            after = digests()
            self.assertEqual({path for path in before if before[path] != after[path]}, {str(compiler)})

    @unittest.skipUnless(platform.system() == "Linux", "the ELF loader listing is Linux-only")
    def test_unresolved_runtime_libraries_fail_with_the_library_and_lib_dirs(self):
        with tempfile.TemporaryDirectory() as area:
            root = Path(area)
            libraries = root / "lib"; libraries.mkdir()
            engine = root / "engine"; engine.mkdir()
            exe = engine / "strata"
            loader = root / "loader"
            for script in ('printf "\\tlibmissing.so.3 => not found\\n"\n',
                           'echo "strata: error while loading shared libraries: libgone.so.1: cannot open shared object file" >&2\nexit 127\n'):
                loader.write_text("#!/bin/sh\n" + script)
                loader.chmod(0o755)
                synthetic_elf(exe, loader)
                config = self.deployment(root, exe, [libraries])
                with self.assertRaisesRegex(ValueError, r"(libmissing\.so\.3|libgone\.so\.1).*lib_dirs"):
                    self.create(root, config)

    @unittest.skipUnless(platform.system() == "Linux", "the ELF loader listing is Linux-only")
    def test_undecodable_loader_output_fails_without_diagnosing_missing_libraries(self):
        with tempfile.TemporaryDirectory() as area:
            root = Path(area)
            loader = root / "loader"
            loader.write_text("#!/bin/sh\nprintf '\\377'\n")
            loader.chmod(0o755)
            exe = root / "engine"
            synthetic_elf(exe, loader)
            with self.assertRaises(ValueError) as result:
                adapter.loader_resolved_libraries(exe, [root], {**os.environ, "LC_ALL": "C.UTF-8"})
            self.assertIn("could not be decoded", str(result.exception))
            self.assertIn("library path encoding", str(result.exception))
            self.assertNotIn("lib_dirs", str(result.exception))
            self.assertNotIn("do not resolve", str(result.exception))

    def test_non_elf_engines_and_other_platforms_run_no_loader(self):
        with tempfile.TemporaryDirectory() as area:
            root = Path(area)
            exe = root / "strata.exe"; exe.write_bytes(b"MZ synthetic Windows engine")
            self.assertIsNone(adapter.elf_interpreter(exe))
            synthetic_elf(exe, root / "loader")
            with patch.object(adapter, "_capture_run", side_effect=AssertionError("no loader run")):
                with patch.object(adapter.platform, "system", return_value="Windows"):
                    self.assertEqual(adapter.loader_resolved_libraries(exe, [root], {}), [])
                exe.write_bytes(b"synthetic engine")
                self.assertEqual(adapter.loader_resolved_libraries(exe, [root], {}), [])

    def test_malformed_elf_interpreter_is_rejected_before_loader_execution(self):
        with tempfile.TemporaryDirectory() as area:
            root = Path(area)
            exe = root / "engine"
            synthetic_elf(exe, Path(sys.executable))
            valid = exe.read_bytes()
            unterminated = valid[:-1] + b"x"
            overlong = bytearray(valid)
            struct.pack_into("<Q", overlong, 64 + 32, 4096)
            overflow = bytearray(valid)
            struct.pack_into("<Q", overflow, 0x20, 2**64 - 1)
            for malformed in (valid[:63], unterminated, overlong, overflow):
                with self.subTest(length=len(malformed)):
                    exe.write_bytes(malformed)
                    with patch.object(adapter, "_capture_run", side_effect=AssertionError("no loader run")):
                        with self.assertRaises(ValueError):
                            adapter.elf_interpreter(exe)

    @unittest.skipUnless(platform.system() == "Linux", "the ELF loader listing is Linux-only")
    def test_direct_library_rows_and_dotdot_paths_use_normalized_roots(self):
        with tempfile.TemporaryDirectory() as area:
            root = Path(area)
            libraries = root / "rocm" / "lib"
            (libraries / "nested").mkdir(parents=True)
            linked = libraries / "nested" / "libdirect.so.1"
            linked.write_bytes(b"linked by absolute DT_NEEDED")
            outside = root / "liboutside.so.1"
            outside.write_bytes(b"outside the deployment")
            external = root / "external"
            (external / "nested").mkdir(parents=True)
            (external / "libdecoy.so.1").write_bytes(b"actually loaded outside")
            (libraries / "libdecoy.so.1").write_bytes(b"unlinked lexical decoy")
            (libraries / "escape").symlink_to(external / "nested", target_is_directory=True)
            loader = root / "loader"
            loader.write_text('#!/bin/sh\nprintf "%s\\n" '
                              f'"  {linked} (0x001)" '
                              f'"  liboutside.so.1 => {libraries}/nested/../../../liboutside.so.1 (0x002)" '
                              f'"  libdecoy.so.1 => {libraries}/escape/../libdecoy.so.1 (0x003)"\n')
            loader.chmod(0o755)
            exe = root / "engine"
            synthetic_elf(exe, loader)
            self.assertEqual(adapter.loader_resolved_libraries(exe, [libraries], {}), [str(linked)])
            (root / "root-alias").symlink_to(external / "nested", target_is_directory=True)
            declared = root / "root-alias" / ".."
            actual = libraries / "escape" / ".." / "libdecoy.so.1"
            self.assertEqual(adapter.loader_resolved_libraries(exe, [declared], {}), [str(actual)])

    @unittest.skipUnless(platform.system() == "Linux", "the ELF loader listing is Linux-only")
    def test_relative_library_paths_are_checked_in_the_deployment_working_directory(self):
        with tempfile.TemporaryDirectory() as area:
            root = Path(area)
            libraries = root / "lib"
            (libraries / "nested").mkdir(parents=True)
            linked = libraries / "nested" / "librelative.so.1"
            linked.write_bytes(b"relative library")
            loader = root / "loader"
            loader.write_text('#!/bin/sh\ntest -f lib/nested/librelative.so.1 || exit 1\n'
                              'printf "  librelative.so.1 => lib/nested/librelative.so.1 (0x001)\\n"\n')
            loader.chmod(0o755)
            exe = root / "engine"
            synthetic_elf(exe, loader)
            config = self.deployment(root, exe, ["lib"])
            self.assertIn(str(linked), self.create(root, config))


if __name__ == "__main__":
    unittest.main()
