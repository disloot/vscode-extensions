# Path Navigator

Path Navigator is a VS Code extension for finding files and directories by their
workspace-relative paths.

## Features

- Search all descendant files and directories using partial or fuzzy names.
- Press Tab to complete a directory and continue searching inside it.
- Open files as pinned editor tabs by default.
- Reveal and select directories in the built-in Explorer.
- Index empty directories as well as files.
- Apply file and directory creates/deletes incrementally, including directory subtrees.
- Fall back to a full rebuild only when a configurable file-event storm is too large.
- Preserve keyboard selection while background indexing adds or reorders results.
- Keep large-workspace searches responsive by retaining only the highest-ranked results.
- Pause candidate-list replacement as soon as you navigate results with the keyboard or mouse.
- Search asynchronously in cancellable 8 ms slices with a configurable time and candidate budget.
- Avoid rewriting an unchanged result list while the workspace index grows in the background.
- Cache recent completed queries so returning to one is immediate while the index is unchanged.
- Reuse matching candidates while a query grows, such as `mai` → `main` → `main.py`.
- Intersect multiple compact name n-gram posting lists before broad fuzzy fallback.
- Prioritize recently and frequently opened workspace files using workspace-local history.
- Restore a compressed binary index on startup and reconcile it in the background.
- Optionally build a shallow initial index and load a directory subtree when it is entered.
- Optionally accelerate full scans with Git, fd, or ripgrep on the workspace host.
- Support multi-root, remote, and virtual workspaces through `workspace.fs`.

## Usage

1. Run **Path Navigator: Open File or Reveal Directory** from the Command Palette.
2. Alternatively press `Cmd+Alt+P` on macOS or `Ctrl+Alt+P` on Windows/Linux.
3. With an empty input, the picker shows the direct children of the current
   directory. Type part of a name to search all descendants in the current scope.
   Both `ab` and `bc` can match a directory named `abc`.
4. Press Tab to complete the active result. Completing `abc` changes the input to
   `abc/` and shows only its immediate files and subdirectories.
5. Continue typing and pressing Tab to navigate the path one level at a time.
6. Press Enter on a file to open it. By default, Enter on a directory reveals it
   in Explorer; set `pathNavigator.directoryAction` to `enter` to navigate into it.

Global search and directory navigation work together. Given
`abc/bcd/cde/file.ts`, typing `fi` or `ile` at the workspace root finds the file
immediately. After completing `abc/` with Tab, the same search only returns
matches located somewhere inside `abc/`.

Large workspaces use compact numeric posting lists and staged candidate retrieval. A one-character query searches
recent paths and file-name prefixes. A two-character query searches prefixes and
continuous name substrings. Queries of three or more characters first intersect several
selective name n-grams, then use the rarest available n-gram followed by a bounded fuzzy
fallback. Exact, prefix, recent, and
frequently opened results are evaluated before the fallback budget is consumed.

When a query extends the previous query, its matching candidates are evaluated first.
If the previous three-or-more-character search was exhaustive, the extension is searched
entirely inside that previous match set. This avoids rescanning unrelated paths during
normal continuous typing.

When you press Up or Down, Path Navigator freezes the visible result snapshot
before VS Code moves the selection. Background indexing and searching can finish,
but their incremental results are deferred and never replace that snapshot. Mouse
selection provides the same freeze as a fallback. Editing the query, entering a
directory, pressing refresh, or reopening the picker starts a fresh result stream.

The status line distinguishes indexing, searching, paused results, search-budget
limits, and index-size limits. While results are still allowed to update, the picker
also preserves its scroll position and skips updates whose visible ordering has not
changed.

For example, the path `abc/bcd/cde` can be reached as follows:

```text
ab  → Tab → abc/
bc  → Tab → abc/bcd/
cd  → Tab → abc/bcd/cde
```

The refresh button in the picker rebuilds the path index. You can also run
**Path Navigator: Refresh Path Index**.

The gear button opens the extension settings. Run **Path Navigator: Configure
Keyboard Shortcuts** to open VS Code's native Keyboard Shortcuts editor filtered
to Path Navigator commands.

## Keyboard shortcuts

All shortcuts are regular VS Code keybindings and can be changed or removed in
the Keyboard Shortcuts editor.

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| Open Path Navigator | `Cmd+Alt+P` | `Ctrl+Alt+P` |
| Next / previous result | `Down` / `Up` | `Down` / `Up` |
| Enter selected directory | `Tab` | `Tab` |
| Go to parent directory | `Shift+Tab` | `Shift+Tab` |
| Refresh active picker | `Cmd+R` | `Ctrl+R` |

## Search and interaction settings

- `pathNavigator.showFiles`: include files in results (default `true`).
- `pathNavigator.showDirectories`: include directories in results (default `true`).
- `pathNavigator.fuzzyMatching`: allow non-contiguous fuzzy matches (default `true`).
- `pathNavigator.directoryAction`: make Enter `reveal` a directory or `enter` it
  (default `reveal`; Tab always enters).
- `pathNavigator.resultPathDisplay`: show the `parent`, `full`, or `hidden` path
  beside each result (default `parent`).
- `pathNavigator.freezeResultsOnNavigation`: freeze the visible result snapshot
  while navigating (default `true`).
- `pathNavigator.keepOpenOnFocusLost`: keep the picker open after focus changes
  (default `false`).
- `pathNavigator.showStatusPrompt`: show search/index status above results
  (default `true`).
- `pathNavigator.openFilesInPreview`: open files as preview tabs (default `false`).

## Performance settings

- `pathNavigator.maxResults`: maximum visible results (default `200`).
- `pathNavigator.maxIndexEntries`: maximum retained index size (default `500000`,
  or `0` for unlimited). The picker reports when the limit is reached.
- `pathNavigator.indexConcurrency`: concurrent directory reads during indexing
  (default `12`; lower values may suit constrained remote workspaces).
- `pathNavigator.autoRefreshIndex`: apply incremental file/directory updates
  (default `true`).
- `pathNavigator.incrementalUpdateBatchLimit`: maximum coalesced file events handled
  incrementally before falling back to a full rebuild (default `2000`).
- `pathNavigator.indexingBackend`: use portable `workspaceFs` (default), or opt into
  `auto`, `git`, `fd`, or `rg` for faster command-line-backed full scans.
- `pathNavigator.initialIndexDepth`: initial `workspace.fs` scan depth (`0` means a
  complete index). Positive values load entered directory subtrees on demand.
- `pathNavigator.persistIndex`: restore a compressed binary index when reopening a
  workspace (default `true`).
- `pathNavigator.persistentIndexMaxAgeHours`: maximum cache age (default `168`; `0`
  accepts any age).
- `pathNavigator.refreshPersistentIndexInBackground`: reconcile a restored cache with
  the live workspace in the background (default `true`).
- `pathNavigator.maxSearchCandidates`: maximum expanded fuzzy candidates
  scored per query (default `10000`).
- `pathNavigator.searchTimeBudgetMs`: soft fuzzy-search budget in milliseconds
  (default `150`).
- `pathNavigator.recentPathsLimit`: workspace-local recent/frequent history
  limit (default `200`, or `0` to disable).

The history and persistent index store path metadata only—never file contents. Recent
history additionally stores timestamps and open counts. It observes workspace files
opened through the normal editor, not only files opened through Path Navigator.

Common generated directories such as `.venv`, `venv`, `__pycache__`, `.cache`,
`.pytest_cache`, and `target` are excluded by default. Customize
`pathNavigator.excludeDirectoryNames` when a workspace has other large dependency
or generated trees. Use `pathNavigator.excludeFileExtensions` for suffixes such as
`.log`, `.map`, or `.test.ts`.

## Remote workspaces

Path Navigator runs as a workspace extension, so Remote SSH, Dev Containers,
WSL, and Codespaces execute its indexer alongside the workspace. Remote indexes
are built concurrently and publish partial results while the remaining folders
are still being scanned. Optional Git/fd/rg commands also run in that remote extension
host. External command backends are disabled in untrusted workspaces and automatically
fall back to `workspace.fs`.

`workspaceFs` is the compatibility default and includes empty directories. Git and
ripgrep derive directories from file paths, so they omit empty directories; Git also
follows Git ignore rules. Choose `fd` when it is installed and empty-directory discovery
is important.

To test a local VSIX, first connect to the remote environment, then run
**Extensions: Install from VSIX...** in that remote window and reload it. Use
**Developer: Show Running Extensions** to confirm that Path Navigator is running
in the remote extension host.

## Replace Cmd+P

VS Code does not provide an API for adding directories to its built-in `Cmd+P`
results. To use Path Navigator in its place, add the following to your user
`keybindings.json`:

```jsonc
{
  "key": "cmd+p",
  "command": "pathNavigator.open"
}
```

Use `ctrl+p` on Windows or Linux. You may also bind the original Quick Open
command, `workbench.action.quickOpen`, to another shortcut.

## Development

From the repository root, run:

```sh
npm install
npm run check --workspace extensions/path-navigator
npm test --workspace extensions/path-navigator
npm run benchmark --workspace extensions/path-navigator
npm run benchmark:backends --workspace extensions/path-navigator -- --synthetic 50000
npm test
```

Press F5 in VS Code to launch an Extension Development Host.

## Known limitation

Directory navigation uses VS Code's built-in `revealInExplorer` command. The
command is used by bundled VS Code extensions but is not part of the documented
public command API, so compatibility is tested on a best-effort basis.
