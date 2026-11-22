export type User = {
  id: string;
  username: string;
  email: string;
  display_name: string;
  role: "ADMIN" | "USER";
  is_active?: number;
  created_at?: number;
};

export type Song = {
  id: string;
  title: string;
  artist: string;
  genre: string | null;
  language: string | null;
  duration_ms: number;
  package_version: number;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  created_by?: string | null;
  created_at?: number;
  updated_at?: number;
  hasAudio: boolean;
  hasCover: boolean;
  scoringAvailable: boolean;
};

export type UploadIntent = {
  uploadId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  expiresIn: number;
};

export type DownloadResponse = {
  songId: string;
  packageVersion: number;
  durationMs: number;
  audioUrl: string;
  packageUrl: string;
  coverUrl: string | null;
  expiresIn: number;
};

type ApiValidationIssue = {
  path?: Array<string | number>;
  message?: string;
};

type ApiErrorBody = {
  error?: {
    code?: string;
    message?: string;
    issues?: ApiValidationIssue[];
  };
  message?: string;
  requestId?: string;
};

const configuredApiRoot = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "/api";

function getApiRoot(): string {
  if (
    typeof window !== "undefined" &&
    window.location.hostname === "127.0.0.1" &&
    configuredApiRoot.startsWith("http://localhost:")
  ) {
    return configuredApiRoot.replace("http://localhost:", "http://127.0.0.1:");
  }
  return configuredApiRoot;
}

function formatErrorMessage(status: number, body: ApiErrorBody): string {
  const base = body.error?.message || body.message || `Request failed (${status})`;
  const issues = body.error?.issues;
  if (!Array.isArray(issues) || issues.length === 0) return base;
  const details = issues
    .slice(0, 3)
    .map((issue) => {
      const path = Array.isArray(issue.path) && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${path}${issue.message || "Invalid value"}`;
    })
    .join("; ");
  return `${base} (${details})`;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  requestId?: string;

  constructor(status: number, body: ApiErrorBody) {
    super(formatErrorMessage(status, body));
    this.name = "ApiError";
    this.status = status;
    this.code = body.error?.code;
    this.requestId = body.requestId;
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  const response = await fetch(`${getApiRoot()}${path}`, {
    ...init,
    headers,
    credentials: "include",
    cache: "no-store",
  });

  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => ({}))) as ApiErrorBody & T;
  if (!response.ok) throw new ApiError(response.status, body);
  return body;
}

export type SongListResponse = {
  data: Song[];
  page: number;
  pageSize: number;
};

export async function listFavorites(page = 1, pageSize = 50): Promise<SongListResponse> {
  return api<SongListResponse>(`/favorites?page=${page}&pageSize=${pageSize}`);
}

export async function addFavorite(songId: string): Promise<void> {
  await api<void>(`/favorites/${encodeURIComponent(songId)}`, { method: "PUT" });
}

export async function removeFavorite(songId: string): Promise<void> {
  await api<void>(`/favorites/${encodeURIComponent(songId)}`, { method: "DELETE" });
}

export type TranscribeSongResponse = {
  data: {
    songId: string;
    model: string;
    language: string | null;
    hasTimestamps: boolean;
    lines: Array<{
      text: string;
      startMs: number | null;
      endMs: number | null;
    }>;
  };
};

export async function transcribeSongLyrics(
  songId: string,
  language?: string,
): Promise<TranscribeSongResponse["data"]> {
  const body = language?.trim() ? { language: language.trim() } : {};
  const result = await api<TranscribeSongResponse>(
    `/songs/${encodeURIComponent(songId)}/lyrics/transcribe`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
  return result.data;
}

export function mediaType(file: File, kind: "audio" | "package") {
  if (kind === "package") return "application/json";
  const known: Record<string, string> = {
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    m4a: "audio/mp4",
    mp4: "audio/mp4",
  };
  const ext = file.name.split(".").pop()?.toLowerCase() || "";
  return known[ext] || file.type;
}

export function putDirectlyToR2(
  url: string,
  method: string,
  headers: Record<string, string>,
  file: Blob,
  onProgress: (percent: number) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.withCredentials = false;
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`R2 upload failed (HTTP ${xhr.status}). Check the file and try again.`));
    };
    xhr.onerror = () =>
      reject(new Error("Could not reach R2. Check the network and bucket CORS settings."));
    xhr.onabort = () => reject(new Error("Upload was cancelled."));
    xhr.send(file);
  });
}
