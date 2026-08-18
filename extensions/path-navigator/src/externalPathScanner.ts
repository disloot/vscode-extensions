import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import * as vscode from 'vscode';
import { hasExcludedFileExtension } from './pathFilters';
import { normalizeSearchText } from './search';

export type IndexingBackend = 'workspaceFs' | 'auto' | 'git' | 'fd' | 'rg';

export interface ScannedExternalPath {
  readonly relativePath: string;
  readonly kind: 'file' | 'directory';
}

export interface ExternalScanOptions {
  readonly backend: IndexingBackend;
  readonly workspaceFolder: vscode.WorkspaceFolder;
  readonly excludedNames: ReadonlySet<string>;
  readonly excludedFileExtensions: ReadonlySet<string>;
  readonly initialDepth: number;
  readonly preferredBackends?: readonly Exclude<IndexingBackend, 'workspaceFs' | 'auto'>[];
  readonly shouldContinue: () => boolean;
  readonly onPaths: (paths: readonly ScannedExternalPath[]) => void;
}

export interface ExternalScanResult {
  readonly handled: boolean;
  readonly backend?: Exclude<IndexingBackend, 'workspaceFs' | 'auto'>;
  readonly durationMs?: number;
  readonly pathCount?: number;
  readonly error?: string;
}

interface CommandSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly kind: ScannedExternalPath['kind'];
  readonly deriveDirectories: boolean;
}

const OUTPUT_BATCH_SIZE = 512;

function normalizeOutputPath(value: string): string | undefined {
  const normalized = value
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/$/, '');
  if (!normalized || normalized === '.' || normalized.split('/').includes('..')) {
    return undefined;
  }
  return normalized;
}

function commandSpecs(
  backend: Exclude<IndexingBackend, 'workspaceFs' | 'auto'>,
  excludedNames: ReadonlySet<string>,
): readonly CommandSpec[] {
  if (backend === 'git') {
    return [{
      command: 'git',
      args: ['ls-files', '-co', '--exclude-standard', '-z'],
      kind: 'file',
      deriveDirectories: true,
    }];
  }
  if (backend === 'fd') {
    const excludes = [...excludedNames].flatMap((name) => ['--exclude', name]);
    return [
      {
        command: 'fd',
        args: ['--hidden', '--color', 'never', '--print0', '--type', 'd', ...excludes],
        kind: 'directory',
        deriveDirectories: false,
      },
      {
        command: 'fd',
        args: ['--hidden', '--color', 'never', '--print0', '--type', 'f', ...excludes],
        kind: 'file',
        deriveDirectories: true,
      },
    ];
  }
  const globs = [...excludedNames].flatMap((name) => [
    '--glob',
    `!**/${name}/**`,
  ]);
  return [{
    command: 'rg',
    args: ['--files', '--hidden', '-0', ...globs],
    kind: 'file',
    deriveDirectories: true,
  }];
}

function runNullDelimitedCommand(
  spec: CommandSpec,
  cwd: string,
  onPath: (relativePath: string, spec: CommandSpec) => void,
  shouldContinue: () => boolean,
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(spec.command, [...spec.args], {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let stderr = '';
    let settled = false;
    const finish = (success: boolean, error?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ success, error });
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (!shouldContinue()) {
        child.kill();
        return;
      }
      pending += decoder.write(chunk);
      let separatorIndex = pending.indexOf('\0');
      while (separatorIndex >= 0) {
        onPath(pending.slice(0, separatorIndex), spec);
        pending = pending.slice(separatorIndex + 1);
        separatorIndex = pending.indexOf('\0');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4_096) {
        stderr += chunk.toString('utf8');
      }
    });
    child.on('error', (error) => finish(false, String(error)));
    child.on('close', (code) => {
      pending += decoder.end();
      if (pending) {
        onPath(pending, spec);
      }
      finish(code === 0, code === 0 ? undefined : stderr.trim() || `exit code ${code}`);
    });
  });
}

export async function scanWithExternalBackend(
  options: ExternalScanOptions,
): Promise<ExternalScanResult> {
  if (
    options.backend === 'workspaceFs' ||
    !vscode.workspace.isTrusted ||
    !['file', 'vscode-remote'].includes(options.workspaceFolder.uri.scheme)
  ) {
    return { handled: false };
  }
  const candidates: Array<Exclude<IndexingBackend, 'workspaceFs' | 'auto'>> =
    options.backend === 'auto'
      ? [...(options.preferredBackends ?? ['fd', 'rg', 'git'])]
      : [options.backend];
  let lastError: string | undefined;

  for (const backend of candidates) {
    const startedAt = performance.now();
    let emittedPathCount = 0;
    const pendingBatch: ScannedExternalPath[] = [];
    const seenDirectories = new Set<string>();
    const flush = (): void => {
      if (pendingBatch.length > 0) {
        options.onPaths(pendingBatch.splice(0));
      }
    };
    const emit = (relativePath: string, kind: ScannedExternalPath['kind']): void => {
      const normalizedPath = normalizeOutputPath(relativePath);
      if (!normalizedPath) {
        return;
      }
      const segments = normalizedPath.split('/');
      const directorySegments = kind === 'directory' ? segments : segments.slice(0, -1);
      if (
        directorySegments.some((segment) =>
          options.excludedNames.has(normalizeSearchText(segment)),
        ) ||
        (kind === 'file' &&
          hasExcludedFileExtension(
            normalizeSearchText(segments.at(-1) ?? ''),
            options.excludedFileExtensions,
          ))
      ) {
        return;
      }
      if (options.initialDepth > 0 && segments.length > options.initialDepth) {
        return;
      }
      if (kind === 'directory') {
        if (seenDirectories.has(normalizedPath)) {
          return;
        }
        seenDirectories.add(normalizedPath);
      }
      pendingBatch.push({ relativePath: normalizedPath, kind });
      emittedPathCount += 1;
      if (pendingBatch.length >= OUTPUT_BATCH_SIZE) {
        flush();
      }
    };
    const specs = commandSpecs(backend, options.excludedNames);
    let success = true;
    for (const spec of specs) {
      const result = await runNullDelimitedCommand(
        spec,
        options.workspaceFolder.uri.fsPath,
        (rawPath, activeSpec) => {
          const normalizedPath = normalizeOutputPath(rawPath);
          if (!normalizedPath) {
            return;
          }
          if (activeSpec.deriveDirectories) {
            const segments = normalizedPath.split('/');
            for (let index = 1; index < segments.length; index += 1) {
              emit(segments.slice(0, index).join('/'), 'directory');
            }
          }
          emit(normalizedPath, activeSpec.kind);
        },
        options.shouldContinue,
      );
      if (!options.shouldContinue()) {
        flush();
        return {
          handled: true,
          backend,
          durationMs: performance.now() - startedAt,
          pathCount: emittedPathCount,
        };
      }
      if (!result.success) {
        success = false;
        lastError = result.error;
        break;
      }
    }
    flush();
    if (success) {
      return {
        handled: true,
        backend,
        durationMs: performance.now() - startedAt,
        pathCount: emittedPathCount,
      };
    }
  }
  return { handled: false, error: lastError };
}
