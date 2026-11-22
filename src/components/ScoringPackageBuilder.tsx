"use client";

import { useState } from "react";
import {
  buildSongPackage,
  createRowId,
  EditableLyricLine,
  EditableTargetNote,
  findActiveLyricIndex,
  formatTimeMs,
  midiNoteLabel,
  parseLyricsBlock,
  parseNotesJsonImport,
  validateSongPackage,
} from "@/lib/songPackage";
import styles from "@/app/page.module.css";

type ScoringPackageBuilderProps = {
  durationMs: number;
  hasDuration: boolean;
  hasAudioSource: boolean;
  playheadMs: number;
  lyrics: EditableLyricLine[];
  notes: EditableTargetNote[];
  reviewed: boolean;
  disabled: boolean;
  onChangeLyrics: (next: EditableLyricLine[]) => void;
  onChangeNotes: (next: EditableTargetNote[]) => void;
  onChangeReviewed: (next: boolean) => void;
  onSeekToMs: (ms: number) => void;
};

export function ScoringPackageBuilder({
  durationMs,
  hasDuration,
  hasAudioSource,
  playheadMs,
  lyrics,
  notes,
  reviewed,
  disabled,
  onChangeLyrics,
  onChangeNotes,
  onChangeReviewed,
  onSeekToMs,
}: ScoringPackageBuilderProps) {
  const [lyricsDraftText, setLyricsDraftText] = useState("");
  const [selectedLyricId, setSelectedLyricId] = useState<string | null>(null);
  const [notesImportText, setNotesImportText] = useState("");
  const [notesImportError, setNotesImportError] = useState("");
  const [packageImportText, setPackageImportText] = useState("");
  const [packageImportError, setPackageImportError] = useState("");

  const activeSelectionId =
    selectedLyricId && lyrics.some((l) => l.id === selectedLyricId)
      ? selectedLyricId
      : (lyrics[0]?.id ?? null);

  const buildResult = buildSongPackage({
    durationMs: hasDuration ? durationMs : 0,
    packageVersion: 1,
    lyrics,
    notes,
  });

  const timedLyricsOnly = buildResult.pkg?.lyrics ?? [];
  const activePreviewIndex = findActiveLyricIndex(timedLyricsOnly, playheadMs);

  function updateLyrics(next: EditableLyricLine[]) {
    onChangeLyrics(next);
    if (reviewed) onChangeReviewed(false);
  }

  function updateNotes(next: EditableTargetNote[]) {
    onChangeNotes(next);
    if (reviewed) onChangeReviewed(false);
  }

  function loadLyricsFromBlock(mode: "replace" | "append") {
    const parsed = parseLyricsBlock(lyricsDraftText);
    if (parsed.length === 0) return;
    const next = mode === "replace" ? parsed : [...lyrics, ...parsed];
    updateLyrics(next);
    setSelectedLyricId(parsed[0]!.id);
    if (mode === "replace") setLyricsDraftText("");
  }

  function addBlankLyricRow(afterIndex?: number) {
    const fresh: EditableLyricLine = { id: createRowId("lyric"), startMs: null, endMs: null, text: "" };
    const next = [...lyrics];
    if (afterIndex === undefined) {
      next.push(fresh);
    } else {
      next.splice(afterIndex + 1, 0, fresh);
    }
    updateLyrics(next);
    setSelectedLyricId(fresh.id);
  }

  function moveLyricRow(index: number, delta: -1 | 1) {
    const target = index + delta;
    if (target < 0 || target >= lyrics.length) return;
    const next = [...lyrics];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item!);
    updateLyrics(next);
  }

  function updateLyricField(
    id: string,
    patch: Partial<Pick<EditableLyricLine, "text" | "startMs" | "endMs">>,
  ) {
    updateLyrics(lyrics.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function removeLyricRow(id: string) {
    updateLyrics(lyrics.filter((row) => row.id !== id));
  }

  function stampSelectedStart() {
    if (!activeSelectionId) return;
    updateLyricField(activeSelectionId, { startMs: playheadMs });
  }

  function stampEndAndAdvance() {
    if (!activeSelectionId) return;
    const idx = lyrics.findIndex((row) => row.id === activeSelectionId);
    if (idx === -1) return;
    const next = lyrics.map((row) => ({ ...row }));
    const cur = next[idx]!;
    if (cur.startMs === null) {
      cur.startMs = playheadMs;
      updateLyrics(next);
      return;
    }
    cur.endMs = playheadMs;
    const following = next[idx + 1];
    if (following && following.startMs === null) {
      following.startMs = playheadMs;
    }
    updateLyrics(next);
    if (following) setSelectedLyricId(following.id);
  }

  function addNoteRow() {
    const prevEnd = notes[notes.length - 1]?.endMs ?? 0;
    const fresh: EditableTargetNote = {
      id: createRowId("note"),
      startMs: prevEnd,
      endMs: null,
      midiNote: 60,
    };
    updateNotes([...notes, fresh]);
  }

  function updateNoteField(
    id: string,
    patch: Partial<Pick<EditableTargetNote, "startMs" | "endMs" | "midiNote">>,
  ) {
    updateNotes(notes.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function importNotes() {
    setNotesImportError("");
    const parsed = parseNotesJsonImport(notesImportText);
    if (parsed.error || !parsed.notes) {
      setNotesImportError(parsed.error ?? "Invalid notes JSON.");
      return;
    }
    updateNotes(parsed.notes);
    setNotesImportText("");
  }

  function importFullPackage() {
    setPackageImportError("");
    let raw: unknown;
    try {
      raw = JSON.parse(packageImportText);
    } catch {
      setPackageImportError("Imported package must be valid JSON.");
      return;
    }
    const checked = validateSongPackage(raw);
    if (!checked.ok) {
      setPackageImportError(checked.errors.slice(0, 3).join(" "));
      return;
    }
    if (hasDuration && checked.data.durationMs !== durationMs) {
      setPackageImportError(
        `Imported package durationMs (${checked.data.durationMs} ms) differs from the draft duration (${durationMs} ms). Update Duration (seconds) to ${(checked.data.durationMs / 1000).toString()} or adjust timings.`,
      );
      return;
    }
    const importedLyrics = checked.data.lyrics.map((l, idx) => ({
      id: createRowId(`lyric-imp-${idx}`),
      startMs: l.startMs,
      endMs: l.endMs,
      text: l.text,
    }));
    const importedNotes = checked.data.notes.map((n, idx) => ({
      id: createRowId(`note-imp-${idx}`),
      startMs: n.startMs,
      endMs: n.endMs,
      midiNote: n.midiNote,
    }));
    onChangeLyrics(importedLyrics);
    onChangeNotes(importedNotes);
    onChangeReviewed(false);
    setSelectedLyricId(importedLyrics[0]?.id ?? null);
    setPackageImportText("");
  }

  function parseOptionalInt(value: string): number | null {
    if (!value.trim()) return null;
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
  }

  return (
    <div className={styles.builderBox}>
      <div className={styles.builderHeader}>
        <div>
          <p className={styles.eyebrow}>SCORING PACKAGE BUILDER</p>
          <h3>Timed lyrics &amp; review</h3>
        </div>
        <span className={notes.length > 0 ? styles.adminTag : styles.count}>
          {notes.length > 0 ? `Lyrics + ${notes.length} target notes` : "Timed lyrics only"}
        </span>
      </div>

      <p className={styles.mutedSmall}>
        {notes.length > 0
          ? "Target notes (MIDI 0–127) are included in the generated package. Browser microphone pitch scoring is not implemented in this UI; please verify all lyrics, timings, and notes."
          : "This package contains timed lyrics only (notes: []). Pitch scoring is not available for lyrics-only packages."}
      </p>

      <div className={styles.pasteBlock}>
        <label>
          Paste or type lyrics <span className={styles.optional}>one line per row · timings stay blank until you set them</span>
          <textarea
            rows={4}
            placeholder={"Line one\nLine two\nLine three"}
            value={lyricsDraftText}
            onChange={(e) => setLyricsDraftText(e.target.value)}
            disabled={disabled}
          />
        </label>
        <div className={styles.builderToolbar}>
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={disabled || !lyricsDraftText.trim()}
            onClick={() => loadLyricsFromBlock("replace")}
          >
            Load as lines
          </button>
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={disabled || !lyricsDraftText.trim()}
            onClick={() => loadLyricsFromBlock("append")}
          >
            Append lines
          </button>
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={disabled}
            onClick={() => addBlankLyricRow()}
          >
            + Add empty line
          </button>
        </div>
      </div>

      <div className={styles.timelineBar}>
        <div className={styles.timelineStatus}>
          <strong>Timeline: {formatTimeMs(playheadMs)}</strong>
          <span>
            ({playheadMs} ms{hasDuration ? ` / ${durationMs} ms` : ""})
          </span>
        </div>
        <div className={styles.builderToolbar}>
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={disabled || !hasAudioSource}
            onClick={() => onSeekToMs(Math.max(0, playheadMs - 2000))}
          >
            −2s
          </button>
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={disabled || !hasAudioSource}
            onClick={() => onSeekToMs(playheadMs + 2000)}
          >
            +2s
          </button>
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={disabled || !hasAudioSource || !activeSelectionId}
            onClick={stampSelectedStart}
          >
            Set active start = Now
          </button>
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={disabled || !hasAudioSource || !activeSelectionId}
            onClick={stampEndAndAdvance}
          >
            Mark end &amp; next line
          </button>
        </div>
        {hasDuration && durationMs > 0 && (
          <div className={styles.timelineTrack} aria-label="Lyric timing coverage on song timeline">
            {lyrics.map((row) => {
              if (row.startMs === null || row.endMs === null || row.endMs <= row.startMs) {
                return null;
              }
              const leftPct = Math.max(0, Math.min(100, (row.startMs / durationMs) * 100));
              const widthPct = Math.max(
                0.8,
                Math.min(100 - leftPct, ((row.endMs - row.startMs) / durationMs) * 100),
              );
              return (
                <span
                  key={row.id}
                  className={
                    row.id === activeSelectionId ? styles.timelineSegmentActive : styles.timelineSegment
                  }
                  style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                  title={`${row.text} (${row.startMs}–${row.endMs} ms)`}
                />
              );
            })}
            <span
              className={styles.timelinePlayhead}
              style={{
                left: `${Math.max(0, Math.min(100, (playheadMs / durationMs) * 100))}%`,
              }}
            />
          </div>
        )}
      </div>

      {lyrics.length > 0 && (
        <div className={styles.previewBox} aria-live="polite">
          <span className={styles.previewLabel}>Live lyric preview against audio</span>
          {activePreviewIndex >= 0 ? (
            <strong className={styles.previewActiveLine}>
              {timedLyricsOnly[activePreviewIndex]?.text}
            </strong>
          ) : (
            <span className={styles.mutedSmall}>
              {buildResult.pkg
                ? "No lyric active at current playhead position."
                : "Finish valid start/end timings to preview highlighted lyrics against playback."}
            </span>
          )}
        </div>
      )}

      <div className={styles.lyricRows}>
        {lyrics.length === 0 ? (
          <p className={styles.mutedSmall}>
            No lyric lines yet. Paste lyrics above or click &ldquo;+ Add empty line&rdquo;.
          </p>
        ) : (
          lyrics.map((row, index) => {
            const isSelected = row.id === activeSelectionId;
            return (
              <div
                key={row.id}
                className={`${styles.lyricRow} ${isSelected ? styles.lyricRowSelected : ""}`}
                onClick={() => setSelectedLyricId(row.id)}
              >
                <div className={styles.lyricRowHead}>
                  <span className={styles.rowNumber}>Line {index + 1}</span>
                  <div className={styles.rowActions}>
                    <button
                      type="button"
                      className={styles.miniButton}
                      disabled={disabled || !hasAudioSource || row.startMs === null}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (row.startMs !== null) onSeekToMs(row.startMs);
                      }}
                    >
                      ▶ Seek
                    </button>
                    <button
                      type="button"
                      className={styles.miniButton}
                      disabled={disabled || !hasAudioSource}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedLyricId(row.id);
                        updateLyricField(row.id, { startMs: playheadMs });
                      }}
                    >
                      Start=Now
                    </button>
                    <button
                      type="button"
                      className={styles.miniButton}
                      disabled={disabled || !hasAudioSource}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedLyricId(row.id);
                        updateLyricField(row.id, { endMs: playheadMs });
                      }}
                    >
                      End=Now
                    </button>
                    <button
                      type="button"
                      className={styles.miniButton}
                      disabled={disabled || index === 0}
                      onClick={(e) => {
                        e.stopPropagation();
                        moveLyricRow(index, -1);
                      }}
                      aria-label={`Move line ${index + 1} up`}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className={styles.miniButton}
                      disabled={disabled || index === lyrics.length - 1}
                      onClick={(e) => {
                        e.stopPropagation();
                        moveLyricRow(index, 1);
                      }}
                      aria-label={`Move line ${index + 1} down`}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className={styles.miniButton}
                      disabled={disabled}
                      onClick={(e) => {
                        e.stopPropagation();
                        removeLyricRow(row.id);
                      }}
                      aria-label={`Remove line ${index + 1}`}
                    >
                      ×
                    </button>
                  </div>
                </div>
                <input
                  type="text"
                  placeholder="Lyric text"
                  maxLength={500}
                  value={row.text}
                  disabled={disabled}
                  onChange={(e) => updateLyricField(row.id, { text: e.target.value })}
                />
                <div className={styles.timeFields}>
                  <label>
                    Start (ms) {row.startMs !== null ? `· ${formatTimeMs(row.startMs)}` : ""}
                    <input
                      type="number"
                      min={0}
                      step={1}
                      placeholder="ms"
                      value={row.startMs ?? ""}
                      disabled={disabled}
                      onChange={(e) =>
                        updateLyricField(row.id, { startMs: parseOptionalInt(e.target.value) })
                      }
                    />
                  </label>
                  <label>
                    End (ms) {row.endMs !== null ? `· ${formatTimeMs(row.endMs)}` : ""}
                    <input
                      type="number"
                      min={1}
                      step={1}
                      placeholder="ms"
                      value={row.endMs ?? ""}
                      disabled={disabled}
                      onChange={(e) =>
                        updateLyricField(row.id, { endMs: parseOptionalInt(e.target.value) })
                      }
                    />
                  </label>
                </div>
              </div>
            );
          })
        )}
      </div>

      <details className={styles.optionalDisclosure}>
        <summary>Target notes (optional · {notes.length} entered)</summary>
        <p className={styles.mutedSmall}>
          Optional reference notes follow the backend schema{" "}
          <code>{`{ startMs, endMs, midiNote }`}</code> (MIDI 0–127, ordered, non-overlapping). Leave
          empty for a lyrics-only song.
        </p>
        <div className={styles.builderToolbar}>
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={disabled}
            onClick={addNoteRow}
          >
            + Add note
          </button>
          {notes.length > 0 && (
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={disabled}
              onClick={() => updateNotes([])}
            >
              Clear all notes
            </button>
          )}
        </div>
        {notes.map((note, idx) => (
          <div key={note.id} className={styles.noteRow}>
            <span className={styles.rowNumber}>
              Note {idx + 1} ·{" "}
              {note.midiNote !== null ? midiNoteLabel(note.midiNote) : "No MIDI pitch"}
            </span>
            <div className={styles.threeFields}>
              <label>
                Start (ms)
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={note.startMs ?? ""}
                  disabled={disabled}
                  onChange={(e) =>
                    updateNoteField(note.id, { startMs: parseOptionalInt(e.target.value) })
                  }
                />
              </label>
              <label>
                End (ms)
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={note.endMs ?? ""}
                  disabled={disabled}
                  onChange={(e) =>
                    updateNoteField(note.id, { endMs: parseOptionalInt(e.target.value) })
                  }
                />
              </label>
              <label>
                MIDI (0–127)
                <input
                  type="number"
                  min={0}
                  max={127}
                  step={1}
                  value={note.midiNote ?? ""}
                  disabled={disabled}
                  onChange={(e) =>
                    updateNoteField(note.id, { midiNote: parseOptionalInt(e.target.value) })
                  }
                />
              </label>
            </div>
            <div className={styles.rowActions}>
              <button
                type="button"
                className={styles.miniButton}
                disabled={disabled || !hasAudioSource}
                onClick={() => updateNoteField(note.id, { startMs: playheadMs })}
              >
                Start=Now
              </button>
              <button
                type="button"
                className={styles.miniButton}
                disabled={disabled || !hasAudioSource}
                onClick={() => updateNoteField(note.id, { endMs: playheadMs })}
              >
                End=Now
              </button>
              <button
                type="button"
                className={styles.miniButton}
                disabled={disabled}
                onClick={() => updateNotes(notes.filter((n) => n.id !== note.id))}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
        <label>
          Import notes JSON array{" "}
          <span className={styles.optional}>[{`{"startMs":0,"endMs":1000,"midiNote":60}`}]</span>
          <textarea
            rows={3}
            placeholder='[{"startMs":0,"endMs":1000,"midiNote":60}]'
            value={notesImportText}
            onChange={(e) => setNotesImportText(e.target.value)}
            disabled={disabled}
          />
        </label>
        {notesImportError && (
          <p className={styles.error} role="alert">
            {notesImportError}
          </p>
        )}
        <button
          type="button"
          className={styles.secondaryButton}
          disabled={disabled || !notesImportText.trim()}
          onClick={importNotes}
        >
          Import target notes
        </button>
      </details>

      <details className={styles.optionalDisclosure}>
        <summary>Optional: import or inspect generated package JSON</summary>
        <p className={styles.mutedSmall}>
          No JSON file is required. You can inspect the generated payload below or paste an existing{" "}
          <code>SongPackage</code> JSON to load it into the editor.
        </p>
        <textarea
          rows={3}
          placeholder="Paste existing formatVersion 1 package JSON to load lines and notes"
          value={packageImportText}
          onChange={(e) => setPackageImportText(e.target.value)}
          disabled={disabled}
        />
        {packageImportError && (
          <p className={styles.error} role="alert">
            {packageImportError}
          </p>
        )}
        <button
          type="button"
          className={styles.secondaryButton}
          disabled={disabled || !packageImportText.trim()}
          onClick={importFullPackage}
        >
          Load package JSON into editor
        </button>
        {buildResult.pkg && (
          <pre className={styles.jsonPreview}>{JSON.stringify(buildResult.pkg, null, 2)}</pre>
        )}
      </details>

      {buildResult.errors.length > 0 ? (
        <div className={styles.validationBox} role="status">
          <strong>Package validation issues ({buildResult.errors.length}):</strong>
          <ul>
            {buildResult.errors.slice(0, 5).map((err, i) => (
              <li key={i}>{err}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className={styles.validationOk}>
          Package valid: {buildResult.pkg!.lyrics.length} timed lyric line(s),{" "}
          {buildResult.pkg!.notes.length} target note(s), {buildResult.byteSize} bytes JSON.
        </div>
      )}

      <label className={styles.reviewCheck}>
        <input
          type="checkbox"
          checked={reviewed}
          disabled={disabled || buildResult.errors.length > 0}
          onChange={(e) => onChangeReviewed(e.target.checked)}
        />
        <span>
          I have reviewed these lyrics, timings, and optional target notes against the song audio.
        </span>
      </label>
    </div>
  );
}
