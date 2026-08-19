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

To package Path Navigator without letting npm workspace dependency discovery pull
monorepo files into the artifact, run `npm run package:path-navigator`.
