"""Check the selected MLX runtime's Gemma3n prefill and shared query positions.

Uses tiny synthetic tensors, no checkpoint, network, saved state or real audio.
Run with the explicitly selected runtime's Python; MLX is required.
"""
import json
from types import SimpleNamespace


def check():
    import mlx.core as mx
    from mlx_vlm.models.gemma3n.gemma3n import Model
    from mlx_vlm.models.gemma3n.language import Gemma3nAttention as Attention
    from mlx_vlm.models.gemma3n.config import TextConfig
    from mlx_vlm.models.cache import KVCache, BatchKVCache

    vector = mx.arange(16, dtype=mx.float32).reshape(1, 1, 16)
    holder = SimpleNamespace(
        config=SimpleNamespace(text_config=SimpleNamespace(hidden_size=16)),
        vocab_size_per_layer_input=32,
        language_model=SimpleNamespace(model=SimpleNamespace(
            embed_tokens=lambda ids: vector,
            get_per_layer_inputs=lambda ids: mx.ones((1, 1, 2, 4)),
        )),
    )
    features = Model.get_input_embeddings(holder, mx.array([[1]]))
    assert mx.allclose(features.inputs_embeds, vector * 4).item(), 'media prefill text differs from token-ID path scale'
    assert mx.all(features.per_layer_inputs == 1).item(), 'per-layer input changed'
    config = TextConfig(model_type='gemma3n', hidden_size=8, num_hidden_layers=4,
        intermediate_size=[16] * 4, num_attention_heads=2, num_key_value_heads=1,
        head_dim=4, layer_types=['sliding_attention', 'full_attention'] * 2,
        num_kv_shared_layers=2)
    cases = []
    for batch in (False, True):
        mx.random.seed(0)
        concrete = Attention(config, 1, False)
        shared = Attention(config, 3, True)
        for name in ('q_proj', 'q_norm', 'o_proj'):
            setattr(shared, name, getattr(concrete, name))
        events = []
        for attention in (concrete, shared):
            original = attention.rope
            def observe(x, offset=0, original=original):
                events.append(mx.array(offset).tolist())
                return original(x, offset=offset)
            attention.rope = observe
        cache = BatchKVCache([0, 1]) if batch else KVCache()
        for length in (3, 1):
            expected = mx.array(cache.offset).tolist()
            events.clear()
            inputs = mx.random.normal((2 if batch else 1, length, 8))
            first = concrete(inputs, 'causal', cache)
            second = shared(inputs, 'causal', cache)
            mx.eval(first, second)
            assert events == [expected] * 3, f'query/key positions drifted: {events} != {expected}'
            assert mx.allclose(first, second, atol=1e-5).item(), 'shared attention differs from its concrete source'
            cases.append({'batched': batch, 'chunk_length': length, 'query_offset': expected})
    return {'text_prefill_scale': 'pass', 'shared_and_concrete_positions': 'pass', 'cases': cases}


if __name__ == '__main__':
    print(json.dumps(check(), indent=2))
