"""Check installed Gemma3n template/tokenizer ownership without a checkpoint.

Use the selected runtime's Python. Synthetic assets and tokenizer output exercise
the real processor loader and input dispatcher without network, audio or weights.
"""
import json
import tempfile
from pathlib import Path
from unittest.mock import patch


def check():
    from mlx_vlm.models.gemma3n.processing_gemma3n import Gemma3nProcessor
    from mlx_vlm.utils import process_inputs, should_add_special_tokens

    class Tokenizer:
        audio_token_id = 90
        image_token_id = 91
        boa_token, audio_token, eoa_token = '<audio>', '<soft_audio>', '</audio>'
        boi_token, image_token, eoi_token = '<image>', '<soft_image>', '</image>'
        chat_template = None

        def __call__(self, text, add_special_tokens=True, **kwargs):
            ids = []
            for prompt in text:
                sequence = ([2] if prompt.startswith('<bos>') else []) + [42]
                ids.append(([2] if add_special_tokens else []) + sequence)
            return {'input_ids': ids, 'attention_mask': [[1] * len(row) for row in ids]}

    cases = []
    with tempfile.TemporaryDirectory() as directory:
        template = Path(directory) / 'chat_template.jinja'
        template.write_text('<bos>synthetic chat template')
        for has_template in (True, False):
            if not has_template:
                template.unlink()
            tokenizer = Tokenizer()
            with patch('transformers.AutoTokenizer.from_pretrained', return_value=tokenizer), \
                    patch('transformers.AutoImageProcessor.from_pretrained', return_value=object()), \
                    patch('transformers.AutoFeatureExtractor.from_pretrained', side_effect=ValueError('no synthetic audio')):
                processor = Gemma3nProcessor.from_pretrained(directory)
            assert getattr(processor, 'chat_template', None) == tokenizer.chat_template, 'processor lost the loaded tokenizer template'
            policy = should_add_special_tokens('gemma3n', processor)
            assert policy is (not has_template), 'template token policy changed'
            prompt = '<bos>synthetic prompt' if has_template else 'synthetic prompt'
            result = process_inputs(processor, prompts=prompt, add_special_tokens=policy)
            assert result['input_ids'].tolist() == [[2, 42]], 'BOS was duplicated or omitted'
            if has_template:
                explicit = process_inputs(processor, prompts=prompt, add_special_tokens=True)
                assert explicit['input_ids'].tolist() == [[2, 2, 42]], 'explicit caller token policy was ignored'
            cases.append({'template_present': has_template, 'add_special_tokens': policy, 'bos_count': 1})
    return {'processor_template_ownership': 'pass', 'token_option_forwarding': 'pass', 'cases': cases}


if __name__ == '__main__':
    print(json.dumps(check(), indent=2))
