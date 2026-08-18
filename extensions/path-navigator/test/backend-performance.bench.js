/*
 * Backend benchmark matching Path Navigator's scanner semantics.
 *
 * Current workspace:
 *   node --expose-gc test/backend-performance.bench.js
 * Synthetic Git workspace:
 *   node --expose-gc test/backend-performance.bench.js --synthetic 50000
 * Tracked-file synthetic workspace:
 *   node --expose-gc test/backend-performance.bench.js --synthetic 50000 --tracked
 * Directory-heavy synthetic workspace:
 *   node --expose-gc test/backend-performance.bench.js --synthetic 20000 --directory-heavy
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { pathToFileURL } = require('node:url');
const { createPathEntry } = require('../dist/pathEntry');
const { PathSearchCatalog } = require('../dist/pathSearchCatalog');

const EXCLUDED_DIRECTORY_NAMES = new Set([
  '.git',
  'node_modules',
  '.next',
  '.turbo',
  '.venv',
  'venv',
  '.cache',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '__pycache__',
  'coverage',
  'dist',
  'out',
  'build',
  'target',
]);
const INDEX_CONCURRENCY = 12;
const MEASURED_ITERATIONS = 5;

function normalizeRelativePath(value) {
  const normalized = value
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/$/, '');
  return !normalized || normalized === '.' || normalized.split('/').includes('..')
    ? undefined
    : normalized;
}

function pathIsExcluded(relativePath, kind) {
  const segments = relativePath.toLocaleLowerCase().split('/');
  const directorySegments = kind === 'directory' ? segments : segments.slice(0, -1);
  return directorySegments.some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment));
}

function addPath(paths, relativePath, kind) {
  const normalizedPath = normalizeRelativePath(relativePath);
  if (!normalizedPath || pathIsExcluded(normalizedPath, kind)) {
    return;
  }
  if (kind === 'directory') {
    paths.set(normalizedPath, 'directory');
  } else {
    paths.set(normalizedPath, 'file');
  }
}

function addFileAndParents(paths, relativePath) {
  const normalizedPath = normalizeRelativePath(relativePath);
  if (!normalizedPath) {
    return;
  }
  const segments = normalizedPath.split('/');
  for (let index = 1; index < segments.length; index += 1) {
    addPath(paths, segments.slice(0, index).join('/'), 'directory');
  }
  addPath(paths, normalizedPath, 'file');
}

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    let stderr = '';
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4096) {
        stderr += chunk.toString('utf8');
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
      } else {
        reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
      }
    });
  });
}

function nullDelimitedPaths(output) {
  return output
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

async function scanWorkspaceFs(rootPath) {
  const paths = new Map();
  let directories = [{ absolutePath: rootPath, relativePath: '' }];
  while (directories.length > 0) {
    const currentLevel = directories;
    const nextLevel = [];
    let nextDirectoryIndex = 0;
    const worker = async () => {
      while (true) {
        const directory = currentLevel[nextDirectoryIndex];
        nextDirectoryIndex += 1;
        if (!directory) {
          return;
        }
        const children = await fs.readdir(directory.absolutePath, { withFileTypes: true });
        for (const child of children) {
          const relativePath = directory.relativePath
            ? `${directory.relativePath}/${child.name}`
            : child.name;
          if (child.isDirectory()) {
            if (EXCLUDED_DIRECTORY_NAMES.has(child.name.toLocaleLowerCase())) {
              continue;
            }
            addPath(paths, relativePath, 'directory');
            if (!child.isSymbolicLink()) {
              nextLevel.push({
                absolutePath: path.join(directory.absolutePath, child.name),
                relativePath,
              });
            }
          } else {
            addPath(paths, relativePath, 'file');
          }
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(INDEX_CONCURRENCY, currentLevel.length) },
        () => worker(),
      ),
    );
    directories = nextLevel;
  }
  return paths;
}

async function scanGit(rootPath) {
  const output = await runCommand(
    'git',
    ['ls-files', '-co', '--exclude-standard', '-z'],
    rootPath,
  );
  const paths = new Map();
  for (const relativePath of nullDelimitedPaths(output)) {
    addFileAndParents(paths, relativePath);
  }
  return paths;
}

async function scanRipgrep(rootPath) {
  const excludedGlobs = [...EXCLUDED_DIRECTORY_NAMES].flatMap((name) => [
    '--glob',
    `!**/${name}/**`,
  ]);
  const output = await runCommand(
    'rg',
    ['--files', '--hidden', '-0', ...excludedGlobs],
    rootPath,
  );
  const paths = new Map();
  for (const relativePath of nullDelimitedPaths(output)) {
    addFileAndParents(paths, relativePath);
  }
  return paths;
}

async function scanFd(rootPath) {
  const excludes = [...EXCLUDED_DIRECTORY_NAMES].flatMap((name) => ['--exclude', name]);
  const [directoryOutput, fileOutput] = await Promise.all([
    runCommand(
      'fd',
      ['--hidden', '--color', 'never', '--print0', '--type', 'd', ...excludes],
      rootPath,
    ),
    runCommand(
      'fd',
      ['--hidden', '--color', 'never', '--print0', '--type', 'f', ...excludes],
      rootPath,
    ),
  ]);
  const paths = new Map();
  for (const relativePath of nullDelimitedPaths(directoryOutput)) {
    addPath(paths, relativePath, 'directory');
  }
  for (const relativePath of nullDelimitedPaths(fileOutput)) {
    addFileAndParents(paths, relativePath);
  }
  return paths;
}

function buildCatalog(paths, rootPath) {
  const workspaceUri = pathToFileURL(rootPath).toString();
  const entries = [];
  for (const [relativePath, kind] of paths) {
    entries.push(createPathEntry({
      kind,
      name: relativePath.slice(relativePath.lastIndexOf('/') + 1),
      relativePath,
      workspaceName: 'benchmark',
      workspaceUri,
      normalizedWorkspaceName: 'benchmark',
    }));
  }
  const catalog = new PathSearchCatalog();
  catalog.addEntries(entries);
  catalog.seal();
  return catalog;
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function rounded(value) {
  return Number(value.toFixed(2));
}

async function benchmarkBackend(name, scanner, rootPath) {
  try {
    await scanner(rootPath);
  } catch (error) {
    return {
      backend: name,
      status: error?.code === 'ENOENT' ? 'unavailable' : `failed: ${error.message}`,
    };
  }

  const samples = [];
  let lastPaths;
  for (let iteration = 0; iteration < MEASURED_ITERATIONS; iteration += 1) {
    global.gc?.();
    const scanStartedAt = performance.now();
    const paths = await scanner(rootPath);
    const scanMs = performance.now() - scanStartedAt;
    const catalogStartedAt = performance.now();
    const catalog = buildCatalog(paths, rootPath);
    const catalogMs = performance.now() - catalogStartedAt;
    samples.push({ scanMs, catalogMs, totalMs: scanMs + catalogMs });
    lastPaths = paths;
    if (catalog.size !== paths.size) {
      throw new Error(`catalog size mismatch: ${catalog.size} !== ${paths.size}`);
    }
  }

  const files = [...lastPaths.values()].filter((kind) => kind === 'file').length;
  const directories = lastPaths.size - files;
  const scanSamples = samples.map(({ scanMs }) => scanMs);
  const catalogSamples = samples.map(({ catalogMs }) => catalogMs);
  const totalSamples = samples.map(({ totalMs }) => totalMs);
  const medianTotalMs = percentile(totalSamples, 0.5);
  return {
    backend: name,
    status: 'ok',
    paths: lastPaths.size,
    files,
    directories,
    scanMedianMs: rounded(percentile(scanSamples, 0.5)),
    catalogMedianMs: rounded(percentile(catalogSamples, 0.5)),
    totalMedianMs: rounded(medianTotalMs),
    totalP95Ms: rounded(percentile(totalSamples, 0.95)),
    pathsPerSecond: Math.round(lastPaths.size / (medianTotalMs / 1000)),
  };
}

async function writeFiles(paths) {
  const batchSize = 256;
  for (let offset = 0; offset < paths.length; offset += batchSize) {
    await Promise.all(
      paths.slice(offset, offset + batchSize).map((filePath) => fs.writeFile(filePath, '')),
    );
  }
}

async function makeDirectories(rootPath, directories) {
  const directoryPaths = [...directories].map((directory) => path.join(rootPath, directory));
  const batchSize = 128;
  for (let offset = 0; offset < directoryPaths.length; offset += batchSize) {
    await Promise.all(
      directoryPaths
        .slice(offset, offset + batchSize)
        .map((directoryPath) => fs.mkdir(directoryPath, { recursive: true })),
    );
  }
}

async function createSyntheticWorkspace(fileCount, tracked, directoryHeavy) {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'path-navigator-backends-'));
  await runCommand('git', ['init', '-q'], rootPath);
  await fs.writeFile(path.join(rootPath, '.gitignore'), 'node_modules/\n');
  await fs.writeFile(path.join(rootPath, 'README.md'), '# Backend benchmark\n');

  const directories = new Set();
  const files = [];
  for (let index = 0; index < fileCount; index += 1) {
    const relativeDirectory = directoryHeavy
      ? `modules/module-${index}/src`
      : `packages/package-${index % 200}/src/group-${Math.floor(index / 200) % 25}`;
    directories.add(relativeDirectory);
    files.push(path.join(rootPath, relativeDirectory, `component-${index}.ts`));
  }
  for (let index = 0; index < 200; index += 1) {
    directories.add(`empty/empty-${index}`);
  }
  await makeDirectories(rootPath, directories);
  await writeFiles(files);

  const ignoredDirectory = path.join(rootPath, 'node_modules', 'ignored-package');
  await fs.mkdir(ignoredDirectory, { recursive: true });
  await writeFiles(
    Array.from(
      { length: Math.max(100, Math.floor(fileCount / 10)) },
      (_, index) => path.join(ignoredDirectory, `ignored-${index}.js`),
    ),
  );
  if (tracked) {
    await runCommand('git', ['add', '-A'], rootPath);
  }
  return rootPath;
}

function parseArguments() {
  const syntheticIndex = process.argv.indexOf('--synthetic');
  if (syntheticIndex >= 0) {
    const fileCount = Number(process.argv[syntheticIndex + 1] ?? 50_000);
    if (!Number.isInteger(fileCount) || fileCount <= 0) {
      throw new Error('--synthetic requires a positive integer file count.');
    }
    return {
      synthetic: true,
      fileCount,
      tracked: process.argv.includes('--tracked'),
      directoryHeavy: process.argv.includes('--directory-heavy'),
    };
  }
  const candidatePath = process.argv[2];
  return {
    synthetic: false,
    rootPath: candidatePath ? path.resolve(candidatePath) : path.resolve(__dirname, '../../..'),
  };
}

async function main() {
  const options = parseArguments();
  const rootPath = options.synthetic
    ? await createSyntheticWorkspace(
        options.fileCount,
        options.tracked,
        options.directoryHeavy,
      )
    : options.rootPath;
  const startedAt = performance.now();
  try {
    const backends = [
      ['workspaceFs', scanWorkspaceFs],
      ['git', scanGit],
      ['fd', scanFd],
      ['rg', scanRipgrep],
    ];
    const results = [];
    for (const [name, scanner] of backends) {
      results.push(await benchmarkBackend(name, scanner, rootPath));
    }
    console.log(JSON.stringify({
      workspace: options.synthetic
        ? [
            'synthetic',
            options.fileCount,
            options.tracked ? 'tracked' : 'untracked',
            options.directoryHeavy ? 'directory-heavy' : 'file-heavy',
          ].join(':')
        : rootPath,
      iterations: MEASURED_ITERATIONS,
      indexConcurrency: INDEX_CONCURRENCY,
      elapsedMs: rounded(performance.now() - startedAt),
      results,
    }, null, 2));
  } finally {
    if (options.synthetic) {
      await fs.rm(rootPath, { recursive: true, force: true });
    }
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
