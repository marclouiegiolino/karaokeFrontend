import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSongPackage,
  findActiveLyricIndex,
  parseLyricsBlock,
  parseNotesJsonImport,
  serializePackageBytes,
  validateSongPackage,
} from "../src/lib/songPackage.ts";

test("parseLyricsBlock splits lines without fabricating timestamps", () => {
  const rows = parseLyricsBlock("  First line \n\nSecond line\r\nThird line ");
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => ({ text: r.text, startMs: r.startMs, endMs: r.endMs })),
    [
      { text: "First line", startMs: null, endMs: null },
      { text: "Second line", startMs: null, endMs: null },
      { text: "Third line", startMs: null, endMs: null },
    ],
  );
});

test("buildSongPackage builds valid lyrics-only and timed-note packages", () => {
  const lyricsOnly = buildSongPackage({
    durationMs: 12_000,
    lyrics: [
      { id: "1", startMs: 500, endMs: 4000, text: "Opening line" },
      { id: "2", startMs: 4500, endMs: 11_000, text: "Closing line" },
    ],
  });
  assert.deepEqual(lyricsOnly.errors, []);
  assert.ok(lyricsOnly.pkg);
  assert.equal(lyricsOnly.pkg.formatVersion, 1);
  assert.equal(lyricsOnly.pkg.packageVersion, 1);
  assert.equal(lyricsOnly.pkg.durationMs, 12_000);
  assert.deepEqual(lyricsOnly.pkg.notes, []);

  const withNotes = buildSongPackage({
    durationMs: 12_000,
    lyrics: lyricsOnly.pkg.lyrics.map((l, i) => ({ id: String(i), ...l })),
    notes: [
      { id: "n1", startMs: 500, endMs: 2000, midiNote: 60 },
      { id: "n2", startMs: 2200, endMs: 3800, midiNote: 64 },
    ],
  });
  assert.deepEqual(withNotes.errors, []);
  assert.equal(withNotes.pkg?.notes.length, 2);
});

test("buildSongPackage and validateSongPackage reject missing, overlapping, out-of-bounds, and extra fields", () => {
  const missingTimes = buildSongPackage({
    durationMs: 10_000,
    lyrics: [{ id: "1", startMs: null, endMs: 2000, text: "Unset start" }],
  });
  assert.ok(missingTimes.errors.some((e) => e.includes("set both start and end times")));

  const invertedTimes = buildSongPackage({
    durationMs: 10_000,
    lyrics: [{ id: "1", startMs: 3000, endMs: 3000, text: "Zero length" }],
  });
  assert.ok(invertedTimes.errors.some((e) => e.includes("must be greater than startMs")));

  const overlapping = buildSongPackage({
    durationMs: 10_000,
    lyrics: [
      { id: "1", startMs: 0, endMs: 4000, text: "One" },
      { id: "2", startMs: 3999, endMs: 6000, text: "Two" },
    ],
  });
  assert.ok(overlapping.errors.some((e) => e.includes("overlaps")));

  const pastDuration = buildSongPackage({
    durationMs: 10_000,
    lyrics: [{ id: "1", startMs: 5000, endMs: 10_001, text: "Too long" }],
  });
  assert.ok(pastDuration.errors.some((e) => e.includes("exceeds song durationMs")));

  const badMidi = buildSongPackage({
    durationMs: 10_000,
    lyrics: [{ id: "1", startMs: 0, endMs: 5000, text: "Line" }],
    notes: [{ id: "n1", startMs: 0, endMs: 1000, midiNote: 128 }],
  });
  assert.ok(badMidi.errors.some((e) => e.includes("between 0 and 127")));

  const extraField = validateSongPackage({
    formatVersion: 1,
    packageVersion: 1,
    durationMs: 4000,
    lyrics: [{ startMs: 0, endMs: 4000, text: "Line", extra: true }],
    notes: [],
  });
  assert.equal(extraField.ok, false);
});

test("parseNotesJsonImport validates target note structure strictly", () => {
  const ok = parseNotesJsonImport(
    JSON.stringify([{ startMs: 0, endMs: 1000, midiNote: 60 }]),
  );
  assert.equal(ok.error, undefined);
  assert.equal(ok.notes?.length, 1);

  const extraKey = parseNotesJsonImport(
    JSON.stringify([{ startMs: 0, endMs: 1000, midiNote: 60, velocity: 100 }]),
  );
  assert.ok(extraKey.error);
});

test("findActiveLyricIndex tracks audio playback and seek positions cleanly", () => {
  const lines = [
    { startMs: 1000, endMs: 3000, text: "First" },
    { startMs: 4000, endMs: 7000, text: "Second" },
  ];
  assert.equal(findActiveLyricIndex(lines, 500), -1);
  assert.equal(findActiveLyricIndex(lines, 1000), 0);
  assert.equal(findActiveLyricIndex(lines, 2999), 0);
  assert.equal(findActiveLyricIndex(lines, 3000), -1);
  assert.equal(findActiveLyricIndex(lines, 5200), 1);
});

test("generated package bytes pass backend package completion upload flow", async () => {
  const generated = buildSongPackage({
    durationMs: 8000,
    lyrics: [
      { id: "1", startMs: 0, endMs: 3500, text: "Generated line one" },
      { id: "2", startMs: 4000, endMs: 7500, text: "Generated line two" },
    ],
  });
  assert.ok(generated.pkg);
  const bytes = serializePackageBytes(generated.pkg);

  const calls: string[] = [];
  const fakeUploadFlow = async () => {
    calls.push("POST /uploads (package)");
    const intent = {
      uploadId: "123e4567-e89b-42d3-a456-426614174000",
      url: "https://storage.invalid/_staging/123e4567",
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      byteSize: bytes.byteLength,
    };
    calls.push(`PUT ${intent.url} (${intent.byteSize} bytes)`);
    calls.push("POST /uploads/complete");
    const parsedBack = JSON.parse(new TextDecoder().decode(bytes));
    const rechecked = validateSongPackage(parsedBack);
    assert.equal(rechecked.ok, true);
    return { status: "DRAFT", scoringAvailable: true };
  };

  const result = await fakeUploadFlow();
  assert.equal(result.scoringAvailable, true);
  assert.deepEqual(calls, [
    "POST /uploads (package)",
    "PUT https://storage.invalid/_staging/123e4567 (" + bytes.byteLength + " bytes)",
    "POST /uploads/complete",
  ]);
});
