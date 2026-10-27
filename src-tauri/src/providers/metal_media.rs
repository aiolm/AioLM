//! Metal-native media policy: what vllm-metal v0.30.0 actually serves.
//!
//! Pinned evidence:
//! - `docs/supported_models.md`: native multimodal is image-only
//!   (Qwen3-VL, PaddleOCR-VL), no video; text pooling is text-only.
//! - `docs/stt.md`: Whisper serves `/v1/audio/transcriptions` and
//!   `/v1/audio/translations`; Qwen3-ASR serves transcriptions only.
//! - `vllm_metal/stt/detection.py` `_STT_MODEL_TYPES` and `registry.py`
//!   constructors decide the STT model types.
//!
//! Audio/video chat never runs natively on this plugin. The app offers two
//! explicit, labeled routes instead: native transcription sessions (STT
//! task) and app-level chat preprocessing (transcript text for audio,
//! sampled image frames for video) that preserves the selected answering
//! runtime and the original media/history references.
use super::artifacts::Modalities;
use super::catalog_data;

/// Highest sampled stills one video preprocessing may attach. Matches the
/// chat media bound (four media parts per message) so a preprocessed video
/// can travel as ordinary image parts to an image-capable answering model.
pub const MAX_VIDEO_FRAMES: usize = 4;

/// Note appended to every video preprocessing so the answering model cannot
/// mistake sampled stills for native video understanding.
pub const VIDEO_NO_AUDIO_NOTE: &str =
    "sampled frames only; no audio track was transcribed or understood";

/// Whether `model_type` has a native Metal speech-to-text load path.
pub fn is_metal_transcription_model(model_type: &str) -> bool {
    catalog_data::VLLM_METAL_TRANSCRIPTION_MODEL_TYPES.contains(&model_type)
}

/// Whether `model_type` serves translation as well as transcription.
/// Only Whisper does; Qwen3-ASR is transcription-only.
pub fn supports_translation(model_type: &str) -> bool {
    catalog_data::VLLM_METAL_TRANSLATION_MODEL_TYPES.contains(&model_type)
}

/// Tasks a Metal STT checkpoint serves, in gateway order.
pub fn transcription_tasks(model_type: &str) -> Vec<&'static str> {
    if !is_metal_transcription_model(model_type) {
        return Vec::new();
    }
    if supports_translation(model_type) {
        vec!["transcription", "translate"]
    } else {
        vec!["transcription"]
    }
}

/// Whether the answering session can receive preprocessed video frames.
/// Frames travel as ordinary image parts, so only image-capable answering
/// models qualify; the STT session itself is never the answering session.
pub fn answering_supports_video_frames(modalities: Modalities) -> bool {
    modalities.image
}

/// Evenly spaced sample timestamps for a known `duration_secs`.
/// Returns at most `MAX_VIDEO_FRAMES` stamps in `(0, duration]`; unknown or
/// nonpositive durations yield no plan. Production extraction uses decoded
/// presentation times rather than treating this optional plan as observations.
pub fn frame_timestamps(duration_secs: f64, max_frames: usize) -> Vec<f64> {
    if !duration_secs.is_finite() || duration_secs <= 0.0 {
        return Vec::new();
    }
    let count = max_frames.clamp(1, MAX_VIDEO_FRAMES);
    (1..=count)
        .map(|index| duration_secs * index as f64 / (count as f64 + 1.0))
        .collect()
}

/// Labeled transcript text inserted into chat for audio preprocessing.
/// Names the source attachment and the transcription session so the
/// transcript is never mistaken for native audio understanding. The
/// original audio reference stays in history; only this text is sent.
pub fn format_transcript_insert(
    attachment_name: &str,
    session_label: &str,
    transcript: &str,
    truncated: bool,
) -> String {
    let text = transcript.trim();
    let shown = if text.is_empty() {
        "(empty transcript)".to_string()
    } else {
        text.to_string()
    };
    format!(
        "[transcription of {attachment_name} via {session_label}]{truncation}\n{shown}",
        attachment_name = attachment_name.trim(),
        session_label = session_label.trim(),
        truncation = if truncated {
            " (truncated to the transcription limit)"
        } else {
            ""
        },
    )
}

/// Label for one sampled video frame sent as an image part.
pub fn format_frame_label(
    attachment_name: &str,
    index: usize,
    total: usize,
    timestamp_secs: Option<f64>,
) -> String {
    let when = timestamp_secs
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|value| format!(" at {value:.1}s"))
        .unwrap_or_default();
    format!(
        "[frame {index}/{total} of {attachment_name}{when}; {note}]",
        index = index + 1,
        attachment_name = attachment_name.trim(),
        note = VIDEO_NO_AUDIO_NOTE,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcription_tasks_follow_the_pinned_stt_registry() {
        assert_eq!(
            transcription_tasks("whisper"),
            vec!["transcription", "translate"]
        );
        assert_eq!(transcription_tasks("qwen3_asr"), vec!["transcription"]);
        assert!(transcription_tasks("llama").is_empty());
        assert!(transcription_tasks("qwen3_vl").is_empty());
        assert!(is_metal_transcription_model("whisper"));
        assert!(!is_metal_transcription_model("qwen3"));
        assert!(supports_translation("whisper"));
        assert!(!supports_translation("qwen3_asr"));
    }

    #[test]
    fn video_frames_need_an_image_capable_answering_model() {
        assert!(answering_supports_video_frames(Modalities {
            text: true,
            image: true,
            audio: false,
            video: false,
        }));
        assert!(!answering_supports_video_frames(Modalities::text_only()));
        assert!(!answering_supports_video_frames(Modalities::default()));
    }

    #[test]
    fn frame_plans_are_bounded_evenly_spaced_and_total_ordered() {
        assert!(frame_timestamps(0.0, 4).is_empty());
        assert!(frame_timestamps(f64::NAN, 4).is_empty());
        let stamps = frame_timestamps(10.0, 4);
        assert_eq!(stamps.len(), 4);
        assert!(stamps.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(stamps.iter().all(|stamp| *stamp > 0.0 && *stamp < 10.0));
        // More than the bound still yields at most four frames.
        assert_eq!(frame_timestamps(60.0, 99).len(), MAX_VIDEO_FRAMES);
    }

    #[test]
    fn transcript_inserts_name_source_and_truncation() {
        let insert = format_transcript_insert("note.wav", "whisper-small", " hello ", false);
        assert!(insert.contains("note.wav"));
        assert!(insert.contains("whisper-small"));
        assert!(insert.contains("hello"));
        assert!(!insert.contains("truncated"));
        let truncated = format_transcript_insert("a.mp3", "s", "text", true);
        assert!(truncated.contains("truncated"));
        let empty = format_transcript_insert("b.wav", "s", "   ", false);
        assert!(empty.contains("empty transcript"));
    }

    #[test]
    fn frame_labels_carry_index_timing_and_no_audio_note() {
        let label = format_frame_label("clip.mp4", 0, 4, Some(2.5));
        assert!(label.contains("1/4"));
        assert!(label.contains("clip.mp4"));
        assert!(label.contains("2.5s"));
        assert!(label.contains(VIDEO_NO_AUDIO_NOTE));
        let timeless = format_frame_label("clip.mp4", 3, 4, None);
        assert!(timeless.contains("4/4"));
        assert!(timeless.contains(VIDEO_NO_AUDIO_NOTE));
    }
}
