"""Check installed Gemma3n padding without model weights or inference."""
import os
from unittest.mock import patch

import mlx.core as mx
import numpy as np
from transformers import Gemma3nAudioFeatureExtractor

from mlx_vlm.models.gemma3n.gemma3n import _align_gemma3n_audio_features
from mlx_vlm.models.gemma3n.processing_gemma3n import _extract_gemma3n_audio


def main():
    extractor = Gemma3nAudioFeatureExtractor(padding_side="right")
    audio = np.linspace(-0.25, 0.25, 3200, dtype=np.float32)
    original = audio.copy()
    with patch.dict(os.environ, {"MLX_VLM_GEMMA3N_AUDIO_PADDING": "model"}):
        baseline = _extract_gemma3n_audio(extractor, [audio], {})
    with patch.dict(os.environ, {"MLX_VLM_GEMMA3N_AUDIO_PADDING": "encoded-left"}):
        encoded_left = _extract_gemma3n_audio(extractor, [audio], {})
        for key in ("input_features", "input_features_mask"):
            assert np.array_equal(baseline[key], encoded_left[key]), key
        assert np.array_equal(audio, original) and extractor.padding_side == "right"
        try:
            _extract_gemma3n_audio(extractor, [np.zeros(480001, dtype=np.float32)], {})
        except ValueError as error:
            assert "at most 30 seconds" in str(error)
        else:
            raise AssertionError("Oversized audio was accepted or truncated")
    features = mx.array([[[10, 11], [90, 91], [20, 21]], [[30, 31], [40, 41], [80, 81]]])
    mask = mx.array([[False, True, False], [False, False, True]])
    padding = mx.array([[[0, 1]]])
    result = _align_gemma3n_audio_features(features, mask, 4, padding)
    assert result.tolist() == [[[0, 1], [0, 1], [10, 11], [20, 21]], [[0, 1], [0, 1], [30, 31], [40, 41]]]
    assert _align_gemma3n_audio_features(features, mask, 2, padding).tolist() == [[[10, 11], [20, 21]], [[30, 31], [40, 41]]]
    try:
        _align_gemma3n_audio_features(features, mx.ones(mask.shape, dtype=mx.bool_), 4, padding)
    except ValueError as error:
        assert "no valid frames" in str(error)
    else:
        raise AssertionError("All-padding recordings were accepted")
    print("Gemma3n audio padding: waveform/mel/mask unchanged; valid frames aligned per recording; oversize rejected")


if __name__ == "__main__":
    main()
