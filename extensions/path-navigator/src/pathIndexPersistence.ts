import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { createGunzip, createGzip, gunzip, gzip } from 'node:zlib';
import * as vscode from 'vscode';
import {
  decodePathIndexCache,
  encodePathIndexCache,
  type CachedPath,
  type PathIndexCacheData,
} from './pathIndexCacheCodec';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const STREAM_CACHE_MAGIC = 'PNIDX005';

class CacheLoadCancelled extends Error {}

export interface PathIndexCacheSaveData extends Omit<PathIndexCacheData, 'entries'> {
  readonly entries: Iterable<CachedPath>;
}

export type PathIndexCacheHeader = Omit<PathIndexCacheData, 'entries'>;
export type PathIndexCacheBatchConsumer = (
  header: PathIndexCacheHeader,
  entries: readonly CachedPath[],
) => boolean | void | Promise<boolean | void>;

interface StreamCacheHeader extends Omit<PathIndexCacheData, 'entries'> {
  readonly magic: typeof STREAM_CACHE_MAGIC;
}

function cacheFileSuffix(cacheKey: string): string {
  return createHash('sha256').update(cacheKey).digest('hex').slice(0, 24);
}

function streamCacheFileName(cacheKey: string): string {
  return `path-index-v5-${cacheFileSuffix(cacheKey)}.jsonl.gz`;
}

function binaryCacheFileName(cacheKey: string): string {
  return `path-index-v5-${cacheFileSuffix(cacheKey)}.bin.gz`;
}

function isStreamCacheHeader(value: unknown): value is StreamCacheHeader {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<StreamCacheHeader>;
  return (
    candidate.magic === STREAM_CACHE_MAGIC &&
    typeof candidate.createdAt === 'number' &&
    typeof candidate.fingerprint === 'string' &&
    typeof candidate.limited === 'boolean' &&
    typeof candidate.partial === 'boolean' &&
    Array.isArray(candidate.workspaces)
  );
}

export class PathIndexPersistence {
  constructor(private readonly storageUri: vscode.Uri | undefined) {}

  async loadBatches(
    fingerprint: string,
    maxAgeHours: number,
    onBatch: PathIndexCacheBatchConsumer,
    cacheKey = 'default',
  ): Promise<PathIndexCacheHeader | undefined> {
    if (!this.storageUri) {
      return undefined;
    }
    if (this.storageUri.scheme === 'file') {
      try {
        const streamed = await this.loadStreamCacheBatches(
          fingerprint,
          maxAgeHours,
          onBatch,
          cacheKey,
        );
        if (streamed) {
          return streamed;
        }
      } catch (error) {
        if (error instanceof CacheLoadCancelled) {
          return undefined;
        }
        // Fall through to the workspace.fs binary format after a partial write.
      }
    }
    try {
      const compressed = await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(this.storageUri, binaryCacheFileName(cacheKey)),
      );
      const decoded = decodePathIndexCache(await gunzipAsync(compressed));
      const maxAgeMs = Math.max(0, maxAgeHours) * 3_600_000;
      if (
        decoded.fingerprint !== fingerprint ||
        (maxAgeMs > 0 && Date.now() - decoded.createdAt > maxAgeMs)
      ) {
        return undefined;
      }
      const header: PathIndexCacheHeader = {
        createdAt: decoded.createdAt,
        fingerprint: decoded.fingerprint,
        limited: decoded.limited,
        partial: decoded.partial,
        workspaces: decoded.workspaces,
      };
      for (let offset = 0; offset < decoded.entries.length; offset += 5_000) {
        if (await onBatch(header, decoded.entries.slice(offset, offset + 5_000)) === false) {
          return undefined;
        }
      }
      return header;
    } catch {
      return undefined;
    }
  }

  async save(data: PathIndexCacheSaveData, cacheKey = 'default'): Promise<void> {
    if (!this.storageUri) {
      return;
    }
    await vscode.workspace.fs.createDirectory(this.storageUri);
    if (this.storageUri.scheme === 'file') {
      await this.saveStreamCache(data, cacheKey);
      return;
    }
    const materialized: PathIndexCacheData = { ...data, entries: [...data.entries] };
    const compressed = await gzipAsync(encodePathIndexCache(materialized), { level: 6 });
    const fileName = binaryCacheFileName(cacheKey);
    const cacheUri = vscode.Uri.joinPath(this.storageUri, fileName);
    const temporaryUri = vscode.Uri.joinPath(
      this.storageUri,
      `${fileName}.tmp`,
    );
    await vscode.workspace.fs.writeFile(temporaryUri, compressed);
    await vscode.workspace.fs.rename(temporaryUri, cacheUri, { overwrite: true });
  }

  private async loadStreamCacheBatches(
    fingerprint: string,
    maxAgeHours: number,
    onBatch: PathIndexCacheBatchConsumer,
    cacheKey: string,
  ): Promise<PathIndexCacheHeader | undefined> {
    if (!this.storageUri) {
      return undefined;
    }
    const cacheUri = vscode.Uri.joinPath(this.storageUri, streamCacheFileName(cacheKey));
    const lines = createInterface({
      input: createReadStream(cacheUri.fsPath).pipe(createGunzip()),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    let header: StreamCacheHeader | undefined;
    let entries: CachedPath[] = [];
    for await (const line of lines) {
      if (!header) {
        const parsed: unknown = JSON.parse(line);
        if (!isStreamCacheHeader(parsed)) {
          throw new Error('Unsupported streamed index cache format.');
        }
        const maxAgeMs = Math.max(0, maxAgeHours) * 3_600_000;
        if (
          parsed.fingerprint !== fingerprint ||
          (maxAgeMs > 0 && Date.now() - parsed.createdAt > maxAgeMs)
        ) {
          lines.close();
          return undefined;
        }
        header = parsed;
        continue;
      }
      const parsed: unknown = JSON.parse(line);
      if (
        !Array.isArray(parsed) ||
        typeof parsed[0] !== 'number' ||
        (parsed[1] !== 0 && parsed[1] !== 1) ||
        typeof parsed[2] !== 'string' ||
        parsed[0] < 0 ||
        parsed[0] >= header.workspaces.length
      ) {
        throw new Error('Invalid streamed index cache entry.');
      }
      entries.push({
        workspaceIndex: parsed[0],
        kind: parsed[1] === 1 ? 'directory' : 'file',
        relativePath: parsed[2],
      });
      if (entries.length >= 5_000) {
        if (await onBatch(header, entries) === false) {
          lines.close();
          throw new CacheLoadCancelled();
        }
        entries = [];
      }
    }
    if (header && entries.length > 0 && await onBatch(header, entries) === false) {
      throw new CacheLoadCancelled();
    }
    return header;
  }

  private async saveStreamCache(data: PathIndexCacheSaveData, cacheKey: string): Promise<void> {
    if (!this.storageUri) {
      return;
    }
    const fileName = streamCacheFileName(cacheKey);
    const cacheUri = vscode.Uri.joinPath(this.storageUri, fileName);
    const temporaryUri = vscode.Uri.joinPath(
      this.storageUri,
      `${fileName}.tmp`,
    );
    const header: StreamCacheHeader = {
      magic: STREAM_CACHE_MAGIC,
      createdAt: data.createdAt,
      fingerprint: data.fingerprint,
      limited: data.limited,
      partial: data.partial,
      workspaces: data.workspaces,
    };
    const source = Readable.from((async function* (): AsyncIterable<string> {
      yield `${JSON.stringify(header)}\n`;
      let entryCount = 0;
      for (const entry of data.entries) {
        yield `${JSON.stringify([
          entry.workspaceIndex,
          entry.kind === 'directory' ? 1 : 0,
          entry.relativePath,
        ])}\n`;
        entryCount += 1;
        if (entryCount % 5_000 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
    })());
    await pipeline(
      source,
      createGzip({ level: 6 }),
      createWriteStream(temporaryUri.fsPath),
    );
    await vscode.workspace.fs.rename(temporaryUri, cacheUri, { overwrite: true });
  }
}
