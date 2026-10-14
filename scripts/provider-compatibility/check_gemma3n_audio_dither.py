"""Check installed Gemma3n signal dither without weights or inference."""
import copy
import os
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import numpy as np
from transformers import Gemma3nAudioFeatureExtractor

from mlx_vlm.models.gemma3n.processing_gemma3n import _extract_gemma3n_audio


def same_rng(first, second):
    return first[0] == second[0] and np.array_equal(first[1], second[1]) and first[2:] == second[2:]


def main():
    extractor = Gemma3nAudioFeatureExtractor(padding_side="right")
    audio = np.linspace(-0.25, 0.25, 6400, dtype=np.float32)
    original = audio.copy()
    with patch.dict(os.environ, {"MLX_VLM_GEMMA3N_AUDIO_PADDING": "encoded-left", "MLX_VLM_GEMMA3N_AUDIO_DITHER": "0"}):
        baseline = _extract_gemma3n_audio(extractor, [audio], {})
    reference = copy.copy(extractor)
    reference.dither = 1e-4
    state = np.random.get_state()
    try:
        np.random.seed(0)
        expected = reference([audio], max_length=480000, truncation=False, return_attention_mask=True)
    finally:
        np.random.set_state(state)
    with patch.dict(os.environ, {"MLX_VLM_GEMMA3N_AUDIO_PADDING": "encoded-left", "MLX_VLM_GEMMA3N_AUDIO_DITHER": "1"}):
        with ThreadPoolExecutor(max_workers=2) as workers:
            outputs = list(workers.map(lambda _: _extract_gemma3n_audio(extractor, [audio], {}), range(4)))
        assert same_rng(state, np.random.get_state()), "Global RNG changed"
        for output in outputs:
            for key in ("input_features", "input_features_mask"):
                assert np.array_equal(output[key], expected[key]), key
        assert np.array_equal(baseline["input_features_mask"], outputs[0]["input_features_mask"])
        assert not np.array_equal(baseline["input_features"], outputs[0]["input_features"])
        assert np.array_equal(audio, original) and extractor.dither == 0.0
        assert extractor.padding_side == "right" and "_extract_spectrogram" not in vars(extractor)
        try:
            _extract_gemma3n_audio(extractor, [np.zeros(480001, dtype=np.float32)], {})
        except ValueError as error:
            assert "at most 30 seconds" in str(error)
        else:
            raise AssertionError("Dither silently truncated oversized audio")
    with patch.dict(os.environ, {"MLX_VLM_GEMMA3N_AUDIO_DITHER": "0", "MLX_VLM_GEMMA3N_AUDIO_PADDING": "encoded-left"}):
        restored = _extract_gemma3n_audio(extractor, [audio], {})
        assert np.array_equal(restored["input_features"], baseline["input_features"])
    print("Gemma3n dither: upstream seed-0 signal equivalent; repeat/concurrent calls preserve input, processor, mask and global RNG; default and capacity preserved")


if __name__ == "__main__":
    main()
