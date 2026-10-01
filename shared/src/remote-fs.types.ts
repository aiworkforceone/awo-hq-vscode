/**
 * hq-vscode phase 2: the wire types of the workspace file routes (`/api/remote/orgs/:org/workspaces/
 * :ws/fs/*`) and of the events socket (`/ws/remote/events`), shared by kr-api and `hq-client`
 * (FEATURE.md Data Model, "Wire types"). Paths are ALWAYS relative to the team root, '/'-separated,
 * and never start with '/'. The root itself is ''.
 */

/** The longest `?path=` (UTF-8 bytes) a route accepts. */
export const FS_MAX_PATH_BYTES = 4096;
/** Entries per listing page: default and ceiling. */
export const FS_PAGE_DEFAULT = 1000;
export const FS_PAGE_MAX = 2000;
/** Text is served masked in one response up to this size; larger text is 413 TOO_LARGE_TO_MASK. */
export const FS_MAX_TEXT_BYTES = 8 * 1024 * 1024;
/** One relayed read chunk (a binary is read in chunks of at most this, with `Range`). */
export const FS_READ_CHUNK_BYTES = 4 * 1024 * 1024;
/** Binaries larger than this are 413 TOO_LARGE (`MAX_RELAY_FILE_BYTES`). */
export const FS_MAX_BINARY_BYTES = 64 * 1024 * 1024;
/** A single write body. */
export const FS_MAX_WRITE_BYTES = 16 * 1024 * 1024;
/**
 * Search: matches and preview width. The machine is asked for twice the matches (up to its own
 * 2000 cap) so lines dropped for a secret never decide `truncated`.
 */
export const FS_SEARCH_MAX_RESULTS = 1000;
export const FS_SEARCH_PREVIEW_COLUMNS = 400;
/** Search: include/exclude globs. */
export const FS_SEARCH_MAX_GLOBS = 50;
export const FS_SEARCH_MAX_GLOB_CHARS = 256;
export const FS_SEARCH_MAX_QUERY_CHARS = 1000;

export type FsEntryType = 'file' | 'dir' | 'symlink';

export interface FsStat {
  /** Relative to the team root ('' = the root). */
  path: string;
  type: FsEntryType;
  /**
   * The raw `lstat` size. A masked body can differ; VS Code uses size and mtime only for its
   * modified-since check, so this is harmless (review S3).
   */
  size: number;
  mtimeMs: number;
  /** Strong, from `lstat` (inode, size, mtime ns), never from the bytes (masked text differs). */
  etag: string;
  /** Why this path cannot be written through HQ (masked files are flagged by `X-HQ-Masked` on read). */
  readonly?: 'template' | 'credential';
  /** An ignored directory (node_modules, .venv, ...): listed, never descended implicitly. */
  ignored?: true;
}

export interface FsDirPage {
  /** The listed directory, echoed (an old runner that ignores `path` is caught by it). */
  path: string;
  entries: FsStat[];
  nextCursor?: string;
}

export interface FsSearchTextRequest {
  query: string;
  isRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  include?: string[];
  exclude?: string[];
  maxResults?: number;
}

export interface FsSearchMatch {
  path: string;
  /** 1-based. */
  line: number;
  /** 1-based, in the PREVIEW's coordinates (the preview is trimmed around the match). */
  column: number;
  /** Masked, at most `FS_SEARCH_PREVIEW_COLUMNS` columns. */
  preview: string;
  /** Length of the match inside the preview. */
  length: number;
}

export interface FsSearchTextResponse {
  matches: FsSearchMatch[];
  truncated: boolean;
  elapsedMs: number;
}

/** Request header / response header names of the file routes. */
export const HQ_HEADER_MASKED = 'x-hq-masked';
/**
 * fix/restore-no-auto-stop: a file-API call the extension makes ON ITS OWN (the periodic relist, a
 * stream-driven relist, its own-echo check, a resync) carries `X-HQ-Activity: background`, so the
 * server does not count it as a person working and an idle window never keeps a machine awake.
 * Anything else, the header absent included, is a person's action. An older server ignores it.
 */
export const HQ_HEADER_ACTIVITY = 'x-hq-activity';
export const HQ_ACTIVITY_BACKGROUND = 'background';

/** Who wrote, when the events stream knows. Names only. */
export interface FsChangeSource {
  kind: 'agent' | 'hq-web' | 'hq-vscode' | 'sftp';
  name?: string;
}

export interface FsChange {
  path: string;
  kind?: 'created' | 'changed' | 'deleted';
}

export type RemoteWorkspaceLiveState = 'running' | 'starting' | 'asleep' | 'stopped';

export type EventsServerFrame =
  | {
      type: 'fs-changed';
      workspaceId: string;
      seq: number;
      changes: FsChange[];
      source?: FsChangeSource;
    }
  | { type: 'workspace-state'; workspaceId: string; state: RemoteWorkspaceLiveState }
  | { type: 'listen-ports'; workspaceId: string; ports: number[] }
  | { type: 'resync'; workspaceId: string }
  | { type: 'subscribed'; workspaceId: string; state: RemoteWorkspaceLiveState; watch: boolean }
  | { type: 'unsubscribed'; workspaceId: string }
  | { type: 'error'; code: EventsErrorCode; workspaceId?: string };

export type EventsErrorCode =
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'TOO_MANY_SUBSCRIPTIONS'
  | 'BAD_FRAME'
  | 'THROTTLED';

export type EventsClientFrame =
  | { type: 'subscribe'; workspaceId: string }
  | { type: 'unsubscribe'; workspaceId: string }
  | { type: 'remote-token'; token: string };

/** Subscriptions per events socket, and events sockets per grant (FEATURE §4). */
export const EVENTS_MAX_SUBSCRIPTIONS = 8;
export const EVENTS_MAX_SOCKETS_PER_GRANT = 4;
/** The events socket path. */
export const REMOTE_EVENTS_WS_PATH = '/ws/remote/events';
