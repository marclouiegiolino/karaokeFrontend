import type { Song, User } from "./api.ts";
import type { SongPackage } from "./songPackage.ts";

export type ThemeId = "blush" | "rose" | "lavender" | "teal";
export type LyricSize = "sm" | "md" | "lg";
export type AppView = "library" | "sing" | "queue" | "profile" | "preferences" | "admin" | "help";
export type LibraryFilter = "all" | "favorites" | "recent";
export type DrawerActionId =
  | "song-library"
  | "queue"
  | "manage-songs"
  | "account"
  | "preferences"
  | "help"
  | "sign-out";

export type ThemePreset = {
  id: ThemeId;
  name: string;
  description: string;
  isDefault?: boolean;
  swatches: [string, string, string];
};

export type UserPreferences = {
  theme: ThemeId;
  reducedMotion: boolean;
  lyricSize: LyricSize;
};

export type DrawerItem = {
  id: DrawerActionId;
  label: string;
  description: string;
  view?: AppView;
  adminOnly?: boolean;
};

export const PREFERENCES_STORAGE_KEY = "karaoke.preferences.v1";
export const SUPPORTED_TEMPO_RATES = [0.85, 1, 1.15] as const;

export const THEME_PRESETS: readonly ThemePreset[] = [
  {
    id: "blush",
    name: "Blush Pink",
    description: "Warm blush accents, soft cream canvas, deep berry text",
    isDefault: true,
    swatches: ["#d95884", "#fdf6f2", "#3b1827"],
  },
  {
    id: "rose",
    name: "Velvet Rose",
    description: "Rich rose berry highlights with warm petal cards",
    swatches: ["#b83360", "#fcf3f5", "#391221"],
  },
  {
    id: "lavender",
    name: "Soft Lavender",
    description: "Dreamy lilac accents paired with deep plum ink",
    swatches: ["#7952d8", "#f8f6fc", "#2a1d44"],
  },
  {
    id: "teal",
    name: "Seafoam Teal",
    description: "Crisp coastal teal with clean mint surfaces",
    swatches: ["#087f79", "#f5f8f7", "#172022"],
  },
];

export const DEFAULT_PREFERENCES: UserPreferences = {
  theme: "blush",
  reducedMotion: false,
  lyricSize: "md",
};

const VALID_THEMES = new Set<ThemeId>(["blush", "rose", "lavender", "teal"]);
const VALID_LYRIC_SIZES = new Set<LyricSize>(["sm", "md", "lg"]);

export function parsePreferences(raw: string | null | undefined): UserPreferences {
  if (!raw) return { ...DEFAULT_PREFERENCES };
  try {
    const parsed = JSON.parse(raw) as Partial<UserPreferences> | null;
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_PREFERENCES };
    return {
      theme: parsed.theme && VALID_THEMES.has(parsed.theme) ? parsed.theme : "blush",
      reducedMotion: typeof parsed.reducedMotion === "boolean" ? parsed.reducedMotion : false,
      lyricSize:
        parsed.lyricSize && VALID_LYRIC_SIZES.has(parsed.lyricSize) ? parsed.lyricSize : "md",
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function loadPreferences(storage?: Pick<Storage, "getItem"> | null): UserPreferences {
  const target = storage ?? (typeof window !== "undefined" ? window.localStorage : null);
  if (!target) return { ...DEFAULT_PREFERENCES };
  try {
    return parsePreferences(target.getItem(PREFERENCES_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function savePreferences(
  prefs: UserPreferences,
  storage?: Pick<Storage, "setItem"> | null,
): UserPreferences {
  const normalized = parsePreferences(JSON.stringify(prefs));
  const target = storage ?? (typeof window !== "undefined" ? window.localStorage : null);
  if (target) {
    try {
      target.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(normalized));
    } catch {
      // Ignore storage quota or private-mode errors gracefully.
    }
  }
  return normalized;
}

export function applyPreferencesToDocument(
  prefs: UserPreferences,
  root?: HTMLElement | null,
): void {
  const target = root ?? (typeof document !== "undefined" ? document.documentElement : null);
  if (!target) return;
  target.dataset.theme = prefs.theme;
  target.dataset.motion = prefs.reducedMotion ? "reduced" : "system";
  target.dataset.lyricSize = prefs.lyricSize;
}

const ALL_DRAWER_ITEMS: readonly DrawerItem[] = [
  {
    id: "song-library",
    label: "Song library",
    description: "Browse, search, and favorite songs",
    view: "library",
  },
  {
    id: "queue",
    label: "Queue",
    description: "Up next songs for your session",
    view: "queue",
  },
  {
    id: "manage-songs",
    label: "Manage songs · Add a song",
    description: "Upload audio, author lyrics, and publish",
    view: "admin",
    adminOnly: true,
  },
  {
    id: "account",
    label: "Account",
    description: "Profile details and session info",
    view: "profile",
  },
  {
    id: "preferences",
    label: "Preferences",
    description: "Theme palette, lyric size, and motion",
    view: "preferences",
  },
  {
    id: "help",
    label: "Help / About",
    description: "How playback, lyrics, and scoring work",
    view: "help",
  },
  {
    id: "sign-out",
    label: "Sign out",
    description: "End this session cleanly",
  },
];

export function isAdminRole(role: User["role"] | null | undefined): boolean {
  return role === "ADMIN";
}

export function getDrawerItems(role: User["role"] | null | undefined): DrawerItem[] {
  const admin = isAdminRole(role);
  return ALL_DRAWER_ITEMS.filter((item) => !item.adminOnly || admin).map((item) => ({ ...item }));
}

export function canAccessView(view: AppView, role: User["role"] | null | undefined): boolean {
  if (view === "admin") return isAdminRole(role);
  return true;
}

export function recentStorageKey(userId: string): string {
  return `karaoke.recent.${userId}`;
}

export function parseRecentIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const clean: string[] = [];
    for (const entry of parsed) {
      if (typeof entry === "string" && entry.trim() && !seen.has(entry)) {
        seen.add(entry);
        clean.push(entry);
      }
    }
    return clean.slice(0, 25);
  } catch {
    return [];
  }
}

export function recordRecentSongId(current: string[], songId: string, limit = 25): string[] {
  return [songId, ...current.filter((id) => id !== songId)].slice(0, limit);
}

export function filterLibrarySongs(params: {
  songs: readonly Song[];
  filter: LibraryFilter;
  favoriteIds: ReadonlySet<string>;
  recentIds: readonly string[];
  query?: string;
}): Song[] {
  const q = (params.query ?? "").trim().toLowerCase();
  const matchesQuery = (song: Song) =>
    !q ||
    song.title.toLowerCase().includes(q) ||
    song.artist.toLowerCase().includes(q) ||
    (song.genre?.toLowerCase().includes(q) ?? false);

  if (params.filter === "recent") {
    const byId = new Map(params.songs.map((song) => [song.id, song]));
    const ordered: Song[] = [];
    for (const id of params.recentIds) {
      const song = byId.get(id);
      if (song && matchesQuery(song)) ordered.push(song);
    }
    return ordered;
  }

  return params.songs.filter((song) => {
    if (!matchesQuery(song)) return false;
    if (params.filter === "favorites") return params.favoriteIds.has(song.id);
    return true;
  });
}

export function enqueueSong(queue: readonly Song[], song: Song): Song[] {
  if (queue.some((item) => item.id === song.id)) return [...queue];
  return [...queue, song];
}

export function removeQueueSong(queue: readonly Song[], songId: string): Song[] {
  return queue.filter((item) => item.id !== songId);
}

export function moveQueueSong(queue: readonly Song[], index: number, delta: -1 | 1): Song[] {
  const target = index + delta;
  if (index < 0 || index >= queue.length || target < 0 || target >= queue.length) {
    return [...queue];
  }
  const next = [...queue];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved!);
  return next;
}

export function getAdjacentSong(params: {
  queue: readonly Song[];
  catalog: readonly Song[];
  currentSongId: string | null;
  direction: -1 | 1;
}): Song | null {
  const source = params.queue.length > 0 ? params.queue : params.catalog;
  if (source.length === 0) return null;
  if (!params.currentSongId) return source[0] ?? null;
  const idx = source.findIndex((song) => song.id === params.currentSongId);
  if (idx === -1) return source[0] ?? null;
  const target = idx + params.direction;
  if (target < 0 || target >= source.length) return null;
  return source[target] ?? null;
}

export type ScoringStatusInfo = {
  label: string;
  pitchScoringSupported: false;
  hasTargetNotes: boolean;
};

export function describePackageScoringStatus(
  pkg: SongPackage | null,
  song: Song | null,
): ScoringStatusInfo {
  if (pkg && pkg.notes.length > 0) {
    return {
      label: `Timed lyrics + ${pkg.notes.length} target notes · pitch scoring unavailable in this player.`,
      pitchScoringSupported: false,
      hasTargetNotes: true,
    };
  }
  if (pkg || song?.scoringAvailable) {
    return {
      label: "Timed lyrics only · pitch scoring unavailable.",
      pitchScoringSupported: false,
      hasTargetNotes: false,
    };
  }
  return {
    label: "Audio playback only · timed lyrics and pitch scoring unavailable.",
    pitchScoringSupported: false,
    hasTargetNotes: false,
  };
}

export function getTimeGreeting(date = new Date()): string {
  const hour = date.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function bottomNavTabForView(view: AppView): "library" | "sing" | "queue" | "profile" {
  if (view === "sing" || view === "queue" || view === "profile") return view;
  if (view === "library" || view === "admin") return "library";
  return "profile";
}
