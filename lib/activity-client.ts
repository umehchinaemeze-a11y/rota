/**
 * Client-side Activity Feed State Management, Keyset Pagination Controller & Deduplication.
 *
 * Implements:
 * - Duplicate request prevention (guards concurrent and overlapping triggers)
 * - Deterministic item deduplication across page appends
 * - Infinite scrolling cursor traversal
 * - Pull-to-refresh & retry handling
 * - Distinct loading, empty, error, and caught-up states
 */

import {
  type ActivityEventRecord,
  type ActivityFeedResponse,
  compareActivityRecordsDesc,
} from "./activity.ts";

export type { ActivityEventRecord };

export interface ActivityFeedState {
  events: ActivityEventRecord[];
  nextCursor: string | null;
  hasMore: boolean;
  initialLoading: boolean;
  loadingMore: boolean;
  refreshing: boolean;
  error: string | null;
}

export function createInitialActivityState(): ActivityFeedState {
  return {
    events: [],
    nextCursor: null,
    hasMore: true,
    initialLoading: false,
    loadingMore: false,
    refreshing: false,
    error: null,
  };
}

/**
 * Merges incoming activity pages into existing list with guaranteed ID deduplication
 * and stable descending ordering (created_at DESC, id DESC).
 */
export function mergeActivityPages(
  existing: ActivityEventRecord[],
  incoming: ActivityEventRecord[]
): ActivityEventRecord[] {
  const existingIds = new Set(existing.map((e) => e.id));
  const uniqueIncoming = incoming.filter((e) => !existingIds.has(e.id));
  const merged = [...existing, ...uniqueIncoming];
  merged.sort(compareActivityRecordsDesc);
  return merged;
}

export interface ActivityFetcherOptions {
  fetchFn?: typeof fetch;
  endpoint?: string;
  limit?: number;
}

/**
 * Controller for managing activity feed paging, concurrency locks, and state transitions.
 */
export class ActivityFeedController {
  private state: ActivityFeedState;
  private isFetching = false;
  private abortController: AbortController | null = null;
  private fetchFn: typeof fetch;
  private endpoint: string;
  private limit: number;
  private listeners: Set<(state: ActivityFeedState) => void> = new Set();

  constructor(options: ActivityFetcherOptions = {}) {
    this.state = createInitialActivityState();
    this.fetchFn = options.fetchFn ?? fetch.bind(globalThis);
    this.endpoint = options.endpoint ?? "/api/activity";
    this.limit = options.limit ?? 20;
  }

  public getState(): ActivityFeedState {
    return { ...this.state };
  }

  public subscribe(listener: (state: ActivityFeedState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  /**
   * Loads the initial/first page of the activity feed.
   * If a fetch is already in flight, duplicate requests are rejected.
   */
  public async loadFirstPage(): Promise<boolean> {
    if (this.isFetching) {
      return false; // Prevent concurrent duplicate requests
    }

    this.isFetching = true;
    this.abortController = new AbortController();
    this.state = {
      ...this.state,
      initialLoading: true,
      error: null,
    };
    this.emit();

    try {
      const url = new URL(this.endpoint, "http://localhost");
      url.searchParams.set("limit", String(this.limit));

      const res = await this.fetchFn(url.toString(), {
        signal: this.abortController.signal,
      });

      if (!res.ok) {
        const errorBody = await res.json().catch(() => ({}));
        throw new Error(errorBody.error || `Server returned HTTP ${res.status}`);
      }

      const data: ActivityFeedResponse = await res.json();

      this.state = {
        events: [...data.items].sort(compareActivityRecordsDesc),
        nextCursor: data.nextCursor,
        hasMore: data.hasMore,
        initialLoading: false,
        loadingMore: false,
        refreshing: false,
        error: null,
      };
      this.emit();
      return true;
    } catch (err: any) {
      if (err.name === "AbortError") {
        return false;
      }
      this.state = {
        ...this.state,
        initialLoading: false,
        error: err.message || "Failed to load activity feed.",
      };
      this.emit();
      return false;
    } finally {
      this.isFetching = false;
    }
  }

  /**
   * Loads the next page using the active keyset cursor.
   * Prevents duplicate requests if already fetching or if hasMore is false.
   */
  public async loadNextPage(): Promise<boolean> {
    // Overlapping scroll guard: Reject if already fetching, no cursor, or at end of feed
    if (this.isFetching || !this.state.hasMore || !this.state.nextCursor) {
      return false;
    }

    this.isFetching = true;
    this.abortController = new AbortController();
    this.state = {
      ...this.state,
      loadingMore: true,
      error: null,
    };
    this.emit();

    try {
      const url = new URL(this.endpoint, "http://localhost");
      url.searchParams.set("limit", String(this.limit));
      url.searchParams.set("cursor", this.state.nextCursor!);

      const res = await this.fetchFn(url.toString(), {
        signal: this.abortController.signal,
      });

      if (!res.ok) {
        const errorBody = await res.json().catch(() => ({}));
        throw new Error(errorBody.error || `Server returned HTTP ${res.status}`);
      }

      const data: ActivityFeedResponse = await res.json();

      // Deduplicate items against existing state
      const mergedEvents = mergeActivityPages(this.state.events, data.items);

      this.state = {
        events: mergedEvents,
        nextCursor: data.nextCursor,
        hasMore: data.hasMore,
        initialLoading: false,
        loadingMore: false,
        refreshing: false,
        error: null,
      };
      this.emit();
      return true;
    } catch (err: any) {
      if (err.name === "AbortError") {
        return false;
      }
      this.state = {
        ...this.state,
        loadingMore: false,
        error: err.message || "Failed to load next page of activities.",
      };
      this.emit();
      return false;
    } finally {
      this.isFetching = false;
    }
  }

  /**
   * Pull-to-refresh interaction:
   * Aborts any in-flight pagination request, resets cursor, and reloads from head.
   */
  public async refresh(): Promise<boolean> {
    if (this.isFetching && this.abortController) {
      this.abortController.abort();
    }

    this.isFetching = true;
    this.abortController = new AbortController();
    this.state = {
      ...this.state,
      refreshing: true,
      error: null,
    };
    this.emit();

    try {
      const url = new URL(this.endpoint, "http://localhost");
      url.searchParams.set("limit", String(this.limit));

      const res = await this.fetchFn(url.toString(), {
        signal: this.abortController.signal,
      });

      if (!res.ok) {
        const errorBody = await res.json().catch(() => ({}));
        throw new Error(errorBody.error || `Server returned HTTP ${res.status}`);
      }

      const data: ActivityFeedResponse = await res.json();

      this.state = {
        events: [...data.items].sort(compareActivityRecordsDesc),
        nextCursor: data.nextCursor,
        hasMore: data.hasMore,
        initialLoading: false,
        loadingMore: false,
        refreshing: false,
        error: null,
      };
      this.emit();
      return true;
    } catch (err: any) {
      if (err.name === "AbortError") {
        return false;
      }
      this.state = {
        ...this.state,
        refreshing: false,
        error: err.message || "Failed to refresh activity feed.",
      };
      this.emit();
      return false;
    } finally {
      this.isFetching = false;
    }
  }

  /**
   * Retries whichever action failed (initial page or next page).
   */
  public async retry(): Promise<boolean> {
    if (this.state.events.length === 0) {
      return this.loadFirstPage();
    }
    return this.loadNextPage();
  }
}
