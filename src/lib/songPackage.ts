export const MAX_PACKAGE_BYTES = 1_000_000;
export const MAX_LYRIC_LINES = 5000;
export const MAX_LYRIC_TEXT_LENGTH = 500;
export const MAX_NOTE_COUNT = 20_000;
export const MIN_SONG_DURATION_MS = 1000;
export const MAX_SONG_DURATION_MS = 1_800_000;

export type LyricLine = {
  startMs: number;
  endMs: number;
  text: string;
};

export type TargetNote = {
  startMs: number;
  endMs: number;
  midiNote: number;
};

export type SongPackage = {
  formatVersion: 1;
  packageVersion: number;
  durationMs: number;
  lyrics: LyricLine[];
  notes: TargetNote[];
};

export type EditableLyricLine = {
  id: string;
  startMs: number | null;
  endMs: number | null;
  text: string;
};

export type EditableTargetNote = {
  id: string;
  startMs: number | null;
  endMs: number | null;
  midiNote: number | null;
};

const utf8Encoder = new TextEncoder();
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createRowId(prefix = "row"): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function formatTimeMs(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const minutes = Math.floor(safe / 60000);
  const seconds = Math.floor((safe % 60000) / 1000);
  const centis = Math.floor((safe % 1000) / 10);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
}

export function midiNoteLabel(midiNote: number): string {
  if (!Number.isSafeInteger(midiNote) || midiNote < 0 || midiNote > 127) return "Invalid";
  const name = NOTE_NAMES[midiNote % 12];
  const octave = Math.floor(midiNote / 12) - 1;
  return `${name}${octave} (${midiNote})`;
}

export function parseLyricsBlock(rawText: string): EditableLyricLine[] {
  return rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((text, index) => ({
      id: createRowId(`lyric-${index}`),
      startMs: null,
      endMs: null,
      text,
    }));
}

export function findActiveLyricIndex(lyrics: readonly LyricLine[], positionMs: number): number {
  for (let i = 0; i < lyrics.length; i++) {
    const line = lyrics[i]!;
    if (positionMs >= line.startMs && positionMs < line.endMs) return i;
  }
  return -1;
}

export function validateSongPackage(
  raw: unknown,
): { ok: true; data: SongPackage } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isPlainRecord(raw)) {
    return { ok: false, errors: ["Package must be a JSON object."] };
  }

  const keys = Object.keys(raw);
  const allowedTopKeys = new Set(["formatVersion", "packageVersion", "durationMs", "lyrics", "notes"]);
  for (const key of keys) {
    if (!allowedTopKeys.has(key)) errors.push(`Unknown package field: "${key}".`);
  }

  const { formatVersion, packageVersion, durationMs, lyrics, notes } = raw;
  if (formatVersion !== 1) errors.push("formatVersion must be 1.");
  if (!Number.isSafeInteger(packageVersion) || (packageVersion as number) <= 0) {
    errors.push("packageVersion must be a positive integer.");
  }
  if (!Number.isSafeInteger(durationMs) || (durationMs as number) <= 0) {
    errors.push("durationMs must be a positive integer.");
  }
  const dur = Number.isSafeInteger(durationMs) && (durationMs as number) > 0 ? (durationMs as number) : 0;

  if (!Array.isArray(lyrics)) {
    errors.push("lyrics must be an array.");
  } else {
    if (lyrics.length < 1 || lyrics.length > MAX_LYRIC_LINES) {
      errors.push(`lyrics must contain between 1 and ${MAX_LYRIC_LINES} lines.`);
    }
    let previousEnd = 0;
    for (let i = 0; i < lyrics.length; i++) {
      const item = lyrics[i];
      if (!isPlainRecord(item)) {
        errors.push(`Lyric line ${i + 1}: must be an object.`);
        continue;
      }
      const itemKeys = Object.keys(item);
      if (
        itemKeys.length !== 3 ||
        !("startMs" in item) ||
        !("endMs" in item) ||
        !("text" in item)
      ) {
        errors.push(`Lyric line ${i + 1}: must contain only startMs, endMs, and text.`);
        continue;
      }
      const { startMs, endMs, text } = item;
      if (typeof text !== "string" || text.length < 1 || text.length > MAX_LYRIC_TEXT_LENGTH) {
        errors.push(`Lyric line ${i + 1}: text must be 1 to ${MAX_LYRIC_TEXT_LENGTH} characters.`);
      }
      if (!Number.isSafeInteger(startMs) || (startMs as number) < 0) {
        errors.push(`Lyric line ${i + 1}: startMs must be a non-negative integer.`);
      }
      if (!Number.isSafeInteger(endMs) || (endMs as number) <= 0) {
        errors.push(`Lyric line ${i + 1}: endMs must be a positive integer.`);
      }
      if (Number.isSafeInteger(startMs) && Number.isSafeInteger(endMs)) {
        const s = startMs as number;
        const e = endMs as number;
        if (e <= s) {
          errors.push(`Lyric line ${i + 1}: endMs (${e}) must be greater than startMs (${s}).`);
        } else if (dur > 0 && e > dur) {
          errors.push(`Lyric line ${i + 1}: endMs (${e}) exceeds song durationMs (${dur}).`);
        } else if (s < previousEnd) {
          errors.push(
            `Lyric line ${i + 1}: startMs (${s}) overlaps or precedes the previous line's endMs (${previousEnd}).`,
          );
        }
        previousEnd = e;
      }
    }
  }

  if (!Array.isArray(notes)) {
    errors.push("notes must be an array.");
  } else {
    if (notes.length > MAX_NOTE_COUNT) {
      errors.push(`notes cannot exceed ${MAX_NOTE_COUNT} entries.`);
    }
    let previousEnd = 0;
    for (let i = 0; i < notes.length; i++) {
      const item = notes[i];
      if (!isPlainRecord(item)) {
        errors.push(`Target note ${i + 1}: must be an object.`);
        continue;
      }
      const itemKeys = Object.keys(item);
      if (
        itemKeys.length !== 3 ||
        !("startMs" in item) ||
        !("endMs" in item) ||
        !("midiNote" in item)
      ) {
        errors.push(`Target note ${i + 1}: must contain only startMs, endMs, and midiNote.`);
        continue;
      }
      const { startMs, endMs, midiNote } = item;
      if (!Number.isSafeInteger(midiNote) || (midiNote as number) < 0 || (midiNote as number) > 127) {
        errors.push(`Target note ${i + 1}: midiNote must be an integer between 0 and 127.`);
      }
      if (!Number.isSafeInteger(startMs) || (startMs as number) < 0) {
        errors.push(`Target note ${i + 1}: startMs must be a non-negative integer.`);
      }
      if (!Number.isSafeInteger(endMs) || (endMs as number) <= 0) {
        errors.push(`Target note ${i + 1}: endMs must be a positive integer.`);
      }
      if (Number.isSafeInteger(startMs) && Number.isSafeInteger(endMs)) {
        const s = startMs as number;
        const e = endMs as number;
        if (e <= s) {
          errors.push(`Target note ${i + 1}: endMs (${e}) must be greater than startMs (${s}).`);
        } else if (dur > 0 && e > dur) {
          errors.push(`Target note ${i + 1}: endMs (${e}) exceeds song durationMs (${dur}).`);
        } else if (s < previousEnd) {
          errors.push(
            `Target note ${i + 1}: startMs (${s}) overlaps or precedes the previous note's endMs (${previousEnd}).`,
          );
        }
        previousEnd = e;
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const byteSize = utf8Encoder.encode(JSON.stringify(raw)).byteLength;
  if (byteSize > MAX_PACKAGE_BYTES) {
    return {
      ok: false,
      errors: [`Serialized package size (${byteSize} bytes) exceeds 1 MB limit.`],
    };
  }
  return { ok: true, data: raw as SongPackage };
}

export function buildSongPackage(input: {
  durationMs: number;
  packageVersion?: number;
  lyrics: readonly EditableLyricLine[];
  notes?: readonly EditableTargetNote[];
}): { pkg?: SongPackage; byteSize?: number; errors: string[] } {
  const errors: string[] = [];
  const packageVersion = input.packageVersion ?? 1;
  if (!Number.isSafeInteger(input.durationMs) || input.durationMs < MIN_SONG_DURATION_MS || input.durationMs > MAX_SONG_DURATION_MS) {
    errors.push("Set a valid song duration between 1 second and 30 minutes before building.");
  }
  if (!Number.isSafeInteger(packageVersion) || packageVersion <= 0) {
    errors.push("packageVersion must be a positive integer.");
  }

  if (input.lyrics.length === 0) {
    errors.push("Add at least one timed lyric line.");
  }

  const builtLyrics: LyricLine[] = [];
  for (let i = 0; i < input.lyrics.length; i++) {
    const row = input.lyrics[i]!;
    const trimmed = row.text.trim();
    if (!trimmed) {
      errors.push(`Lyric line ${i + 1}: enter lyric text.`);
    }
    if (row.startMs === null || row.endMs === null) {
      errors.push(`Lyric line ${i + 1}: set both start and end times.`);
    }
    if (trimmed && row.startMs !== null && row.endMs !== null) {
      builtLyrics.push({ startMs: row.startMs, endMs: row.endMs, text: trimmed });
    }
  }

  const noteRows = input.notes ?? [];
  const builtNotes: TargetNote[] = [];
  for (let i = 0; i < noteRows.length; i++) {
    const row = noteRows[i]!;
    if (row.startMs === null || row.endMs === null || row.midiNote === null) {
      errors.push(`Target note ${i + 1}: set startMs, endMs, and midiNote (0–127).`);
    } else {
      builtNotes.push({ startMs: row.startMs, endMs: row.endMs, midiNote: row.midiNote });
    }
  }

  if (errors.length > 0) return { errors };

  const candidate: SongPackage = {
    formatVersion: 1,
    packageVersion,
    durationMs: input.durationMs,
    lyrics: builtLyrics,
    notes: builtNotes,
  };
  const checked = validateSongPackage(candidate);
  if (!checked.ok) return { errors: checked.errors };
  const byteSize = utf8Encoder.encode(JSON.stringify(checked.data)).byteLength;
  return { pkg: checked.data, byteSize, errors: [] };
}

export function parseNotesJsonImport(
  rawText: string,
): { notes?: EditableTargetNote[]; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { error: "Target notes import must be valid JSON." };
  }
  const list = isPlainRecord(parsed) && "notes" in parsed ? parsed.notes : parsed;
  if (!Array.isArray(list)) {
    return { error: 'Expected a JSON array of { "startMs", "endMs", "midiNote" } notes.' };
  }
  if (list.length > MAX_NOTE_COUNT) {
    return { error: `Imported notes exceed maximum of ${MAX_NOTE_COUNT}.` };
  }
  const rows: EditableTargetNote[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!isPlainRecord(item)) {
      return { error: `Note ${i + 1} must be an object.` };
    }
    const keys = Object.keys(item);
    if (keys.length !== 3 || !("startMs" in item) || !("endMs" in item) || !("midiNote" in item)) {
      return { error: `Note ${i + 1} must contain only startMs, endMs, and midiNote.` };
    }
    if (
      !Number.isSafeInteger(item.startMs) ||
      !Number.isSafeInteger(item.endMs) ||
      !Number.isSafeInteger(item.midiNote)
    ) {
      return { error: `Note ${i + 1} fields must all be integers.` };
    }
    rows.push({
      id: createRowId(`note-${i}`),
      startMs: item.startMs as number,
      endMs: item.endMs as number,
      midiNote: item.midiNote as number,
    });
  }
  return { notes: rows };
}

export function serializePackageBytes(pkg: SongPackage): Uint8Array {
  return utf8Encoder.encode(JSON.stringify(pkg));
}

export type TranscriptionLine = {
  text: string;
  startMs: number | null;
  endMs: number | null;
};

export type TranscriptionDraftResult = {
  songId: string;
  model: string;
  language: string | null;
  hasTimestamps: boolean;
  lines: TranscriptionLine[];
};

export function transcriptionLinesToEditable(
  lines: readonly TranscriptionLine[],
): EditableLyricLine[] {
  return lines
    .map((line) => ({
      id: createRowId("lyric-ai"),
      text: line.text.trim(),
      startMs: line.startMs,
      endMs: line.endMs,
    }))
    .filter((line) => line.text.length > 0);
}

export function applyTranscriptionDraft(
  existingLyrics: readonly EditableLyricLine[],
  incomingLines: readonly TranscriptionLine[],
  mode: "replace" | "append",
): EditableLyricLine[] {
  const generated = transcriptionLinesToEditable(incomingLines);
  if (mode === "replace") return generated;
  return [...existingLyrics.map((row) => ({ ...row })), ...generated];
}
