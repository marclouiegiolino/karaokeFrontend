"use client";

import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavigationDrawer } from "@/components/NavigationDrawer";
import { ScoringPackageBuilder } from "@/components/ScoringPackageBuilder";
import {
  addFavorite,
  api,
  ApiError,
  DownloadResponse,
  listFavorites,
  mediaType,
  putDirectlyToR2,
  removeFavorite,
  Song,
  SongListResponse,
  transcribeSongLyrics,
  UploadIntent,
  User,
} from "@/lib/api";
import {
  buildSongPackage,
  EditableLyricLine,
  EditableTargetNote,
  findActiveLyricIndex,
  formatTimeMs,
  serializePackageBytes,
  SongPackage,
  validateSongPackage,
} from "@/lib/songPackage";
import {
  createInitialTranscribeState,
  executeGenerateLyrics,
  resolvePendingTranscript,
  TranscribeFlowState,
} from "@/lib/transcriptionDraft";
import {
  applyPreferencesToDocument,
  AppView,
  bottomNavTabForView,
  canAccessView,
  DEFAULT_PREFERENCES,
  describePackageScoringStatus,
  enqueueSong,
  filterLibrarySongs,
  getAdjacentSong,
  getTimeGreeting,
  isAdminRole,
  LibraryFilter,
  loadPreferences,
  LyricSize,
  moveQueueSong,
  parseRecentIds,
  recentStorageKey,
  recordRecentSongId,
  removeQueueSong,
  savePreferences,
  SUPPORTED_TEMPO_RATES,
  THEME_PRESETS,
  UserPreferences,
} from "@/lib/uiState";
import styles from "./page.module.css";

type ActiveDraftState = {
  id: string;
  title: string;
  artist: string;
  genre: string;
  language: string;
  durationMs: number;
  audioDone: boolean;
  packageDone: boolean;
};

function prettyError(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

function formatDuration(ms: number) {
  const totalSeconds = Math.floor(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);

  const [preferences, setPreferences] = useState<UserPreferences>(DEFAULT_PREFERENCES);
  const [activeView, setActiveView] = useState<AppView>("library");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilter>("all");

  const [query, setQuery] = useState("");
  const [songs, setSongs] = useState<Song[]>([]);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(() => new Set());
  const [favoriteBusyId, setFavoriteBusyId] = useState<string | null>(null);
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [queue, setQueue] = useState<Song[]>([]);
  const [loadingSongs, setLoadingSongs] = useState(false);

  const [selectedSong, setSelectedSong] = useState<Song | null>(null);
  const [audioUrl, setAudioUrl] = useState("");
  const [selectedPackage, setSelectedPackage] = useState<SongPackage | null>(null);
  const [playerPositionMs, setPlayerPositionMs] = useState(0);
  const [playerDurationMs, setPlayerDurationMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [tempo, setTempo] = useState<number>(1);
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [autoPlayPending, setAutoPlayPending] = useState(false);

  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const [draft, setDraft] = useState({
    title: "",
    artist: "",
    genre: "",
    language: "",
    durationSeconds: "",
  });
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [adminAudioUrl, setAdminAudioUrl] = useState("");
  const [detectedAudioDurationMs, setDetectedAudioDurationMs] = useState<number | null>(null);
  const [adminPlayheadMs, setAdminPlayheadMs] = useState(0);
  const [lyrics, setLyrics] = useState<EditableLyricLine[]>([]);
  const [notes, setNotes] = useState<EditableTargetNote[]>([]);
  const [reviewed, setReviewed] = useState(false);
  const [activeDraft, setActiveDraft] = useState<ActiveDraftState | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [transcribeState, setTranscribeState] = useState<TranscribeFlowState>(
    createInitialTranscribeState,
  );

  const downloadReqRef = useRef(0);
  const playerAudioRef = useRef<HTMLAudioElement | null>(null);
  const activeLyricRef = useRef<HTMLButtonElement | null>(null);
  const adminAudioRef = useRef<HTMLAudioElement | null>(null);
  const adminFileInputRef = useRef<HTMLInputElement | null>(null);

  const isAdmin = isAdminRole(user?.role);
  const filteredTitle = useMemo(() => query.trim(), [query]);
  const parsedDurationMs = useMemo(() => {
    if (!draft.durationSeconds.trim()) return 0;
    return Math.round(Number(draft.durationSeconds) * 1000);
  }, [draft.durationSeconds]);
  const hasValidDuration =
    Number.isFinite(parsedDurationMs) && parsedDurationMs >= 1000 && parsedDurationMs <= 1800000;

  useEffect(() => {
    const task = window.setTimeout(() => {
      const loaded = loadPreferences();
      setPreferences(loaded);
      applyPreferencesToDocument(loaded);
    }, 0);
    return () => window.clearTimeout(task);
  }, []);

  useEffect(() => {
    applyPreferencesToDocument(preferences);
  }, [preferences]);

  useEffect(() => {
    return () => {
      if (adminAudioUrl) URL.revokeObjectURL(adminAudioUrl);
    };
  }, [adminAudioUrl]);

  useEffect(() => {
    const el = playerAudioRef.current;
    if (!el) return;
    el.playbackRate = tempo;
    if ("preservesPitch" in el) {
      (el as HTMLAudioElement & { preservesPitch: boolean }).preservesPitch = true;
    }
  }, [tempo, audioUrl]);

  useEffect(() => {
    if (!autoPlayPending || !audioUrl || loadingAudio) return;
    const el = playerAudioRef.current;
    if (!el) return;
    setAutoPlayPending(false);
    void el.play().catch(() => {
      // Mobile browsers may require an explicit tap on Play when playback is deferred.
    });
  }, [autoPlayPending, audioUrl, loadingAudio]);

  const playerActiveLyricIndex = useMemo(
    () => (selectedPackage ? findActiveLyricIndex(selectedPackage.lyrics, playerPositionMs) : -1),
    [selectedPackage, playerPositionMs],
  );

  useEffect(() => {
    if (activeView !== "sing" || playerActiveLyricIndex < 0) return;
    activeLyricRef.current?.scrollIntoView({
      block: "center",
      behavior: preferences.reducedMotion ? "auto" : "smooth",
    });
  }, [activeView, playerActiveLyricIndex, preferences.reducedMotion]);

  function updatePreferences(patch: Partial<UserPreferences>) {
    setPreferences((prev) => {
      const next = savePreferences({ ...prev, ...patch });
      applyPreferencesToDocument(next);
      return next;
    });
  }

  const handleSessionExpired = useCallback(() => {
    downloadReqRef.current++;
    setUser(null);
    setDrawerOpen(false);
    setActiveView("library");
    setSongs([]);
    setFavoriteIds(new Set());
    setRecentIds([]);
    setQueue([]);
    setSelectedSong(null);
    setAudioUrl("");
    setSelectedPackage(null);
    setPlayerPositionMs(0);
    setPlayerDurationMs(0);
    setIsPlaying(false);
    setLoadingAudio(false);
    setError("Your session has expired. Please sign in again.");
  }, []);

  const loadFavorites = useCallback(async () => {
    try {
      const result = await listFavorites(1, 50);
      setFavoriteIds(new Set(result.data.map((song) => song.id)));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        handleSessionExpired();
      }
    }
  }, [handleSessionExpired]);

  const loadSongs = useCallback(
    async (search = "") => {
      setLoadingSongs(true);
      setError("");
      try {
        const params = new URLSearchParams({ page: "1", pageSize: "50" });
        if (search) params.set("search", search);
        const result = await api<SongListResponse>(`/songs?${params.toString()}`);
        setSongs(result.data);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          handleSessionExpired();
        } else {
          setError(prettyError(e));
        }
      } finally {
        setLoadingSongs(false);
      }
    },
    [handleSessionExpired],
  );

  const hydrateUserState = useCallback(
    (signedInUser: User) => {
      try {
        const raw = window.localStorage.getItem(recentStorageKey(signedInUser.id));
        setRecentIds(parseRecentIds(raw));
      } catch {
        setRecentIds([]);
      }
      void loadSongs("");
      void loadFavorites();
    },
    [loadFavorites, loadSongs],
  );

  const loadSession = useCallback(async () => {
    try {
      const result = await api<{ user: User }>("/auth/me");
      setUser(result.user);
      hydrateUserState(result.user);
    } catch {
      setUser(null);
    } finally {
      setCheckingSession(false);
    }
  }, [hydrateUserState]);

  useEffect(() => {
    const task = window.setTimeout(() => void loadSession(), 0);
    return () => window.clearTimeout(task);
  }, [loadSession]);

  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api<{ user: User }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ login: login.trim(), password }),
      });
      setUser(result.user);
      setActiveView("library");
      setQuery("");
      setPassword("");
      hydrateUserState(result.user);
      setMessage(`Welcome, ${result.user.display_name}.`);
    } catch (e) {
      setError(prettyError(e));
    } finally {
      setAuthBusy(false);
    }
  }

  async function signOut() {
    setError("");
    setMessage("");
    downloadReqRef.current++;
    setDrawerOpen(false);
    try {
      await api<void>("/auth/logout", { method: "POST", body: "{}" });
    } catch (e) {
      setError(prettyError(e));
    } finally {
      setUser(null);
      setActiveView("library");
      setSongs([]);
      setFavoriteIds(new Set());
      setRecentIds([]);
      setQueue([]);
      setSelectedSong(null);
      setAudioUrl("");
      setSelectedPackage(null);
      setPlayerPositionMs(0);
      setPlayerDurationMs(0);
      setIsPlaying(false);
      setLoadingAudio(false);
      setActiveDraft(null);
      setUploadStatus("");
      setUploadProgress(0);
      setTranscribeState(createInitialTranscribeState());
    }
  }

  function rememberRecentSong(songId: string) {
    setRecentIds((prev) => {
      const next = recordRecentSongId(prev, songId);
      if (user) {
        try {
          window.localStorage.setItem(recentStorageKey(user.id), JSON.stringify(next));
        } catch {
          // Ignore storage quota errors.
        }
      }
      return next;
    });
  }

  async function selectSong(song: Song, options: { openPlayer?: boolean; autoPlay?: boolean } = {}) {
    const reqId = ++downloadReqRef.current;
    setSelectedSong(song);
    setAudioUrl("");
    setSelectedPackage(null);
    setPlayerPositionMs(0);
    setPlayerDurationMs(song.duration_ms);
    setIsPlaying(false);
    setLoadingAudio(true);
    setAutoPlayPending(Boolean(options.autoPlay));
    setError("");
    rememberRecentSong(song.id);
    if (options.openPlayer !== false) {
      setActiveView("sing");
    }

    try {
      const result = await api<DownloadResponse>(`/songs/${encodeURIComponent(song.id)}/download`);
      if (downloadReqRef.current !== reqId) return;
      setAudioUrl(result.audioUrl);
      setPlayerDurationMs(result.durationMs || song.duration_ms);
      if (result.packageUrl) {
        try {
          const pkgRes = await fetch(result.packageUrl, { credentials: "omit" });
          if (pkgRes.ok && downloadReqRef.current === reqId) {
            const checked = validateSongPackage(await pkgRes.json());
            if (checked.ok && downloadReqRef.current === reqId) {
              setSelectedPackage(checked.data);
            }
          }
        } catch {
          // Audio playback still works even if package CORS or network fetch is unavailable.
        }
      }
    } catch (e) {
      if (downloadReqRef.current !== reqId) return;
      setAutoPlayPending(false);
      if (e instanceof ApiError && e.status === 401) {
        handleSessionExpired();
      } else {
        setError(prettyError(e));
      }
    } finally {
      if (downloadReqRef.current === reqId) {
        setLoadingAudio(false);
      }
    }
  }

  async function toggleFavorite(song: Song) {
    if (favoriteBusyId === song.id) return;
    const currentlyFavorite = favoriteIds.has(song.id);
    setFavoriteBusyId(song.id);
    setFavoriteIds((prev) => {
      const next = new Set(prev);
      if (currentlyFavorite) next.delete(song.id);
      else next.add(song.id);
      return next;
    });
    try {
      if (currentlyFavorite) {
        await removeFavorite(song.id);
      } else {
        await addFavorite(song.id);
      }
    } catch (e) {
      setFavoriteIds((prev) => {
        const reverted = new Set(prev);
        if (currentlyFavorite) reverted.add(song.id);
        else reverted.delete(song.id);
        return reverted;
      });
      if (e instanceof ApiError && e.status === 401) {
        handleSessionExpired();
      } else {
        setError(prettyError(e));
      }
    } finally {
      setFavoriteBusyId((current) => (current === song.id ? null : current));
    }
  }

  function addSongToQueue(song: Song) {
    setQueue((prev) => enqueueSong(prev, song));
    setMessage(`Added “${song.title}” to your queue.`);
  }

  function seekPlayerToMs(ms: number) {
    const maxMs = Math.max(playerDurationMs, selectedSong?.duration_ms ?? 0);
    const clamped = Math.max(0, maxMs > 0 ? Math.min(maxMs, ms) : ms);
    setPlayerPositionMs(clamped);
    const el = playerAudioRef.current;
    if (el && Number.isFinite(clamped)) {
      el.currentTime = clamped / 1000;
    }
  }

  function togglePlayPause() {
    const el = playerAudioRef.current;
    if (!el || !audioUrl) return;
    if (el.paused) {
      void el.play().catch(() => {
        setError("Tap Play again to start audio playback on this browser.");
      });
    } else {
      el.pause();
    }
  }

  function stepTrack(direction: -1 | 1) {
    if (direction === -1 && playerPositionMs > 3000 && playerAudioRef.current) {
      seekPlayerToMs(0);
      return;
    }
    const adjacent = getAdjacentSong({
      queue,
      catalog: songs,
      currentSongId: selectedSong?.id ?? null,
      direction,
    });
    if (adjacent) {
      void selectSong(adjacent, { openPlayer: true, autoPlay: true });
    }
  }

  function handleViewChange(nextView: AppView) {
    if (!canAccessView(nextView, user?.role)) return;
    setActiveView(nextView);
  }

  const visibleSongs = useMemo(
    () =>
      filterLibrarySongs({
        songs,
        filter: libraryFilter,
        favoriteIds,
        recentIds,
        query,
      }),
    [songs, libraryFilter, favoriteIds, recentIds, query],
  );

  function handleStartSinging() {
    if (selectedSong) {
      setActiveView("sing");
      return;
    }
    const first = queue[0] ?? visibleSongs[0] ?? songs[0];
    if (first) {
      void selectSong(first, { openPlayer: true, autoPlay: true });
    }
  }

  function handleAudioFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setAudioFile(file);
    setDetectedAudioDurationMs(null);
    setAdminPlayheadMs(0);
    setAdminAudioUrl(file ? URL.createObjectURL(file) : "");
    setTranscribeState(createInitialTranscribeState());
  }

  function seekAdminAudio(ms: number) {
    const el = adminAudioRef.current;
    const clampedMs = Math.max(
      0,
      hasValidDuration ? Math.min(parsedDurationMs, ms) : ms,
    );
    setAdminPlayheadMs(clampedMs);
    if (el && Number.isFinite(clampedMs)) {
      el.currentTime = clampedMs / 1000;
    }
  }

  async function ensureDraftAndUploadAudio(): Promise<ActiveDraftState> {
    const title = draft.title.trim();
    const artist = draft.artist.trim();
    const genre = draft.genre.trim();
    const language = draft.language.trim();
    if (!title || !artist) {
      throw new Error("Enter both a song title and an artist.");
    }
    if (!hasValidDuration) {
      throw new Error("Duration must be between 1 second and 30 minutes.");
    }

    let currentDraft: ActiveDraftState | null =
      activeDraft &&
      activeDraft.title === title &&
      activeDraft.artist === artist &&
      activeDraft.genre === genre &&
      activeDraft.language === language &&
      activeDraft.durationMs === parsedDurationMs
        ? { ...activeDraft }
        : null;

    if (!currentDraft) {
      setUploadStatus("Creating draft…");
      const created = await api<{ data: Song }>("/songs", {
        method: "POST",
        body: JSON.stringify({
          title,
          artist,
          ...(genre ? { genre } : {}),
          ...(language ? { language } : {}),
          durationMs: parsedDurationMs,
        }),
      });
      currentDraft = {
        id: created.data.id,
        title,
        artist,
        genre,
        language,
        durationMs: parsedDurationMs,
        audioDone: false,
        packageDone: false,
      };
      setActiveDraft(currentDraft);
    }

    if (!currentDraft.audioDone) {
      if (!audioFile) {
        throw new Error("Choose an audio file before uploading.");
      }
      if (audioFile.size < 1 || audioFile.size > 20_000_000) {
        throw new Error("Audio file must be between 1 byte and 20 MB.");
      }
      const audioContentType = mediaType(audioFile, "audio");
      if (!audioContentType) {
        throw new Error(`Could not determine a supported media type for ${audioFile.name}.`);
      }
      setUploadProgress(0);
      setUploadStatus("Reserving audio upload…");
      const audioIntent = await api<UploadIntent>(
        `/songs/${encodeURIComponent(currentDraft.id)}/uploads`,
        {
          method: "POST",
          body: JSON.stringify({
            kind: "audio",
            contentType: audioContentType,
            byteSize: audioFile.size,
          }),
        },
      );
      setUploadStatus("Uploading audio directly to R2…");
      await putDirectlyToR2(
        audioIntent.url,
        audioIntent.method,
        audioIntent.headers,
        audioFile,
        setUploadProgress,
      );
      setUploadStatus("Verifying audio…");
      await api<{ data: Song }>(
        `/songs/${encodeURIComponent(currentDraft.id)}/uploads/complete`,
        {
          method: "POST",
          body: JSON.stringify({ uploadId: audioIntent.uploadId }),
        },
      );
      currentDraft = { ...currentDraft, audioDone: true };
      setActiveDraft(currentDraft);
    }

    return currentDraft;
  }

  async function uploadAudioToDraftFirst() {
    setUploadBusy(true);
    setError("");
    setMessage("");
    setUploadProgress(0);
    try {
      const savedDraft = await ensureDraftAndUploadAudio();
      setUploadStatus(
        "Audio uploaded to draft. Preview/adjust your lyrics below, then upload package & publish.",
      );
      setMessage(
        `Audio uploaded to draft “${savedDraft.title}”. Preview timings against the audio before publishing.`,
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        handleSessionExpired();
      } else {
        setError(prettyError(e));
        setUploadStatus("Audio upload stopped. Check the error above before retrying.");
      }
    } finally {
      setUploadBusy(false);
    }
  }

  async function generateLyricsFromSongAudio() {
    setUploadBusy(true);
    setError("");
    setMessage("");
    try {
      await executeGenerateLyrics({
        existingLyrics: lyrics,
        transcribe: async () => {
          const savedDraft = await ensureDraftAndUploadAudio();
          return transcribeSongLyrics(savedDraft.id, draft.language.trim() || undefined);
        },
        onState: setTranscribeState,
        onReplaceLyrics: (next) => {
          setLyrics(next);
          setReviewed(false);
        },
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        handleSessionExpired();
      } else {
        setTranscribeState({
          busy: false,
          error: prettyError(e),
          notice: "",
          pendingDraft: null,
        });
      }
    } finally {
      setUploadBusy(false);
    }
  }

  function handleResolvePendingTranscript(mode: "replace" | "append" | "discard") {
    if (mode === "discard" || !transcribeState.pendingDraft) {
      setTranscribeState(createInitialTranscribeState());
      return;
    }
    const resolved = resolvePendingTranscript({
      existingLyrics: lyrics,
      pendingDraft: transcribeState.pendingDraft,
      mode,
    });
    setLyrics(resolved.lyrics);
    setReviewed(false);
    setTranscribeState({
      busy: false,
      error: "",
      notice: resolved.notice,
      pendingDraft: null,
    });
  }

  async function createAndUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;

    if (!hasValidDuration) {
      setError("Duration must be between 1 second and 30 minutes.");
      return;
    }

    const built = buildSongPackage({
      durationMs: parsedDurationMs,
      packageVersion: 1,
      lyrics,
      notes,
    });
    if (!built.pkg || built.errors.length > 0) {
      setError(built.errors[0] ?? "Fix package validation errors before uploading.");
      return;
    }
    if (!reviewed) {
      setError("Confirm that you have reviewed the lyrics, timings, and optional notes.");
      return;
    }

    setUploadBusy(true);
    setError("");
    setMessage("");
    setUploadProgress(0);

    try {
      let currentDraft = await ensureDraftAndUploadAudio();

      if (!currentDraft.packageDone) {
        const pkgBytes = serializePackageBytes(built.pkg);
        const pkgBlob = new Blob([pkgBytes as BlobPart], { type: "application/json" });
        setUploadProgress(0);
        setUploadStatus("Reserving generated package upload…");
        const pkgIntent = await api<UploadIntent>(
          `/songs/${encodeURIComponent(currentDraft.id)}/uploads`,
          {
            method: "POST",
            body: JSON.stringify({
              kind: "package",
              contentType: "application/json",
              byteSize: pkgBlob.size,
            }),
          },
        );
        setUploadStatus("Uploading generated package directly to R2…");
        await putDirectlyToR2(
          pkgIntent.url,
          pkgIntent.method,
          pkgIntent.headers,
          pkgBlob,
          setUploadProgress,
        );
        setUploadStatus("Verifying package…");
        await api<{ data: Song }>(
          `/songs/${encodeURIComponent(currentDraft.id)}/uploads/complete`,
          {
            method: "POST",
            body: JSON.stringify({ uploadId: pkgIntent.uploadId }),
          },
        );
        currentDraft = { ...currentDraft, packageDone: true };
        setActiveDraft(currentDraft);
      }

      setUploadStatus("Publishing song…");
      const published = await api<{ data: Song }>(
        `/songs/${encodeURIComponent(currentDraft.id)}/publish`,
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );
      setMessage(`“${published.data.title}” was uploaded and published.`);
      setUploadStatus("Upload complete");
      setActiveDraft(null);
      setDraft({ title: "", artist: "", genre: "", language: "", durationSeconds: "" });
      setAudioFile(null);
      setAdminAudioUrl("");
      setDetectedAudioDurationMs(null);
      setAdminPlayheadMs(0);
      setLyrics([]);
      setNotes([]);
      setReviewed(false);
      setTranscribeState(createInitialTranscribeState());
      if (adminFileInputRef.current) adminFileInputRef.current.value = "";
      formElement.reset();
      await loadSongs(filteredTitle);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        handleSessionExpired();
      } else {
        setError(prettyError(e));
        setUploadStatus(
          activeDraft
            ? "Upload paused on draft. Correct any timing/package issues and resume to finish publishing."
            : "Upload stopped before draft creation.",
        );
      }
    } finally {
      setUploadBusy(false);
    }
  }

  const favoritesCount = useMemo(
    () => songs.filter((song) => favoriteIds.has(song.id)).length,
    [songs, favoriteIds],
  );

  const recentCount = useMemo(() => {
    const available = new Set(songs.map((song) => song.id));
    return recentIds.filter((id) => available.has(id)).length;
  }, [songs, recentIds]);

  const scoringStatus = useMemo(
    () => describePackageScoringStatus(selectedPackage, selectedSong),
    [selectedPackage, selectedSong],
  );

  const activeNavTab = bottomNavTabForView(activeView);
  const currentThemePreset =
    THEME_PRESETS.find((preset) => preset.id === preferences.theme) ?? THEME_PRESETS[0]!;

  const prevSong = getAdjacentSong({
    queue,
    catalog: songs,
    currentSongId: selectedSong?.id ?? null,
    direction: -1,
  });
  const nextSong = getAdjacentSong({
    queue,
    catalog: songs,
    currentSongId: selectedSong?.id ?? null,
    direction: 1,
  });

  if (checkingSession) {
    return (
      <main className={styles.centerState}>
        <span className={styles.loader} />
        Checking your session…
      </main>
    );
  }

  if (!user) {
    return (
      <main className={styles.authPage}>
        <section className={styles.authCard}>
          <div className={styles.brandMark} aria-hidden="true">
            ♫
          </div>
          <p className={styles.eyebrow}>YOUR STAGE, YOUR SONGS</p>
          <h1>Welcome back</h1>
          <p className={styles.muted}>Sign in to open your karaoke library.</p>
          <form onSubmit={submitLogin} className={styles.formStack}>
            <label>
              Username or email
              <input
                autoComplete="username"
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                required
                maxLength={254}
              />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                maxLength={128}
              />
            </label>
            {error && (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}
            <button className={styles.primaryButton} disabled={authBusy}>
              {authBusy ? "Signing in…" : "Sign in"}
            </button>
          </form>
          <p className={styles.footnote}>Account registration is managed by your administrator.</p>
        </section>
      </main>
    );
  }

  const effectiveDurationMs = Math.max(playerDurationMs, selectedSong?.duration_ms ?? 0, 1);

  return (
    <main className={styles.appShell}>
      <header className={styles.topbar}>
        <div className={styles.topbarLeft}>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Open navigation menu"
            aria-expanded={drawerOpen}
            aria-controls="nav-drawer"
            onClick={() => setDrawerOpen(true)}
          >
            ☰
          </button>
          <button
            type="button"
            className={styles.brandButton}
            aria-label="Karaoke library home"
            onClick={() => handleViewChange("library")}
          >
            <span className={styles.brandMarkSmall} aria-hidden="true">
              ♫
            </span>
            <span>Karaoke</span>
          </button>
        </div>

        <button
          type="button"
          className={styles.avatarButton}
          aria-label={`Open account (${user.display_name})`}
          onClick={() => handleViewChange("profile")}
        >
          <span className={styles.avatar} aria-hidden="true">
            {user.display_name.slice(0, 1).toUpperCase()}
          </span>
          <span className={styles.accountName}>{user.display_name}</span>
        </button>
      </header>

      {audioUrl && (
        <audio
          key={audioUrl}
          ref={playerAudioRef}
          className={styles.srAudio}
          preload="metadata"
          src={audioUrl}
          onLoadedMetadata={(e) => {
            const secs = e.currentTarget.duration;
            if (Number.isFinite(secs) && secs > 0) {
              setPlayerDurationMs(Math.round(secs * 1000));
            }
          }}
          onTimeUpdate={(e) => setPlayerPositionMs(Math.round(e.currentTarget.currentTime * 1000))}
          onSeeked={(e) => setPlayerPositionMs(Math.round(e.currentTarget.currentTime * 1000))}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => {
            setIsPlaying(false);
            if (nextSong) {
              void selectSong(nextSong, { openPlayer: activeView === "sing", autoPlay: true });
            }
          }}
          onError={() => {
            setIsPlaying(false);
            setError(
              "Could not load or seek audio from R2. Check bucket CORS settings or select the song again to refresh the temporary URL.",
            );
          }}
        />
      )}

      {message && (
        <div className={styles.success} role="status">
          <span>{message}</span>
          <button type="button" onClick={() => setMessage("")} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      {error && (
        <div className={styles.errorBanner} role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError("")} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {activeView === "library" && (
        <>
          <section className={styles.heroCard}>
            <div className={styles.heroTop}>
              <div>
                <p className={styles.eyebrow}>{getTimeGreeting()}</p>
                <h1>{user.display_name}</h1>
                <p className={styles.muted}>Pick a song, queue favorites, and sing along.</p>
              </div>
              <span className={styles.soundBars} aria-hidden="true">
                <i />
                <i />
                <i />
                <i />
                <i />
              </span>
            </div>
            <div className={styles.heroActions}>
              <button
                type="button"
                className={styles.primaryButton}
                disabled={songs.length === 0 && !selectedSong}
                onClick={handleStartSinging}
              >
                {selectedSong ? `Continue: ${selectedSong.title}` : "Start singing"}
              </button>
              {isAdmin && (
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => handleViewChange("admin")}
                >
                  + Add a song
                </button>
              )}
            </div>
          </section>

          <section className={styles.panel}>
            <div className={styles.sectionHeader}>
              <div>
                <p className={styles.eyebrow}>SONG LIBRARY</p>
                <h2>Catalog</h2>
              </div>
              <span className={styles.count}>{visibleSongs.length} shown</span>
            </div>

            <form
              className={styles.searchForm}
              onSubmit={(event) => {
                event.preventDefault();
                void loadSongs(query.trim());
              }}
            >
              <label className={styles.searchBox}>
                <span aria-hidden="true">⌕</span>
                <input
                  aria-label="Search by song or artist"
                  placeholder="Search by song or artist"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  maxLength={100}
                />
              </label>
              <button type="submit" className={styles.secondaryButton} disabled={loadingSongs}>
                {loadingSongs ? "…" : "Search"}
              </button>
              {query && (
                <button
                  type="button"
                  className={styles.secondaryButton}
                  disabled={loadingSongs}
                  onClick={() => {
                    setQuery("");
                    void loadSongs("");
                  }}
                >
                  Clear
                </button>
              )}
            </form>

            <div className={styles.filterRow} role="group" aria-label="Library filters">
              <button
                type="button"
                className={`${styles.filterChip} ${libraryFilter === "all" ? styles.filterChipActive : ""}`}
                aria-pressed={libraryFilter === "all"}
                onClick={() => setLibraryFilter("all")}
              >
                All ({songs.length})
              </button>
              <button
                type="button"
                className={`${styles.filterChip} ${
                  libraryFilter === "favorites" ? styles.filterChipActive : ""
                }`}
                aria-pressed={libraryFilter === "favorites"}
                onClick={() => setLibraryFilter("favorites")}
              >
                Favorites ({favoritesCount})
              </button>
              <button
                type="button"
                className={`${styles.filterChip} ${libraryFilter === "recent" ? styles.filterChipActive : ""}`}
                aria-pressed={libraryFilter === "recent"}
                onClick={() => setLibraryFilter("recent")}
              >
                Recent ({recentCount})
              </button>
            </div>

            <div className={styles.songList}>
              {loadingSongs && <p className={styles.emptyState}>Loading songs…</p>}
              {!loadingSongs && visibleSongs.length === 0 && (
                <div className={styles.emptyState}>
                  <span className={styles.emptyIcon} aria-hidden="true">
                    ♫
                  </span>
                  <strong>
                    {libraryFilter === "favorites"
                      ? "No favorite songs yet"
                      : libraryFilter === "recent"
                        ? "No recent songs yet"
                        : "No songs found"}
                  </strong>
                  <span>
                    {libraryFilter === "favorites"
                      ? "Tap the heart button on any song to save it here."
                      : libraryFilter === "recent"
                        ? "Songs you open to sing will appear here."
                        : "Try another title or artist."}
                  </span>
                </div>
              )}

              {visibleSongs.map((song) => {
                const isSelected = selectedSong?.id === song.id;
                const isFav = favoriteIds.has(song.id);
                const isQueued = queue.some((queued) => queued.id === song.id);
                return (
                  <div
                    key={song.id}
                    className={`${styles.songCard} ${isSelected ? styles.songCardActive : ""}`}
                  >
                    <button
                      type="button"
                      className={styles.songMainButton}
                      onClick={() => void selectSong(song, { openPlayer: true, autoPlay: true })}
                    >
                      <span className={styles.playBadge} aria-hidden="true">
                        {isSelected ? "♪" : "▶"}
                      </span>
                      <span className={styles.songText}>
                        <strong>{song.title}</strong>
                        <span className={styles.songMetaLine}>
                          <span>{song.artist}</span>
                          <span>· {formatDuration(song.duration_ms)}</span>
                        </span>
                      </span>
                    </button>
                    <span className={styles.songDuration}>{formatDuration(song.duration_ms)}</span>
                    <div className={styles.songCardActions}>
                      <button
                        type="button"
                        className={`${styles.favButton} ${isFav ? styles.favButtonActive : ""}`}
                        aria-pressed={isFav}
                        aria-label={
                          isFav
                            ? `Remove ${song.title} from favorites`
                            : `Add ${song.title} to favorites`
                        }
                        disabled={favoriteBusyId === song.id}
                        onClick={() => void toggleFavorite(song)}
                      >
                        {isFav ? "♥" : "♡"}
                      </button>
                      <button
                        type="button"
                        className={styles.queueIconButton}
                        aria-label={`Add ${song.title} to queue`}
                        onClick={() => addSongToQueue(song)}
                      >
                        {isQueued ? "Queued" : "+ Queue"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </>
      )}

      {activeView === "sing" && (
        <section className={styles.playerPanel} aria-label="Karaoke player">
          {!selectedSong ? (
            <div className={styles.emptyState}>
              <span className={styles.emptyIcon} aria-hidden="true">
                ♫
              </span>
              <strong>Choose a song to sing</strong>
              <span>Pick any track from your library or queue to load audio and timed lyrics.</span>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => handleViewChange("library")}
              >
                Browse Song library
              </button>
            </div>
          ) : (
            <>
              <div className={styles.playerHeader}>
                <div className={styles.playerTitle}>
                  <span className={styles.playBadge} aria-hidden="true">
                    ♫
                  </span>
                  <span>
                    <strong>{selectedSong.title}</strong>
                    <small>
                      {selectedSong.artist}
                      {selectedSong.genre ? ` · ${selectedSong.genre}` : ""}
                    </small>
                  </span>
                </div>
                <div className={styles.songCardActions}>
                  <button
                    type="button"
                    className={`${styles.favButton} ${
                      favoriteIds.has(selectedSong.id) ? styles.favButtonActive : ""
                    }`}
                    aria-pressed={favoriteIds.has(selectedSong.id)}
                    aria-label={
                      favoriteIds.has(selectedSong.id)
                        ? `Remove ${selectedSong.title} from favorites`
                        : `Add ${selectedSong.title} to favorites`
                    }
                    onClick={() => void toggleFavorite(selectedSong)}
                  >
                    {favoriteIds.has(selectedSong.id) ? "♥" : "♡"}
                  </button>
                  <button
                    type="button"
                    className={styles.queueIconButton}
                    onClick={() => addSongToQueue(selectedSong)}
                  >
                    + Queue
                  </button>
                </div>
              </div>

              <div className={styles.scoringBanner} role="note">
                <span>{scoringStatus.label}</span>
              </div>

              <div className={styles.lyricsStage}>
                <div className={styles.stageMeta}>
                  <span className={styles.eyebrow} style={{ margin: 0 }}>
                    SYNCHRONIZED LYRICS
                  </span>
                  <span className={styles.mutedSmall}>
                    {loadingAudio ? "Loading audio…" : formatTimeMs(playerPositionMs)}
                  </span>
                </div>
                {selectedPackage && selectedPackage.lyrics.length > 0 ? (
                  <div className={styles.lyricsLinesList} role="list">
                    {selectedPackage.lyrics.map((line, i) => {
                      const isActive = i === playerActiveLyricIndex;
                      const isPast = playerPositionMs >= line.endMs && !isActive;
                      return (
                        <button
                          key={`${line.startMs}-${i}`}
                          ref={isActive ? activeLyricRef : undefined}
                          type="button"
                          role="listitem"
                          aria-current={isActive ? "true" : undefined}
                          className={
                            isActive
                              ? styles.stageLineActive
                              : isPast
                                ? styles.stageLinePast
                                : styles.stageLine
                          }
                          onClick={() => seekPlayerToMs(line.startMs)}
                        >
                          <span>{line.text}</span>
                          <small>{formatTimeMs(line.startMs)}</small>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className={styles.emptyState} style={{ minHeight: "110px" }}>
                    <strong>
                      {loadingAudio ? "Preparing audio & lyrics…" : "Timed lyrics unavailable"}
                    </strong>
                    <span>Audio playback and seeking remain ready below.</span>
                  </div>
                )}
              </div>

              <div className={styles.progressControls}>
                <input
                  type="range"
                  className={styles.progressSlider}
                  aria-label="Playback progress"
                  min={0}
                  max={effectiveDurationMs}
                  value={Math.min(playerPositionMs, effectiveDurationMs)}
                  disabled={!audioUrl || loadingAudio}
                  onChange={(e) => seekPlayerToMs(Number(e.target.value))}
                />
                <div className={styles.timeRow}>
                  <span>{formatTimeMs(playerPositionMs)}</span>
                  <span>{formatTimeMs(effectiveDurationMs)}</span>
                </div>
              </div>

              <div className={styles.transportRow}>
                <button
                  type="button"
                  className={styles.transportSecondary}
                  aria-label="Previous song"
                  disabled={!prevSong && playerPositionMs <= 3000}
                  onClick={() => stepTrack(-1)}
                >
                  Prev
                </button>
                <button
                  type="button"
                  className={styles.transportPlay}
                  aria-label={isPlaying ? "Pause playback" : "Play song"}
                  disabled={!audioUrl || loadingAudio}
                  onClick={togglePlayPause}
                >
                  {loadingAudio ? "Loading…" : isPlaying ? "Pause" : "Play"}
                </button>
                <button
                  type="button"
                  className={styles.transportSecondary}
                  aria-label="Next song"
                  disabled={!nextSong}
                  onClick={() => stepTrack(1)}
                >
                  Next
                </button>
              </div>

              <div className={styles.tempoRow}>
                <span className={styles.mutedSmall}>Tempo (playback speed · preserves pitch)</span>
                <div className={styles.pillGroup} role="group" aria-label="Playback tempo">
                  {SUPPORTED_TEMPO_RATES.map((rate) => (
                    <button
                      key={rate}
                      type="button"
                      className={`${styles.pillChoice} ${
                        tempo === rate ? styles.pillChoiceActive : ""
                      }`}
                      aria-pressed={tempo === rate}
                      onClick={() => setTempo(rate)}
                    >
                      {rate === 1 ? "1.0×" : `${rate}×`}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </section>
      )}

      {activeView === "queue" && (
        <section className={styles.panel}>
          <div className={styles.sectionHeader}>
            <div>
              <p className={styles.eyebrow}>UP NEXT</p>
              <h2>Queue</h2>
            </div>
            {queue.length > 0 && (
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => setQueue([])}
              >
                Clear queue
              </button>
            )}
          </div>

          {selectedSong && (
            <div className={styles.draftResume} style={{ marginBottom: "12px" }}>
              <span>
                Now loaded: <strong>{selectedSong.title}</strong> · {selectedSong.artist}
              </span>
              <button
                type="button"
                className={styles.miniButton}
                onClick={() => handleViewChange("sing")}
              >
                Open player
              </button>
            </div>
          )}

          {queue.length === 0 ? (
            <div className={styles.emptyState}>
              <span className={styles.emptyIcon} aria-hidden="true">
                ☰
              </span>
              <strong>Your queue is empty</strong>
              <span>Tap “+ Queue” on songs in the library to line up your next tracks.</span>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => handleViewChange("library")}
              >
                Find songs
              </button>
            </div>
          ) : (
            <div className={styles.songList}>
              {queue.map((song, index) => (
                <div key={song.id} className={styles.queueItem}>
                  <button
                    type="button"
                    className={styles.songMainButton}
                    onClick={() => void selectSong(song, { openPlayer: true, autoPlay: true })}
                  >
                    <span className={styles.playBadge}>{index + 1}</span>
                    <span className={styles.songText}>
                      <strong>{song.title}</strong>
                      <span className={styles.songMetaLine}>
                        <span>{song.artist}</span>
                        <span>· {formatDuration(song.duration_ms)}</span>
                      </span>
                    </span>
                  </button>
                  <div className={styles.rowActions}>
                    <button
                      type="button"
                      className={styles.miniButton}
                      aria-label={`Move ${song.title} up`}
                      disabled={index === 0}
                      onClick={() => setQueue((prev) => moveQueueSong(prev, index, -1))}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className={styles.miniButton}
                      aria-label={`Move ${song.title} down`}
                      disabled={index === queue.length - 1}
                      onClick={() => setQueue((prev) => moveQueueSong(prev, index, 1))}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className={styles.miniButton}
                      aria-label={`Remove ${song.title} from queue`}
                      onClick={() => setQueue((prev) => removeQueueSong(prev, song.id))}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {activeView === "profile" && (
        <section className={styles.panel}>
          <div className={styles.sectionHeader}>
            <div>
              <p className={styles.eyebrow}>ACCOUNT</p>
              <h2>{user.display_name}</h2>
            </div>
            <span className={styles.adminTag}>{user.role}</span>
          </div>
          <p className={styles.muted}>
            Signed in as <strong>@{user.username}</strong> ({user.email})
          </p>

          <div className={styles.profileStats}>
            <div className={styles.statTile}>
              <strong>{favoritesCount}</strong>
              <span>Favorites</span>
            </div>
            <div className={styles.statTile}>
              <strong>{recentCount}</strong>
              <span>Recent</span>
            </div>
            <div className={styles.statTile}>
              <strong>{currentThemePreset.name}</strong>
              <span>Theme</span>
            </div>
          </div>

          <div className={styles.profileMenu}>
            <button
              type="button"
              className={styles.drawerItem}
              onClick={() => handleViewChange("preferences")}
            >
              <span className={styles.drawerItemBody}>
                <strong>Preferences</strong>
                <small>Theme colors, lyric text size, and reduced motion</small>
              </span>
              <span className={styles.drawerBadge}>{currentThemePreset.name}</span>
            </button>

            {isAdmin && (
              <button
                type="button"
                className={styles.drawerItem}
                onClick={() => handleViewChange("admin")}
              >
                <span className={styles.drawerItemBody}>
                  <strong>Manage songs · Add a song</strong>
                  <small>Upload audio and author timed lyrics packages</small>
                </span>
                <span className={styles.drawerBadge}>ADMIN</span>
              </button>
            )}

            <button
              type="button"
              className={styles.drawerItem}
              onClick={() => handleViewChange("help")}
            >
              <span className={styles.drawerItemBody}>
                <strong>Help / About</strong>
                <small>How lyrics sync, R2 audio, and scoring status work</small>
              </span>
            </button>

            <button
              type="button"
              className={styles.dangerButton}
              style={{ marginTop: "8px" }}
              onClick={() => void signOut()}
            >
              Sign out
            </button>
          </div>
        </section>
      )}

      {activeView === "preferences" && (
        <section className={styles.panel}>
          <div className={styles.sectionHeader}>
            <div>
              <p className={styles.eyebrow}>PREFERENCES</p>
              <h2>Appearance & Playback</h2>
            </div>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => handleViewChange("profile")}
            >
              Back
            </button>
          </div>

          <div className={styles.prefBlock}>
            <strong>Color theme</strong>
            <p className={styles.mutedSmall}>
              Saved on this device and applied across cards, controls, and the karaoke player.
            </p>
            <div className={styles.themeGrid} role="radiogroup" aria-label="Color theme">
              {THEME_PRESETS.map((preset) => {
                const selected = preferences.theme === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={`${styles.themeCard} ${selected ? styles.themeCardActive : ""}`}
                    onClick={() => updatePreferences({ theme: preset.id })}
                  >
                    <div className={styles.themeCardHeader}>
                      <strong>{preset.name}</strong>
                      {selected ? (
                        <span className={styles.drawerBadge}>Active</span>
                      ) : preset.isDefault ? (
                        <span className={styles.count}>Default</span>
                      ) : null}
                    </div>
                    <div className={styles.themeSwatches} aria-hidden="true">
                      {preset.swatches.map((hex) => (
                        <span
                          key={hex}
                          className={styles.themeSwatch}
                          style={{ backgroundColor: hex }}
                        />
                      ))}
                    </div>
                    <p>{preset.description}</p>
                  </button>
                );
              })}
            </div>
          </div>

          <div className={styles.prefBlock}>
            <strong>Lyric text size</strong>
            <div className={styles.pillGroup} role="radiogroup" aria-label="Lyric text size">
              {(
                [
                  { id: "sm", label: "Compact" },
                  { id: "md", label: "Standard" },
                  { id: "lg", label: "Large" },
                ] as Array<{ id: LyricSize; label: string }>
              ).map((size) => (
                <button
                  key={size.id}
                  type="button"
                  role="radio"
                  aria-checked={preferences.lyricSize === size.id}
                  className={`${styles.pillChoice} ${
                    preferences.lyricSize === size.id ? styles.pillChoiceActive : ""
                  }`}
                  onClick={() => updatePreferences({ lyricSize: size.id })}
                >
                  {size.label}
                </button>
              ))}
            </div>
          </div>

          <div className={styles.prefBlock}>
            <div className={styles.switchRow}>
              <div>
                <strong>Reduce motion</strong>
                <p className={styles.mutedSmall}>
                  Minimizes transitions and disables smooth lyric auto-scrolling.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={preferences.reducedMotion}
                className={`${styles.switchButton} ${
                  preferences.reducedMotion ? styles.switchButtonOn : ""
                }`}
                onClick={() =>
                  updatePreferences({ reducedMotion: !preferences.reducedMotion })
                }
              >
                {preferences.reducedMotion ? "On" : "Off"}
              </button>
            </div>
          </div>
        </section>
      )}

      {activeView === "help" && (
        <section className={styles.panel}>
          <div className={styles.sectionHeader}>
            <div>
              <p className={styles.eyebrow}>ABOUT</p>
              <h2>Help & Playback Notes</h2>
            </div>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => handleViewChange("library")}
            >
              Library
            </button>
          </div>
          <div className={styles.formStack}>
            <p className={styles.muted}>
              <strong>Same-origin & private media:</strong> API requests stay on this origin
              (`<code>/api/*</code>`), while song audio and lyric packages load directly from
              private R2 storage using temporary signed links.
            </p>
            <p className={styles.muted}>
              <strong>Favorites & recent songs:</strong> Favorites sync with your account on the
              server (`All`, `Favorites`, and `Recent` filters in the library), while your recent
              history, queue, and theme preferences stay lightweight in your browser.
            </p>
            <p className={styles.muted}>
              <strong>Lyrics & scoring availability:</strong> Songs with timed lyrics highlight the
              active line as you sing; tap any lyric line to jump to that timestamp. Pitch scoring
              and live microphone grading are unavailable in this web player and are never faked.
            </p>
          </div>
        </section>
      )}

      {activeView === "admin" && isAdmin && (
        <section className={styles.panel}>
          <div className={styles.sectionHeader}>
            <div>
              <p className={styles.eyebrow}>ADMIN TOOLS</p>
              <h2>Manage songs · Add a song</h2>
            </div>
            <span className={styles.adminTag}>ADMIN</span>
          </div>
          <p className={styles.muted}>
            Author timed lyrics directly in the browser—no manual JSON file required. Audio and
            generated packages upload straight to R2.
          </p>
          <form className={styles.formStack} onSubmit={createAndUpload}>
            <div className={styles.twoFields}>
              <label>
                Song title
                <input
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  required
                  maxLength={200}
                />
              </label>
              <label>
                Artist
                <input
                  value={draft.artist}
                  onChange={(e) => setDraft({ ...draft, artist: e.target.value })}
                  required
                  maxLength={200}
                />
              </label>
            </div>
            <div className={styles.twoFields}>
              <label>
                Genre <span className={styles.optional}>optional</span>
                <input
                  value={draft.genre}
                  onChange={(e) => setDraft({ ...draft, genre: e.target.value })}
                  maxLength={60}
                />
              </label>
              <label>
                Language <span className={styles.optional}>optional</span>
                <input
                  value={draft.language}
                  onChange={(e) => setDraft({ ...draft, language: e.target.value })}
                  maxLength={60}
                />
              </label>
            </div>
            <label>
              Audio file{" "}
              <span className={styles.optional}>MP3, WAV, OGG, or M4A · up to 20 MB</span>
              <input
                ref={adminFileInputRef}
                type="file"
                accept=".mp3,.wav,.ogg,.m4a,.mp4,audio/mpeg,audio/wav,audio/ogg,audio/mp4"
                onChange={handleAudioFileChange}
                required={!activeDraft?.audioDone}
              />
            </label>

            {adminAudioUrl && (
              <div className={styles.adminAudioBox}>
                <audio
                  ref={adminAudioRef}
                  controls
                  preload="metadata"
                  src={adminAudioUrl}
                  aria-label="Preview song audio for lyric timing"
                  onLoadedMetadata={(e) => {
                    const secs = e.currentTarget.duration;
                    if (Number.isFinite(secs) && secs >= 1 && secs <= 1800) {
                      const ms = Math.round(secs * 1000);
                      setDetectedAudioDurationMs(ms);
                      setDraft((prev) =>
                        prev.durationSeconds
                          ? prev
                          : { ...prev, durationSeconds: String(ms / 1000) },
                      );
                    }
                  }}
                  onTimeUpdate={(e) =>
                    setAdminPlayheadMs(Math.round(e.currentTarget.currentTime * 1000))
                  }
                  onSeeked={(e) =>
                    setAdminPlayheadMs(Math.round(e.currentTarget.currentTime * 1000))
                  }
                />
                {detectedAudioDurationMs !== null && (
                  <div className={styles.builderToolbar}>
                    <span className={styles.mutedSmall}>
                      Detected audio length: {(detectedAudioDurationMs / 1000).toString()}s (
                      {detectedAudioDurationMs} ms)
                    </span>
                    <button
                      type="button"
                      className={styles.miniButton}
                      disabled={uploadBusy}
                      onClick={() =>
                        setDraft((prev) => ({
                          ...prev,
                          durationSeconds: String(detectedAudioDurationMs / 1000),
                        }))
                      }
                    >
                      Match song duration
                    </button>
                  </div>
                )}
              </div>
            )}

            <label>
              Duration (seconds){" "}
              <span className={styles.optional}>1–1800s · defines package durationMs</span>
              <input
                type="number"
                min="1"
                max="1800"
                step="any"
                inputMode="decimal"
                value={draft.durationSeconds}
                onChange={(e) => setDraft({ ...draft, durationSeconds: e.target.value })}
                required
              />
            </label>

            {!activeDraft?.audioDone && audioFile && (
              <button
                type="button"
                className={styles.secondaryButton}
                style={{ minHeight: "42px" }}
                disabled={uploadBusy}
                onClick={() => void uploadAudioToDraftFirst()}
              >
                1. Upload audio to draft first (optional before timing review)
              </button>
            )}

            <ScoringPackageBuilder
              durationMs={parsedDurationMs}
              hasDuration={hasValidDuration}
              hasAudioSource={Boolean(adminAudioUrl)}
              playheadMs={adminPlayheadMs}
              lyrics={lyrics}
              notes={notes}
              reviewed={reviewed}
              disabled={uploadBusy}
              canTranscribe={
                (Boolean(activeDraft?.audioDone) ||
                  (Boolean(audioFile) &&
                    Boolean(draft.title.trim()) &&
                    Boolean(draft.artist.trim()) &&
                    hasValidDuration)) &&
                parsedDurationMs <= 360_000 &&
                (!audioFile || audioFile.size <= 5_000_000)
              }
              transcribeBusy={transcribeState.busy}
              transcribeError={transcribeState.error}
              transcribeNotice={transcribeState.notice}
              transcribeDisabledHint={
                audioFile && audioFile.size > 5_000_000
                  ? "Auto-transcription is limited to audio files up to 5 MB. Larger tracks can still be uploaded and timed manually."
                  : parsedDurationMs > 360_000
                    ? "Auto-transcription is limited to tracks up to 6 minutes. Longer tracks can still be uploaded and timed manually."
                    : "Enter song title, artist, valid duration, and choose an audio file (up to 5 MB, 6 min) to generate lyrics from uploaded audio."
              }
              pendingTranscript={transcribeState.pendingDraft}
              onChangeLyrics={setLyrics}
              onChangeNotes={setNotes}
              onChangeReviewed={setReviewed}
              onSeekToMs={seekAdminAudio}
              onGenerateLyrics={() => void generateLyricsFromSongAudio()}
              onResolvePendingTranscript={handleResolvePendingTranscript}
            />

            {uploadBusy && (
              <div className={styles.uploadProgress}>
                <div className={styles.progressCaption}>
                  <span>{uploadStatus}</span>
                  <span>{uploadProgress}%</span>
                </div>
                <div className={styles.progressTrack}>
                  <span style={{ width: `${uploadProgress}%` }} />
                </div>
              </div>
            )}
            {!uploadBusy && uploadStatus && <p className={styles.footnote}>{uploadStatus}</p>}
            {activeDraft && !uploadBusy && (
              <div className={styles.draftResume}>
                <span>
                  Draft <strong>{activeDraft.title}</strong> (
                  {activeDraft.audioDone ? "audio uploaded" : "audio pending"},{" "}
                  {activeDraft.packageDone ? "package uploaded" : "package pending"})
                </span>
                <button
                  type="button"
                  className={styles.textButton}
                  onClick={() => {
                    setActiveDraft(null);
                    setUploadStatus("");
                  }}
                >
                  Start new draft
                </button>
              </div>
            )}
            <button type="submit" className={styles.primaryButton} disabled={uploadBusy}>
              {uploadBusy
                ? "Working…"
                : activeDraft?.audioDone
                  ? "Upload package and publish"
                  : activeDraft
                    ? "Resume upload and publish"
                    : "Upload audio + package and publish"}
            </button>
          </form>
          <p className={styles.footnote}>
            The backend validates the uploaded audio signature and generated package schema before
            publishing. A failed step preserves your draft so you can fix timings without
            re-uploading completed assets.
          </p>
        </section>
      )}

      <NavigationDrawer
        open={drawerOpen}
        user={user}
        activeView={activeView}
        queueCount={queue.length}
        onClose={() => setDrawerOpen(false)}
        onSelectView={handleViewChange}
        onSignOut={() => void signOut()}
      />

      <div className={styles.bottomChrome}>
        {selectedSong && activeView !== "sing" && (
          <div className={styles.miniPlayer}>
            <button
              type="button"
              className={styles.miniPlayerOpen}
              onClick={() => handleViewChange("sing")}
            >
              <span className={styles.playBadge} aria-hidden="true">
                ♫
              </span>
              <span className={styles.miniPlayerText}>
                <strong>{selectedSong.title}</strong>
                <small>
                  {selectedSong.artist} · {formatTimeMs(playerPositionMs)}
                </small>
              </span>
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              style={{ minHeight: "40px" }}
              disabled={!audioUrl || loadingAudio}
              onClick={togglePlayPause}
            >
              {isPlaying ? "Pause" : "Play"}
            </button>
          </div>
        )}

        <nav className={styles.bottomNav} aria-label="Bottom navigation">
          {(
            [
              { id: "library", label: "Library", icon: "♫" },
              { id: "sing", label: "Sing", icon: "♪" },
              { id: "queue", label: queue.length > 0 ? `Queue (${queue.length})` : "Queue", icon: "☰" },
              { id: "profile", label: "Profile", icon: "☺" },
            ] as const
          ).map((tab) => {
            const selected = activeNavTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                className={`${styles.navTab} ${selected ? styles.navTabActive : ""}`}
                aria-current={selected ? "page" : undefined}
                onClick={() => handleViewChange(tab.id)}
              >
                <span aria-hidden="true">{tab.icon}</span>
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>
      </div>
    </main>
  );
}
