"use client";

import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ScoringPackageBuilder } from "@/components/ScoringPackageBuilder";
import {
  api,
  ApiError,
  DownloadResponse,
  mediaType,
  putDirectlyToR2,
  Song,
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
import styles from "./page.module.css";

type SongListResponse = { data: Song[]; page: number; pageSize: number };
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
  const [query, setQuery] = useState("");
  const [songs, setSongs] = useState<Song[]>([]);
  const [loadingSongs, setLoadingSongs] = useState(false);
  const [selectedSong, setSelectedSong] = useState<Song | null>(null);
  const [audioUrl, setAudioUrl] = useState("");
  const [selectedPackage, setSelectedPackage] = useState<SongPackage | null>(null);
  const [playerPositionMs, setPlayerPositionMs] = useState(0);
  const [loadingAudio, setLoadingAudio] = useState(false);
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

  const downloadReqRef = useRef(0);
  const adminAudioRef = useRef<HTMLAudioElement | null>(null);
  const adminFileInputRef = useRef<HTMLInputElement | null>(null);

  const isAdmin = user?.role === "ADMIN";
  const filteredTitle = useMemo(() => query.trim(), [query]);
  const parsedDurationMs = useMemo(() => {
    if (!draft.durationSeconds.trim()) return 0;
    return Math.round(Number(draft.durationSeconds) * 1000);
  }, [draft.durationSeconds]);
  const hasValidDuration =
    Number.isFinite(parsedDurationMs) && parsedDurationMs >= 1000 && parsedDurationMs <= 1800000;

  useEffect(() => {
    return () => {
      if (adminAudioUrl) URL.revokeObjectURL(adminAudioUrl);
    };
  }, [adminAudioUrl]);

  const handleSessionExpired = useCallback(() => {
    downloadReqRef.current++;
    setUser(null);
    setSongs([]);
    setSelectedSong(null);
    setAudioUrl("");
    setSelectedPackage(null);
    setLoadingAudio(false);
    setError("Your session has expired. Please sign in again.");
  }, []);

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

  const loadSession = useCallback(async () => {
    try {
      const result = await api<{ user: User }>("/auth/me");
      setUser(result.user);
      void loadSongs();
    } catch {
      setUser(null);
    } finally {
      setCheckingSession(false);
    }
  }, [loadSongs]);

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
      setQuery("");
      void loadSongs("");
      setPassword("");
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
    try {
      await api<void>("/auth/logout", { method: "POST", body: "{}" });
    } catch (e) {
      setError(prettyError(e));
    } finally {
      setUser(null);
      setSongs([]);
      setSelectedSong(null);
      setAudioUrl("");
      setSelectedPackage(null);
      setPlayerPositionMs(0);
      setLoadingAudio(false);
      setActiveDraft(null);
      setUploadStatus("");
      setUploadProgress(0);
    }
  }

  async function selectSong(song: Song) {
    const reqId = ++downloadReqRef.current;
    setSelectedSong(song);
    setAudioUrl("");
    setSelectedPackage(null);
    setPlayerPositionMs(0);
    setLoadingAudio(true);
    setError("");
    try {
      const result = await api<DownloadResponse>(`/songs/${encodeURIComponent(song.id)}/download`);
      if (downloadReqRef.current !== reqId) return;
      setAudioUrl(result.audioUrl);
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

  function handleAudioFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setAudioFile(file);
    setDetectedAudioDurationMs(null);
    setAdminPlayheadMs(0);
    setAdminAudioUrl(file ? URL.createObjectURL(file) : "");
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

  const playerActiveLyricIndex = useMemo(
    () => (selectedPackage ? findActiveLyricIndex(selectedPackage.lyrics, playerPositionMs) : -1),
    [selectedPackage, playerPositionMs],
  );

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

  return (
    <main className={styles.appShell}>
      <header className={styles.topbar}>
        <Link className={styles.brand} href="/" aria-label="Karaoke home">
          <span className={styles.brandMarkSmall}>♫</span>
          <span>Karaoke</span>
        </Link>
        <div className={styles.account}>
          <span className={styles.avatar}>{user.display_name.slice(0, 1).toUpperCase()}</span>
          <span className={styles.accountName}>{user.display_name}</span>
          <button type="button" className={styles.textButton} onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>

      <section className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>SING ALONG</p>
          <h1>Find your next song.</h1>
          <p className={styles.muted}>Your music and timed lyrics library, ready when you are.</p>
        </div>
        <div className={styles.heroNote}>
          <span className={styles.soundBars}>
            <i />
            <i />
            <i />
            <i />
            <i />
          </span>
          <span>Pick a song and make it yours.</span>
        </div>
      </section>

      {message && (
        <div className={styles.success} role="status">
          {message}
          <button type="button" onClick={() => setMessage("")} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      {error && (
        <div className={styles.errorBanner} role="alert">
          {error}
          <button type="button" onClick={() => setError("")} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <div className={styles.contentGrid}>
        <section className={styles.panel}>
          <div className={styles.sectionHeader}>
            <div>
              <p className={styles.eyebrow}>LIBRARY</p>
              <h2>Song catalog</h2>
            </div>
            <span className={styles.count}>{songs.length} songs</span>
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
                placeholder="Search by title or artist"
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
          <div className={styles.songList}>
            {loadingSongs && <p className={styles.emptyState}>Loading songs…</p>}
            {!loadingSongs && songs.length === 0 && (
              <div className={styles.emptyState}>
                <span className={styles.emptyIcon}>♫</span>
                <strong>No songs found</strong>
                <span>Try another title or artist.</span>
              </div>
            )}
            {songs.map((song) => (
              <button
                type="button"
                key={song.id}
                className={`${styles.songRow} ${selectedSong?.id === song.id ? styles.songRowActive : ""}`}
                onClick={() => void selectSong(song)}
              >
                <span className={styles.playBadge}>{selectedSong?.id === song.id ? "♪" : "▶"}</span>
                <span className={styles.songText}>
                  <strong>{song.title}</strong>
                  <span>{song.artist}</span>
                </span>
                <span className={styles.songDuration}>{formatDuration(song.duration_ms)}</span>
              </button>
            ))}
          </div>
          {selectedSong && (
            <div className={styles.player}>
              <div className={styles.playerTitle}>
                <span className={styles.playBadge}>♫</span>
                <span>
                  <strong>{selectedSong.title}</strong>
                  <small>{selectedSong.artist}</small>
                </span>
              </div>
              {audioUrl && !loadingAudio ? (
                <audio
                  key={audioUrl}
                  controls
                  preload="metadata"
                  src={audioUrl}
                  aria-label={`Play ${selectedSong.title}`}
                  onTimeUpdate={(e) =>
                    setPlayerPositionMs(Math.round(e.currentTarget.currentTime * 1000))
                  }
                  onSeeked={(e) =>
                    setPlayerPositionMs(Math.round(e.currentTarget.currentTime * 1000))
                  }
                  onError={() =>
                    setError(
                      "Could not load or seek audio from R2. Check bucket CORS settings or select the song again to refresh the temporary URL.",
                    )
                  }
                />
              ) : (
                <span className={styles.mutedSmall}>Preparing secure audio…</span>
              )}
              {selectedPackage && (
                <div className={styles.lyricsStage}>
                  <div className={styles.stageMeta}>
                    <span className={styles.mutedSmall}>
                      {selectedPackage.notes.length > 0
                        ? `Timed lyrics + ${selectedPackage.notes.length} target notes (audio & lyrics playback active; pitch scoring not included)`
                        : "Timed lyrics only · pitch scoring unavailable"}
                    </span>
                    <span className={styles.mutedSmall}>{formatTimeMs(playerPositionMs)}</span>
                  </div>
                  <div className={styles.lyricsLinesList}>
                    {selectedPackage.lyrics.map((line, i) => (
                      <div
                        key={`${line.startMs}-${i}`}
                        className={
                          i === playerActiveLyricIndex
                            ? styles.stageLineActive
                            : playerPositionMs >= line.endMs
                              ? styles.stageLinePast
                              : styles.stageLine
                        }
                      >
                        <span>{line.text}</span>
                        <small>{formatTimeMs(line.startMs)}</small>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <p className={styles.footnote}>
                Use the player timeline to seek. Audio streams from private R2 storage.
              </p>
            </div>
          )}
        </section>

        {isAdmin && (
          <section className={styles.panel}>
            <div className={styles.sectionHeader}>
              <div>
                <p className={styles.eyebrow}>ADMIN TOOLS</p>
                <h2>Add a song</h2>
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
                  style={{ minHeight: "38px" }}
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
                onChangeLyrics={setLyrics}
                onChangeNotes={setNotes}
                onChangeReviewed={setReviewed}
                onSeekToMs={seekAdminAudio}
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
      </div>
      <footer className={styles.footer}>Karaoke · private by design</footer>
    </main>
  );
}
