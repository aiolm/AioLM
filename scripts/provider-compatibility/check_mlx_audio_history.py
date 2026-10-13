"""Check audio ownership using the installed MLX normalizer and prompt builder.

Run with the selected runtime's Python. No model, weights, network or generated
answer is used; this checks the actual server preprocessing functions.
"""
import json
from mlx_vlm.prompt_utils import apply_chat_template
from mlx_vlm.server.request_normalization import _chat_message_to_prompt


def check():
    messages = [
        {"role": "user", "content": [{"type": "text", "text": "First recording"}, {"type": "input_audio", "input_audio": {"data": "synthetic-first", "format": "wav"}}]},
        {"role": "assistant", "content": "Ready"},
        {"role": "user", "content": [{"type": "text", "text": "Second recording"}, {"type": "input_audio", "input_audio": {"data": "synthetic-second", "format": "wav"}}]},
    ]
    normalized = [_chat_message_to_prompt(message) for message in messages]
    formatted = apply_chat_template(None, {"model_type": "gemma4"}, normalized, num_audios=2, return_messages=True)
    counts = [sum(item.get("type") == "audio" for item in message["content"] if isinstance(item, dict)) if isinstance(message["content"], list) else 0 for message in formatted]
    print(json.dumps({"audio_markers_per_message": counts, "expected": [1, 0, 1]}))
    assert counts == [1, 0, 1], "audio inputs were moved away from their originating message"
    legacy = apply_chat_template(None, {"model_type": "gemma4"}, [{"role": "user", "content": "Side-channel recording"}], num_audios=1, return_messages=True)
    assert sum(part.get("type") == "audio" for part in legacy[0]["content"]) == 1
    assert formatted[1]["content"] == "Ready"


if __name__ == "__main__":
    check()
