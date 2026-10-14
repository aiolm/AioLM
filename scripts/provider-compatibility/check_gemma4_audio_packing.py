"""Check installed Gemma4 audio embedding placement without loading weights.

Two synthetic recordings have different valid lengths. The real model method
must keep encoder padding out of the next recording's language-model slots.
Run with the selected MLX runtime's Python; no inference or network is used.
"""
import json
from types import SimpleNamespace

import mlx.core as mx
from mlx_vlm.models.gemma4.gemma4 import Model


def check():
    tokens = mx.array([[1, 99, 99, 2, 99, 99, 99]])
    features = mx.array([
        [[10, 11], [20, 21], [90, 91]],
        [[30, 31], [40, 41], [50, 51]],
    ], dtype=mx.float32)
    padding = mx.array([[False, False, True], [False, False, False]])
    # The language and encoder stubs supply deterministic data only. Placement
    # still executes the installed production get_input_embeddings method.
    model = SimpleNamespace(
        config=SimpleNamespace(image_token_id=98, audio_token_id=99),
        language_model=SimpleNamespace(model=SimpleNamespace(
            embed_tokens=lambda ids: mx.zeros((*ids.shape, 2)),
            embed_scale=1.0, hidden_size_per_layer_input=0,
        )),
        audio_tower=lambda value, mask: (value, mask),
        embed_audio=lambda value: value,
    )
    actual = Model.get_input_embeddings(
        model, tokens, audio_features=features, audio_mask=padding,
    ).inputs_embeds.tolist()[0]
    expected = [[0, 0], [10, 11], [20, 21], [0, 0], [30, 31], [40, 41], [50, 51]]
    print(json.dumps({"actual_embeddings": actual, "expected_embeddings": expected}))
    assert actual == expected, "encoder padding replaced the next recording's audio embeddings"


if __name__ == "__main__":
    check()
