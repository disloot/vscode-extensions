# Change Log

## 0.7.0

- Carry numeric entry IDs through candidate retrieval, reuse, and deduplication.
- Replace per-query n-gram membership sets with ordered posting-list lookups.
- Stream local extension-host cache compression and decompression in the v4 cache format.
- Keep the v3 binary cache as a backward-compatible migration source.
- Scan directories through a continuously fed concurrent work queue instead of level barriers.
- Reserve a fair first-pass index share for every root in multi-root workspaces.

## 0.6.0

- Update each bounded search atomically by default, with optional progressive snapshots.
- Add `//query/path` global full-path search without changing shell-like scoped navigation.
- Add picker buttons for instantly showing or hiding files and directories.
- Add per-result pinning and prioritize pinned paths in recent/frequent ranking.

## 0.5.1

- Keep a restored or completed index active until its background replacement is fully built.
- Preserve distinct paths whose spelling differs only by case on case-sensitive workspaces.
- Validate cached results when they are opened and discard entries that no longer exist.

## 0.5.0

- Apply normal file and directory changes incrementally instead of rebuilding the full index.
- Store search postings as compact numeric IDs and create workspace URIs only when a result is opened.
- Compact tombstoned posting lists after large directory deletions.
- Reuse candidates while a query grows and intersect selective n-grams before fuzzy fallback.
- Restore a compressed binary path index on startup and refresh it in the background.
- Add optional shallow indexing with on-demand directory subtree expansion.
- Add optional Git, fd, and ripgrep indexing backends with portable `workspace.fs` fallback.
- Add settings for incremental update thresholds, persistence, indexing depth, and backend selection.

## 0.4.0

- Added configurable search, display, indexing, history, and keyboard behavior.
- Added bounded asynchronous search, recent/frequent ranking, result caching, and stable selection.
