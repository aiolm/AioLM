"""Benchmark preparation uses the installed MLX loader's processor registration."""

import re
import sys
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[2] / "performance_bench" / "providers.rs"
SCRIPT = re.search(
    r'const MLX_PROMPTS: &str = r#"(.*?)"#;', SOURCE.read_text(encoding="utf-8"), re.S
).group(1)


class MlxBenchmarkPrompts(unittest.TestCase):
    def prepare(self, model_type, trust=False, loader_error=None):
        calls, result = [], []
        config = {"model_type": model_type, "eos_token_id": [3, 4]}
        registered = False

        class Tokenizer:
            def encode(self, text, add_special_tokens):
                self_test.assertFalse(add_special_tokens)
                return list(text.encode("ascii"))

            def decode(self, tokens, skip_special_tokens):
                self_test.assertFalse(skip_special_tokens)
                return bytes(tokens).decode("ascii")

            def __call__(self, text, add_special_tokens):
                calls.append(("count", add_special_tokens))
                return {"input_ids": list(text.encode("ascii")) + ([1] if add_special_tokens else [])}

        self_test = self
        processor = SimpleNamespace(tokenizer=Tokenizer(), chat_template="synthetic-template", additional_eos_token_ids=[4, 5])

        def load_config(model, **options):
            calls.append(("config", model, options))
            return config

        def get_model_and_args(*, config, model_path):
            nonlocal registered
            calls.append(("register", config, model_path))
            if loader_error is not None:
                raise loader_error
            registered = True
            return SimpleNamespace(), model_type

        def load_processor(model, **options):
            calls.append(("processor", model, options))
            if not registered:
                raise ModuleNotFoundError("The installed model processor has not been registered")
            return processor

        def load_model(*_args, **_kwargs):
            self.fail("Prompt preparation must not construct a model or load weights")

        def apply_chat_template(selected, selected_config, messages, **options):
            self.assertIs(selected, processor)
            self.assertIs(selected_config, config)
            self.assertEqual(options, {"num_images": 0, "num_audios": 0, "video": None, "tools": None,
                                       "enable_thinking": False, "reasoning": False, "thinking_budget": 17})
            return "[" + messages[0]["content"] + "]"

        utils = ModuleType("mlx_vlm.utils")
        utils.load_config = load_config
        utils.get_model_and_args = get_model_and_args
        utils.load_processor = load_processor
        utils.load_model = load_model
        utils.resolve_eos_token_ids = lambda value, _tok: value.copy()
        templates = ModuleType("mlx_vlm.prompt_utils")
        templates.apply_chat_template = apply_chat_template
        modules = {"mlx_vlm": ModuleType("mlx_vlm"), "mlx_vlm.utils": utils, "mlx_vlm.prompt_utils": templates}
        job = {"model": "/synthetic/model snapshot", "text": "synthetic corpus " * 10,
               "lengths": [10, 16], "trust_remote_code": trust, "thinking_budget": 17}

        def fail(message):
            raise AssertionError(message)

        namespace = {"run": lambda main: main(job), "emit": result.append, "fail": fail}
        with patch.dict(sys.modules, modules):
            exec(SCRIPT, namespace)
        return config, calls, result[0]

    def test_installed_loader_registers_processors_before_exact_prompt_preparation(self):
        for model_type, trust in (("gemma4", False), ("synthetic_model", False), ("synthetic_model", True)):
            with self.subTest(model_type=model_type, trust=trust):
                config, calls, result = self.prepare(model_type, trust)
                self.assertEqual([entry[0] for entry in calls[:3]], ["config", "register", "processor"])
                options = {"trust_remote_code": True} if trust else {}
                self.assertEqual(calls[0], ("config", "/synthetic/model snapshot", options))
                self.assertEqual(calls[1], ("register", config, Path("/synthetic/model snapshot")))
                self.assertEqual(calls[2], ("processor", "/synthetic/model snapshot",
                                           {"add_detokenizer": False, "eos_token_ids": [3, 4], **options}))
                special = model_type != "gemma4"
                self.assertTrue(all(entry[1] == special for entry in calls if entry[0] == "count"))
                self.assertEqual({key: len("[" + value + "]") + int(special) for key, value in result["prompts"].items()},
                                 {"10": 10, "16": 16})
                self.assertEqual(result["stop_tokens"], [3, 4, 5])

    def test_loader_failure_is_preserved_instead_of_using_an_unregistered_processor(self):
        failure = ImportError("Synthetic installed model module is unavailable")
        with self.assertRaises(ImportError) as raised:
            self.prepare("synthetic_model", loader_error=failure)
        self.assertIs(raised.exception, failure)


if __name__ == "__main__":
    unittest.main()
