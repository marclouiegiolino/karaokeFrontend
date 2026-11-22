import {
  applyTranscriptionDraft,
  type EditableLyricLine,
  type TranscriptionDraftResult,
} from "./songPackage.ts";

export type TranscribeFlowState = {
  busy: boolean;
  error: string;
  notice: string;
  pendingDraft: TranscriptionDraftResult | null;
};

export function createInitialTranscribeState(): TranscribeFlowState {
  return {
    busy: false,
    error: "",
    notice: "",
    pendingDraft: null,
  };
}

export async function executeGenerateLyrics(params: {
  existingLyrics: readonly EditableLyricLine[];
  transcribe: () => Promise<TranscriptionDraftResult>;
  onState: (next: TranscribeFlowState) => void;
  onReplaceLyrics: (next: EditableLyricLine[]) => void;
}): Promise<void> {
  params.onState({
    busy: true,
    error: "",
    notice: "",
    pendingDraft: null,
  });

  try {
    const result = await params.transcribe();
    if (!result.lines.length) {
      params.onState({
        busy: false,
        error: "No sung lyrics were returned from this audio. Enter lyrics manually.",
        notice: "",
        pendingDraft: null,
      });
      return;
    }

    if (params.existingLyrics.length > 0) {
      params.onState({
        busy: false,
        error: "",
        notice: `Generated ${result.lines.length} lyric line(s) from audio. Choose Replace or Append below so your existing lyrics stay safe.`,
        pendingDraft: result,
      });
      return;
    }

    const nextLyrics = applyTranscriptionDraft([], result.lines, "replace");
    params.onReplaceLyrics(nextLyrics);
    params.onState({
      busy: false,
      error: "",
      notice: result.hasTimestamps
        ? `Generated ${nextLyrics.length} editable lyric line(s) with model timestamps (${result.model}). Review and verify timings before publishing.`
        : `Generated ${nextLyrics.length} editable lyric line(s) without timestamps (${result.model}). Use the timeline controls below to set start/end times.`,
      pendingDraft: null,
    });
  } catch (err) {
    params.onState({
      busy: false,
      error:
        err instanceof Error
          ? err.message
          : "Could not generate lyrics from audio. You can still edit or enter lyrics manually.",
      notice: "",
      pendingDraft: null,
    });
  }
}

export function resolvePendingTranscript(params: {
  existingLyrics: readonly EditableLyricLine[];
  pendingDraft: TranscriptionDraftResult;
  mode: "replace" | "append";
}): {
  lyrics: EditableLyricLine[];
  notice: string;
} {
  const next = applyTranscriptionDraft(
    params.existingLyrics,
    params.pendingDraft.lines,
    params.mode,
  );
  const actionLabel = params.mode === "replace" ? "Replaced" : "Appended";
  return {
    lyrics: next,
    notice: params.pendingDraft.hasTimestamps
      ? `${actionLabel} draft with ${params.pendingDraft.lines.length} line(s) including model timestamps. Review and verify timings before publishing.`
      : `${actionLabel} draft with ${params.pendingDraft.lines.length} line(s) without timestamps. Set start/end times before publishing.`,
  };
}
