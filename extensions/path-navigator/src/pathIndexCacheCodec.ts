const CACHE_MAGIC = 'PNIDX003';

export interface CachedWorkspace {
  readonly uri: string;
  readonly name: string;
}

export interface CachedPath {
  readonly workspaceIndex: number;
  readonly kind: 'file' | 'directory';
  readonly relativePath: string;
}

export interface PathIndexCacheData {
  readonly createdAt: number;
  readonly fingerprint: string;
  readonly limited: boolean;
  readonly partial: boolean;
  readonly workspaces: readonly CachedWorkspace[];
  readonly entries: readonly CachedPath[];
}

function stringStorageSize(value: string): number {
  return 4 + Buffer.byteLength(value, 'utf8');
}

function writeString(buffer: Buffer, value: string, offset: number): number {
  const byteLength = Buffer.byteLength(value, 'utf8');
  buffer.writeUInt32LE(byteLength, offset);
  buffer.write(value, offset + 4, byteLength, 'utf8');
  return offset + 4 + byteLength;
}

function readString(buffer: Buffer, offset: number): { value: string; nextOffset: number } {
  if (offset + 4 > buffer.length) {
    throw new Error('Unexpected end of index cache.');
  }
  const byteLength = buffer.readUInt32LE(offset);
  const nextOffset = offset + 4 + byteLength;
  if (nextOffset > buffer.length) {
    throw new Error('Invalid string length in index cache.');
  }
  return {
    value: buffer.toString('utf8', offset + 4, nextOffset),
    nextOffset,
  };
}

export function encodePathIndexCache(data: PathIndexCacheData): Buffer {
  let size = 8 + 8 + stringStorageSize(data.fingerprint) + 1 + 1 + 4 + 4;
  for (const workspace of data.workspaces) {
    size += stringStorageSize(workspace.uri) + stringStorageSize(workspace.name);
  }
  for (const entry of data.entries) {
    size += 4 + 1 + stringStorageSize(entry.relativePath);
  }

  const buffer = Buffer.allocUnsafe(size);
  buffer.write(CACHE_MAGIC, 0, 8, 'ascii');
  let offset = 8;
  buffer.writeDoubleLE(data.createdAt, offset);
  offset += 8;
  offset = writeString(buffer, data.fingerprint, offset);
  buffer.writeUInt8(data.limited ? 1 : 0, offset);
  offset += 1;
  buffer.writeUInt8(data.partial ? 1 : 0, offset);
  offset += 1;
  buffer.writeUInt32LE(data.workspaces.length, offset);
  offset += 4;
  for (const workspace of data.workspaces) {
    offset = writeString(buffer, workspace.uri, offset);
    offset = writeString(buffer, workspace.name, offset);
  }
  buffer.writeUInt32LE(data.entries.length, offset);
  offset += 4;
  for (const entry of data.entries) {
    buffer.writeUInt32LE(entry.workspaceIndex, offset);
    offset += 4;
    buffer.writeUInt8(entry.kind === 'directory' ? 1 : 0, offset);
    offset += 1;
    offset = writeString(buffer, entry.relativePath, offset);
  }
  return buffer;
}

export function decodePathIndexCache(data: Uint8Array): PathIndexCacheData {
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buffer.length < 26 || buffer.toString('ascii', 0, 8) !== CACHE_MAGIC) {
    throw new Error('Unsupported Path Navigator index cache format.');
  }
  let offset = 8;
  const createdAt = buffer.readDoubleLE(offset);
  offset += 8;
  const fingerprintResult = readString(buffer, offset);
  const fingerprint = fingerprintResult.value;
  offset = fingerprintResult.nextOffset;
  const limited = buffer.readUInt8(offset) === 1;
  offset += 1;
  const partial = buffer.readUInt8(offset) === 1;
  offset += 1;
  const workspaceCount = buffer.readUInt32LE(offset);
  offset += 4;
  const workspaces: CachedWorkspace[] = [];
  for (let index = 0; index < workspaceCount; index += 1) {
    const uri = readString(buffer, offset);
    offset = uri.nextOffset;
    const name = readString(buffer, offset);
    offset = name.nextOffset;
    workspaces.push({ uri: uri.value, name: name.value });
  }
  if (offset + 4 > buffer.length) {
    throw new Error('Unexpected end of index cache.');
  }
  const entryCount = buffer.readUInt32LE(offset);
  offset += 4;
  const entries: CachedPath[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 5 > buffer.length) {
      throw new Error('Unexpected end of index cache entry.');
    }
    const workspaceIndex = buffer.readUInt32LE(offset);
    offset += 4;
    const kind = buffer.readUInt8(offset) === 1 ? 'directory' : 'file';
    offset += 1;
    const relativePath = readString(buffer, offset);
    offset = relativePath.nextOffset;
    if (workspaceIndex >= workspaces.length) {
      throw new Error('Invalid workspace reference in index cache.');
    }
    entries.push({ workspaceIndex, kind, relativePath: relativePath.value });
  }
  return { createdAt, fingerprint, limited, partial, workspaces, entries };
}
