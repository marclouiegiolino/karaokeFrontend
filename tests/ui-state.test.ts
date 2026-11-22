import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { Song } from "../src/lib/api.ts";
import {
  applyPreferencesToDocument,
  canAccessView,
  DEFAULT_PREFERENCES,
  describePackageScoringStatus,
  enqueueSong,
  filterLibrarySongs,
  getAdjacentSong,
  getDrawerItems,
  loadPreferences,
  moveQueueSong,
  parsePreferences,
  parseRecentIds,
  PREFERENCES_STORAGE_KEY,
  recordRecentSongId,
  removeQueueSong,
  savePreferences,
  SUPPORTED_TEMPO_RATES,
  THEME_PRESETS,
} from "../src/lib/uiState.ts";
import type { SongPackage } from "../src/lib/songPackage.ts";

function makeSong(overrides: Partial<Song> = {}): Song {
  return {
    id: overrides.id ?? "song-1",
    title: overrides.title ?? "Blush Serenade",
    artist: overrides.artist ?? "Luna",
    genre: overrides.genre ?? "Ballad",
    language: overrides.language ?? "en",
    duration_ms: overrides.duration_ms ?? 185000,
    package_version: 1,
    status: "PUBLISHED",
    hasAudio: true,
    hasCover: false,
    scoringAvailable: overrides.scoringAvailable ?? true,
  };
}

test("hamburger drawer items include required sections and restrict management actions to ADMIN", () => {
  const userItems = getDrawerItems("USER");
  const userIds = userItems.map((item) => item.id);
  assert.deepEqual(userIds, ["song-library", "queue", "account", "preferences", "help", "sign-out"]);
  assert.equal(canAccessView("admin", "USER"), false);
  assert.equal(canAccessView("preferences", "USER"), true);

  const adminItems = getDrawerItems("ADMIN");
  const adminIds = adminItems.map((item) => item.id);
  assert.deepEqual(adminIds, [
    "song-library",
    "queue",
    "manage-songs",
    "account",
    "preferences",
    "help",
    "sign-out",
  ]);
  assert.equal(canAccessView("admin", "ADMIN"), true);
});

test("navigation drawer component implements accessible dialog, Escape close, and backdrop outside click", async () => {
  const source = await readFile(join(process.cwd(), "src/components/NavigationDrawer.tsx"), "utf8");
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /event\.target === event\.currentTarget/);
  assert.match(source, /getDrawerItems\(user\.role\)/);
});

test("theme preferences default to Blush Pink, support complementary themes, and persist cleanly", async () => {
  assert.equal(DEFAULT_PREFERENCES.theme, "blush");
  assert.equal(THEME_PRESETS[0]?.id, "blush");
  assert.equal(THEME_PRESETS[0]?.isDefault, true);
  assert.deepEqual(
    THEME_PRESETS.map((t) => t.id),
    ["blush", "rose", "lavender", "teal"],
  );

  const store = new Map<string, string>();
  const mockStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };

  assert.deepEqual(loadPreferences(mockStorage), DEFAULT_PREFERENCES);
  assert.deepEqual(parsePreferences("{invalid-json"), DEFAULT_PREFERENCES);

  const saved = savePreferences(
    { theme: "lavender", reducedMotion: true, lyricSize: "lg" },
    mockStorage,
  );
  assert.deepEqual(saved, { theme: "lavender", reducedMotion: true, lyricSize: "lg" });
  assert.ok(store.has(PREFERENCES_STORAGE_KEY));
  assert.deepEqual(loadPreferences(mockStorage), saved);

  const fakeRoot = { dataset: {} } as unknown as HTMLElement;
  applyPreferencesToDocument(saved, fakeRoot);
  assert.equal(fakeRoot.dataset.theme, "lavender");
  assert.equal(fakeRoot.dataset.motion, "reduced");
  assert.equal(fakeRoot.dataset.lyricSize, "lg");

  const css = await readFile(join(process.cwd(), "src/app/globals.css"), "utf8");
  for (const theme of ["blush", "rose", "lavender", "teal"]) {
    assert.match(css, new RegExp(`\\[data-theme="${theme}"\\]`));
  }
  assert.match(css, /\[data-motion="reduced"\]/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
});

test("library filters support All, Favorites, Recent, search matching, and queue ordering", () => {
  const s1 = makeSong({ id: "s1", title: "Midnight Rose", artist: "Aria" });
  const s2 = makeSong({ id: "s2", title: "Velvet Echo", artist: "Milo" });
  const s3 = makeSong({ id: "s3", title: "Warm Tea", artist: "Aria" });
  const catalog = [s1, s2, s3];
  const favs = new Set<string>(["s2"]);
  let recents = parseRecentIds('["s3","s1"]');
  recents = recordRecentSongId(recents, "s1");
  assert.deepEqual(recents, ["s1", "s3"]);

  assert.deepEqual(
    filterLibrarySongs({ songs: catalog, filter: "all", favoriteIds: favs, recentIds: recents }).map(
      (s) => s.id,
    ),
    ["s1", "s2", "s3"],
  );
  assert.deepEqual(
    filterLibrarySongs({
      songs: catalog,
      filter: "favorites",
      favoriteIds: favs,
      recentIds: recents,
    }).map((s) => s.id),
    ["s2"],
  );
  assert.deepEqual(
    filterLibrarySongs({
      songs: catalog,
      filter: "recent",
      favoriteIds: favs,
      recentIds: recents,
    }).map((s) => s.id),
    ["s1", "s3"],
  );
  assert.deepEqual(
    filterLibrarySongs({
      songs: catalog,
      filter: "all",
      favoriteIds: favs,
      recentIds: recents,
      query: "aria",
    }).map((s) => s.id),
    ["s1", "s3"],
  );

  let q = enqueueSong([], s2);
  q = enqueueSong(q, s1);
  q = enqueueSong(q, s2);
  assert.deepEqual(
    q.map((s) => s.id),
    ["s2", "s1"],
  );
  q = moveQueueSong(q, 1, -1);
  assert.deepEqual(
    q.map((s) => s.id),
    ["s1", "s2"],
  );
  assert.equal(
    getAdjacentSong({ queue: q, catalog, currentSongId: "s1", direction: 1 })?.id,
    "s2",
  );
  q = removeQueueSong(q, "s1");
  assert.deepEqual(
    q.map((s) => s.id),
    ["s2"],
  );
});

test("karaoke player reports honest scoring availability without fabricated pitch scores", () => {
  const song = makeSong({ scoringAvailable: true });
  const lyricsOnlyPkg: SongPackage = {
    formatVersion: 1,
    packageVersion: 1,
    durationMs: 12000,
    lyrics: [{ startMs: 0, endMs: 4000, text: "Line 1" }],
    notes: [],
  };
  const lyricsOnly = describePackageScoringStatus(lyricsOnlyPkg, song);
  assert.equal(lyricsOnly.pitchScoringSupported, false);
  assert.equal(lyricsOnly.label, "Timed lyrics only · pitch scoring unavailable.");

  const notedPkg: SongPackage = {
    ...lyricsOnlyPkg,
    notes: [{ startMs: 0, endMs: 1000, midiNote: 64 }],
  };
  const withNotes = describePackageScoringStatus(notedPkg, song);
  assert.equal(withNotes.pitchScoringSupported, false);
  assert.match(withNotes.label, /Timed lyrics \+ 1 target notes · pitch scoring unavailable/);

  assert.deepEqual(SUPPORTED_TEMPO_RATES, [0.85, 1, 1.15]);
});
