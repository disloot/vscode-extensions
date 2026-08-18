import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import * as vscode from 'vscode';
import {
  decodePathIndexCache,
  encodePathIndexCache,
  type PathIndexCacheData,
} from './pathIndexCacheCodec';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const CACHE_FILE_NAME = 'path-index-v3.bin.gz';

export class PathIndexPersistence {
  constructor(private readonly storageUri: vscode.Uri | undefined) {}

  async load(fingerprint: string, maxAgeHours: number): Promise<PathIndexCacheData | undefined> {
    if (!this.storageUri) {
      return undefined;
    }
    try {
      const compressed = await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(this.storageUri, CACHE_FILE_NAME),
      );
      const decoded = decodePathIndexCache(await gunzipAsync(compressed));
      const maxAgeMs = Math.max(0, maxAgeHours) * 3_600_000;
      if (
        decoded.fingerprint !== fingerprint ||
        (maxAgeMs > 0 && Date.now() - decoded.createdAt > maxAgeMs)
      ) {
        return undefined;
      }
      return decoded;
    } catch {
      return undefined;
    }
  }

  async save(data: PathIndexCacheData): Promise<void> {
    if (!this.storageUri) {
      return;
    }
    await vscode.workspace.fs.createDirectory(this.storageUri);
    const compressed = await gzipAsync(encodePathIndexCache(data), { level: 6 });
    const cacheUri = vscode.Uri.joinPath(this.storageUri, CACHE_FILE_NAME);
    const temporaryUri = vscode.Uri.joinPath(this.storageUri, `${CACHE_FILE_NAME}.tmp`);
    await vscode.workspace.fs.writeFile(temporaryUri, compressed);
    await vscode.workspace.fs.rename(temporaryUri, cacheUri, { overwrite: true });
  }
}
