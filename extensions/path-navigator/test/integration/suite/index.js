const assert = require('node:assert/strict');
const vscode = require('vscode');
const { PathIndex } = require('../../../dist/pathIndex');
const { PathIndexPersistence } = require('../../../dist/pathIndexPersistence');
const { searchPaths } = require('../../../dist/pathSearchEngine');

class MemoryRemoteFileSystemProvider {
  constructor() {
    this.changeEmitter = new vscode.EventEmitter();
    this.onDidChangeFile = this.changeEmitter.event;
    this.files = new Set(['/workspace/remote/deep/remote-main.py']);
    this.directories = new Map([
      ['/workspace', [['remote', vscode.FileType.Directory]]],
      ['/workspace/remote', [['deep', vscode.FileType.Directory]]],
      ['/workspace/remote/deep', [['remote-main.py', vscode.FileType.File]]],
    ]);
  }

  stat(uri) {
    if (this.directories.has(uri.path)) {
      return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }
    if (this.files.has(uri.path)) {
      return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: 0 };
    }
    throw vscode.FileSystemError.FileNotFound(uri);
  }

  readDirectory(uri) {
    const entries = this.directories.get(uri.path);
    if (!entries) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return entries;
  }

  readFile(uri) {
    this.stat(uri);
    return new Uint8Array();
  }

  watch() {
    return new vscode.Disposable(() => undefined);
  }

  addFile(path) {
    const separatorIndex = path.lastIndexOf('/');
    const parentPath = path.slice(0, separatorIndex);
    const name = path.slice(separatorIndex + 1);
    const entries = this.directories.get(parentPath);
    if (!entries) {
      throw new Error(`Missing parent directory: ${parentPath}`);
    }
    this.files.add(path);
    if (!entries.some(([entryName]) => entryName === name)) {
      entries.push([name, vscode.FileType.File]);
    }
    this.changeEmitter.fire([{
      type: vscode.FileChangeType.Created,
      uri: vscode.Uri.parse(`pathnav-remote:${path}`),
    }]);
  }

  removeFile(path) {
    const separatorIndex = path.lastIndexOf('/');
    const parentPath = path.slice(0, separatorIndex);
    const name = path.slice(separatorIndex + 1);
    const entries = this.directories.get(parentPath);
    this.files.delete(path);
    if (entries) {
      const entryIndex = entries.findIndex(([entryName]) => entryName === name);
      if (entryIndex >= 0) {
        entries.splice(entryIndex, 1);
      }
    }
    this.changeEmitter.fire([{
      type: vscode.FileChangeType.Deleted,
      uri: vscode.Uri.parse(`pathnav-remote:${path}`),
    }]);
  }

  createDirectory() { throw vscode.FileSystemError.NoPermissions(); }
  writeFile() { throw vscode.FileSystemError.NoPermissions(); }
  delete() { throw vscode.FileSystemError.NoPermissions(); }
  rename() { throw vscode.FileSystemError.NoPermissions(); }
}

function waitForIndexedState(index, predicate, action) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      disposable.dispose();
      reject(new Error('Timed out waiting for a Remote incremental index update.'));
    }, 5_000);
    const disposable = index.onDidChange(() => {
      if (!predicate()) {
        return;
      }
      clearTimeout(timeout);
      disposable.dispose();
      resolve();
    });
    action();
  });
}

async function search(index, query, globalPathQuery = false, workspaceUri) {
  const snapshots = [];
  await searchPaths({
    catalog: index.currentSearchCatalog,
    scopePath: '',
    query,
    workspaceUri,
    globalPathQuery,
    maxResults: 20,
    maxCandidates: 10_000,
    timeBudgetMs: 1_000,
    recentPaths: [],
    allowUnindexedRecentPaths: false,
    isCancelled: () => false,
    onProgress: (progress) => snapshots.push(progress),
  });
  return snapshots.at(-1).entries;
}

function addRemoteWorkspace() {
  const remoteRoot = vscode.Uri.parse('pathnav-remote:/workspace');
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      disposable.dispose();
      reject(new Error('Timed out while adding the provider-backed remote workspace.'));
    }, 5_000);
    const disposable = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      clearTimeout(timeout);
      disposable.dispose();
      resolve();
    });
    const accepted = vscode.workspace.updateWorkspaceFolders(
      vscode.workspace.workspaceFolders?.length ?? 0,
      0,
      { uri: remoteRoot, name: 'remote-fixture' },
    );
    if (!accepted) {
      clearTimeout(timeout);
      disposable.dispose();
      reject(new Error('VS Code rejected the provider-backed remote workspace.'));
    }
  });
}

async function verifyLocalWorkspace() {
  const localWorkspace = vscode.workspace.workspaceFolders?.find(
    (folder) => folder.uri.scheme === 'file',
  );
  assert.ok(localWorkspace);
  const index = new PathIndex();
  try {
    await index.rebuild();
    assert.ok(index.currentSearchCatalog.getEntryByPath(
      localWorkspace.uri.toString(),
      'src/local-main.ts',
    ));
    const results = await search(index, 'local-main');
    assert.equal(results[0].relativePath, 'src/local-main.ts');
  } finally {
    index.dispose();
  }
}

async function verifyRemoteWorkspace(provider) {
  const remoteRoot = vscode.Uri.parse('pathnav-remote:/workspace');
  const remoteWorkspace = vscode.workspace.workspaceFolders?.find(
    (folder) => folder.uri.toString() === remoteRoot.toString(),
  );
  assert.ok(remoteWorkspace);
  const index = new PathIndex();
  try {
    await index.rebuild();
    assert.ok(index.currentSearchCatalog.getEntryByPath(
      remoteRoot.toString(),
      'remote/deep/remote-main.py',
    ));
    const results = await search(
      index,
      'remote/deep/remote',
      true,
      remoteRoot.toString(),
    );
    assert.equal(results[0].relativePath, 'remote/deep/remote-main.py');

    const incrementalPath = '/workspace/remote/deep/incremental.ts';
    const relativeIncrementalPath = 'remote/deep/incremental.ts';
    await waitForIndexedState(
      index,
      () => index.currentSearchCatalog.getEntryByPath(
        remoteRoot.toString(),
        relativeIncrementalPath,
      ) !== undefined,
      () => provider.addFile(incrementalPath),
    );
    assert.equal(
      (await search(index, 'incremental', false, remoteRoot.toString()))[0].relativePath,
      relativeIncrementalPath,
    );
    await waitForIndexedState(
      index,
      () => index.currentSearchCatalog.getEntryByPath(
        remoteRoot.toString(),
        relativeIncrementalPath,
      ) === undefined,
      () => provider.removeFile(incrementalPath),
    );
  } finally {
    index.dispose();
  }
}

async function verifyStreamedCacheRestore() {
  const localWorkspace = vscode.workspace.workspaceFolders?.find(
    (folder) => folder.uri.scheme === 'file',
  );
  assert.ok(localWorkspace);
  const storageUri = vscode.Uri.joinPath(localWorkspace.uri, '.pathnav-test-cache');
  const persistence = new PathIndexPersistence(storageUri);
  const entryCount = 12_001;
  await persistence.save({
    createdAt: Date.now(),
    fingerprint: 'integration-stream-v4',
    limited: false,
    partial: false,
    workspaces: [{ uri: localWorkspace.uri.toString(), name: localWorkspace.name }],
    entries: Array.from({ length: entryCount }, (_, index) => ({
      workspaceIndex: 0,
      kind: index % 7 === 0 ? 'directory' : 'file',
      relativePath: `generated/path-${index}.ts`,
    })),
  }, localWorkspace.uri.toString());
  await persistence.save({
    createdAt: Date.now(),
    fingerprint: 'integration-stream-v4',
    limited: false,
    partial: false,
    workspaces: [{ uri: 'pathnav-remote:/workspace', name: 'remote-fixture' }],
    entries: [{ workspaceIndex: 0, kind: 'file', relativePath: 'remote-only.ts' }],
  }, 'pathnav-remote:/workspace');

  const batchSizes = [];
  let restoredCount = 0;
  const header = await persistence.loadBatches(
    'integration-stream-v4',
    1,
    (_header, entries) => {
      batchSizes.push(entries.length);
      restoredCount += entries.length;
    },
    localWorkspace.uri.toString(),
  );
  assert.ok(header);
  assert.deepEqual(batchSizes, [5_000, 5_000, 2_001]);
  assert.equal(restoredCount, entryCount);
}

async function run() {
  const provider = new MemoryRemoteFileSystemProvider();
  const registration = vscode.workspace.registerFileSystemProvider(
    'pathnav-remote',
    provider,
    { isCaseSensitive: true, isReadonly: true },
  );
  try {
    await addRemoteWorkspace();
    await verifyLocalWorkspace();
    await verifyRemoteWorkspace(provider);
    await verifyStreamedCacheRestore();
    console.log('Path Navigator local and remote workspace.fs integration tests passed.');
  } finally {
    registration.dispose();
  }
}

module.exports = { run };
