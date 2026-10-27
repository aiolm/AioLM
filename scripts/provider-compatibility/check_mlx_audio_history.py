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
    ordered_cases = []
    for model in ("gemma3n", "gemma4"):
        for kinds in (("audio", "text"), ("text", "audio"), ("image", "audio", "text", "audio")):
            content = [{"type": kind, "text": "Synthetic question"} if kind == "text" else {"type": kind}
                       for kind in kinds]
            message = _chat_message_to_prompt({"role": "user", "content": content})
            result = apply_chat_template(None, {"model_type": model}, [message],
                                        num_audios=kinds.count("audio"), num_images=kinds.count("image"),
                                        return_messages=True)
            actual = tuple(part["type"] for part in result[0]["content"])
            assert actual == kinds, f"{model} moved or duplicated ordered media: {actual} != {kinds}"
            ordered_cases.append({"model": model, "parts": actual})
        # Only implicit side-channel audio follows the legacy append policy.
        message = {"role": "user", "content": [{"type": "audio"}, {"type": "text", "text": "Synthetic question"}]}
        result = apply_chat_template(None, {"model_type": model}, [message], num_audios=2, return_messages=True)
        assert [part["type"] for part in result[0]["content"]] == ["audio", "text", "audio"]
        try:
            apply_chat_template(None, {"model_type": model}, [message], num_audios=0, return_messages=True)
        except ValueError as error:
            assert str(error) == "Audio markers exceed the supplied audio inputs"
        else:
            raise AssertionError("Missing side-channel audio must remain an error")
    print(json.dumps({"ordered_audio_and_images": ordered_cases, "implicit_audio_append": "pass"}))


if __name__ == "__main__":
    check()
