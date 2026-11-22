import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ApiError, transcribeSongLyrics } from "../src/lib/api.ts";
import { applyTranscriptionDraft, type EditableLyricLine, type TranscriptionDraftResult } from "../src/lib/songPackage.ts";
import {
  createInitialTranscribeState,
  executeGenerateLyrics,
  resolvePendingTranscript,
  type TranscribeFlowState,
} from "../src/lib/transcriptionDraft.ts";

test("transcribeSongLyrics posts same-origin request without uploading audio or arbitrary URLs", async () => {
  const originalFetch = globalThis.fetch;
  const captured: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    captured.push({ url, init });
    return new Response(
      JSON.stringify({
        data: {
          songId: "song-123",
          model: "@cf/openai/whisper-large-v3-turbo",
          language: "en",
          hasTimestamps: true,
          lines: [{ text: "First verse", startMs: 500, endMs: 3200 }],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const result = await transcribeSongLyrics("song-123", "en");
    assert.equal(captured[0]?.url, "/api/songs/song-123/lyrics/transcribe");
    assert.equal(captured[0]?.init?.method, "POST");
    assert.equal(captured[0]?.init?.credentials, "include");
    assert.equal(captured[0]?.init?.body, JSON.stringify({ language: "en" }));
    assert.equal(result.hasTimestamps, true);
    assert.equal(result.lines[0]?.text, "First verse");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("generate lyrics action tracks loading state and inserts editable draft directly when builder is empty", async () => {
  const states: TranscribeFlowState[] = [];
  let lyrics: EditableLyricLine[] = [];

  const untimedResponse: TranscriptionDraftResult = {
    songId: "song-1",
    model: "@cf/openai/whisper-large-v3-turbo",
    language: "en",
    hasTimestamps: false,
    lines: [
      { text: "Line one", startMs: null, endMs: null },
      { text: "Line two", startMs: null, endMs: null },
    ],
  };

  await executeGenerateLyrics({
    existingLyrics: lyrics,
    transcribe: async () => untimedResponse,
    onState: (next) => states.push(next),
    onReplaceLyrics: (next) => {
      lyrics = next;
    },
  });

  assert.equal(states[0]?.busy, true);
  assert.equal(states[1]?.busy, false);
  assert.equal(states[1]?.error, "");
  assert.equal(states[1]?.pendingDraft, null);
  assert.match(states[1]?.notice ?? "", /without timestamps/);
  assert.equal(lyrics.length, 2);
  assert.deepEqual(
    lyrics.map((l) => ({ text: l.text, startMs: l.startMs, endMs: l.endMs })),
    [
      { text: "Line one", startMs: null, endMs: null },
      { text: "Line two", startMs: null, endMs: null },
    ],
  );
});

test("generate lyrics error state leaves existing manual lyrics untouched", async () => {
  const manualLyrics: EditableLyricLine[] = [
    { id: "m1", text: "Hand-typed chorus", startMs: 1000, endMs: 4000 },
  ];
  let currentLyrics = manualLyrics;
  const states: TranscribeFlowState[] = [];

  await executeGenerateLyrics({
    existingLyrics: currentLyrics,
    transcribe: async () => {
      throw new ApiError(429, {
        error: {
          code: "AI_QUOTA_EXCEEDED",
          message: "Workers AI transcription quota or rate limit was reached.",
        },
      });
    },
    onState: (next) => states.push(next),
    onReplaceLyrics: (next) => {
      currentLyrics = next;
    },
  });

  assert.equal(currentLyrics, manualLyrics);
  assert.equal(states[0]?.busy, true);
  assert.equal(states[1]?.busy, false);
  assert.match(states[1]?.error ?? "", /quota or rate limit/);
  assert.equal(states[1]?.pendingDraft, null);
});

test("existing manual lyrics are preserved until admin chooses append or replace", async () => {
  const manualLyrics: EditableLyricLine[] = [
    { id: "manual-1", text: "Existing intro", startMs: 0, endMs: 2500 },
  ];
  const generated: TranscriptionDraftResult = {
    songId: "song-2",
    model: "@cf/openai/whisper-large-v3-turbo",
    language: "en",
    hasTimestamps: true,
    lines: [{ text: "Transcribed verse", startMs: 3000, endMs: 7000 }],
  };

  let state = createInitialTranscribeState();
  let currentLyrics = manualLyrics;
  await executeGenerateLyrics({
    existingLyrics: currentLyrics,
    transcribe: async () => generated,
    onState: (next) => {
      state = next;
    },
    onReplaceLyrics: (next) => {
      currentLyrics = next;
    },
  });

  assert.deepEqual(currentLyrics, manualLyrics);
  assert.ok(state.pendingDraft);

  const appended = resolvePendingTranscript({
    existingLyrics: currentLyrics,
    pendingDraft: state.pendingDraft,
    mode: "append",
  });
  assert.equal(appended.lyrics.length, 2);
  assert.equal(appended.lyrics[0]?.text, "Existing intro");
  assert.equal(appended.lyrics[1]?.text, "Transcribed verse");
  assert.equal(appended.lyrics[1]?.startMs, 3000);
  assert.equal(appended.lyrics[1]?.endMs, 7000);

  const replaced = applyTranscriptionDraft(manualLyrics, generated.lines, "replace");
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0]?.text, "Transcribed verse");
});

test("ScoringPackageBuilder keeps manual review and honest lyrics-only pitch-scoring notice", async () => {
  const source = await readFile(
    join(process.cwd(), "src/components/ScoringPackageBuilder.tsx"),
    "utf8",
  );
  assert.match(source, /Generate lyrics from audio/);
  assert.match(source, /Pitch scoring is not available for lyrics-only packages\./);
  assert.match(source, /onResolvePendingTranscript\("append"\)/);
  assert.match(source, /onResolvePendingTranscript\("replace"\)/);
});
