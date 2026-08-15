# VS Code Extensions

This repository contains a collection of independently packaged VS Code
extensions.

## Extensions

- [Path Navigator](./extensions/path-navigator/README.md) — search workspace
  paths, open files, and reveal directories in Explorer.

Each extension has its own manifest, version, tests, README, and publishing
configuration. To work on an extension, open its directory or launch the
repository's Extension Development Host configuration.

## Repository commands

```sh
npm install
npm run check
npm test
```

To package an extension, run `npx @vscode/vsce package` from that extension's
directory.
