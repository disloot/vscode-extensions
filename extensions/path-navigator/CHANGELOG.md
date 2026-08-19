# Change Log

## 2.0.0

- Store retained paths in compact string, kind, and workspace columns instead of one JavaScript
  object per indexed file or directory.
- Share workspace metadata once per catalog and materialize `PathEntry` objects only for visible
  Top-K results, persistence batches, and direct lookups.
- Score, filter, and scope numeric candidates directly from columns during bounded searches.
- Rebuild tombstoned workspace partitions in 5,000-entry batches to avoid a full materialized
  snapshot during compaction.
- Report retained heap and typed-array memory separately in the large-index benchmark.

## 1.1.0

- Persist every workspace-root partition in an independent v5 streamed cache file.
- Rewrite only dirty workspace partitions after incremental file-system changes.
- Eliminate the second directory-tree scan previously used to reclaim unused multi-root quotas.
- Scan estimated smaller partitions first and redistribute the remaining global entry budget once.
- Cover provider-backed Remote file creation and deletion in the VS Code Extension Host suite.

## 1.0.0

- Use the native VS Code `workspace.fs` provider as the single indexing backend.
- Remove external Git, fd, ripgrep, backend-selection, and auto-probing code.
- Partition the compact structured index by workspace root and atomically refresh one root at
  a time while completed and unchanged partitions remain searchable.
- Restore the v4 compressed cache in bounded 5,000-entry streaming batches instead of
  materializing the complete cache before publishing results.
- Add compact path-segment prefix postings for selective global full-path queries.
- Remember query-to-result selections and use bounded query-specific ranking affinity.
- Reduce the default visible result limit from 200 to 50.
- Add VS Code Extension Host integration tests for local and provider-backed remote file systems,
  including a multi-batch streamed-cache round trip.

## 0.8.0

- Share workspace metadata through compact entry prototypes instead of repeating it on every path.
- Omit redundant normalized-name fields retained by catalog posting keys.
- Record normalized scan throughput per workspace and backend.
- Make `auto` select the fastest measured compatible backend and use `fd → rg → git` before measurements exist.
- Ramp Remote SSH and Dev Container directory-read concurrency gradually and back off on congestion.
- Add `pathNavigator.adaptiveRemoteConcurrency` to disable dynamic remote tuning when deterministic concurrency is preferred.

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
