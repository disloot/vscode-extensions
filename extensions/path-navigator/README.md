# Path Navigator

Path Navigator is a VS Code extension for finding files and directories by their
workspace-relative paths.

## Features

- Search all descendant files and directories using partial or fuzzy names.
- Press Tab to complete a directory and continue searching inside it.
- Open files as pinned editor tabs by default.
- Reveal and select directories in the built-in Explorer.
- Index empty directories as well as files.
- Keep the index updated when files or directories are created or deleted.
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
6. Press Enter on a file to open it, or on a directory to reveal it in Explorer.

Global search and directory navigation work together. Given
`abc/bcd/cde/file.ts`, typing `fi` or `ile` at the workspace root finds the file
immediately. After completing `abc/` with Tab, the same search only returns
matches located somewhere inside `abc/`.

For example, the path `abc/bcd/cde` can be reached as follows:

```text
ab  → Tab → abc/
bc  → Tab → abc/bcd/
cd  → Tab → abc/bcd/cde
```

The refresh button in the picker rebuilds the path index. You can also run
**Path Navigator: Refresh Path Index**.

## Remote workspaces

Path Navigator runs as a workspace extension, so Remote SSH, Dev Containers,
WSL, and Codespaces execute its indexer alongside the workspace. Remote indexes
are built concurrently and publish partial results while the remaining folders
are still being scanned.

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
npm test
```

Press F5 in VS Code to launch an Extension Development Host.

## Known limitation

Directory navigation uses VS Code's built-in `revealInExplorer` command. The
command is used by bundled VS Code extensions but is not part of the documented
public command API, so compatibility is tested on a best-effort basis.
