import { describe, expect, it } from "vitest";
import {
  MAX_VIDEO_FRAMES,
  VIDEO_NO_AUDIO_NOTE,
  canPreprocessVideoForAnswering,
  formatFrameLabel,
  formatTranscriptInsert,
  frameTimestamps,
  preprocessStatus,
} from "./mediaPreprocessing";

describe("mediaPreprocessing", () => {
  it("caps sampled frames at four", () => {
    expect(MAX_VIDEO_FRAMES).toBe(4);
    expect(frameTimestamps(60, 99)).toHaveLength(4);
    expect(frameTimestamps(10, 4)).toHaveLength(4);
    expect(frameTimestamps(0, 4)).toEqual([]);
    expect(frameTimestamps(Number.NaN, 4)).toEqual([]);
  });

  it("spaces frame plans evenly inside the duration", () => {
    const stamps = frameTimestamps(10, 4);
    expect(stamps[0]).toBeGreaterThan(0);
    expect(stamps[3]).toBeLessThan(10);
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
  });

  it("labels transcript inserts with source session and truncation", () => {
    const insert = formatTranscriptInsert("note.wav", "whisper-small", " hello ", false);
    expect(insert).toContain("note.wav");
    expect(insert).toContain("whisper-small");
    expect(insert).toContain("hello");
    expect(insert).not.toContain("truncated");
    expect(formatTranscriptInsert("a.mp3", "s", "text", true)).toContain("truncated");
    expect(formatTranscriptInsert("b.wav", "s", "   ", false)).toContain("empty transcript");
  });

  it("labels video frames with index timing and no-audio note", () => {
    const label = formatFrameLabel("clip.mp4", 0, 4, 2.5);
    expect(label).toContain("1/4");
    expect(label).toContain("clip.mp4");
    expect(label).toContain("2.5s");
    expect(label).toContain(VIDEO_NO_AUDIO_NOTE);
    expect(formatFrameLabel("clip.mp4", 3, 4, null)).toContain("4/4");
  });

  it("gates video preprocessing on image-capable answering models", () => {
    expect(canPreprocessVideoForAnswering({ text: true, image: true })).toBe(true);
    expect(canPreprocessVideoForAnswering({ text: true })).toBe(false);
    expect(canPreprocessVideoForAnswering(null)).toBe(false);
    expect(canPreprocessVideoForAnswering(undefined)).toBe(false);
  });

  it("describes preprocessing states without claiming native understanding", () => {
    expect(preprocessStatus("audio", "working")).toContain("Transcribing");
    expect(preprocessStatus("video", "working")).toContain("Sampling");
    expect(preprocessStatus("video", "idle")).toContain("Sample frames");
    expect(preprocessStatus("audio", "ready")).toContain("Transcript");
  });
});
