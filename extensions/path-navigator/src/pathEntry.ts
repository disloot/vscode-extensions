import type * as vscode from 'vscode';
import { normalizeSearchText } from './search';

export type PathEntryKind = 'file' | 'directory';

export interface PathEntry {
  readonly uri?: vscode.Uri;
  readonly kind: PathEntryKind;
  readonly name: string;
  readonly relativePath: string;
  readonly workspaceName: string;
  readonly workspaceUri: string;
  readonly normalizedName?: string;
  readonly normalizedPath: string;
  readonly normalizedWorkspaceName?: string;
  readonly searchIdentity?: string;
}

export interface PathEntrySource {
  readonly uri?: vscode.Uri;
  readonly kind: PathEntryKind;
  readonly name: string;
  readonly relativePath: string;
  readonly workspaceName: string;
  readonly workspaceUri: string;
  readonly normalizedName?: string;
  readonly normalizedPath?: string;
  readonly normalizedWorkspaceName?: string;
}

export interface PathWorkspaceMetadata {
  readonly workspaceName: string;
  readonly workspaceUri: string;
  readonly normalizedWorkspaceName: string;
}

export function createPathEntry(source: PathEntrySource): PathEntry {
  return {
    ...source,
    normalizedName: source.normalizedName ?? normalizeSearchText(source.name),
    normalizedPath: source.normalizedPath ?? normalizeSearchText(source.relativePath),
    normalizedWorkspaceName:
      source.normalizedWorkspaceName ?? normalizeSearchText(source.workspaceName),
  };
}

/** Index entries omit normalizedName because the catalog already retains it as a key. */
export function createCompactPathEntry(
  source: PathEntrySource,
  sharedWorkspace?: PathWorkspaceMetadata,
): PathEntry {
  const {
    normalizedName: _normalizedName,
    normalizedWorkspaceName: _normalizedWorkspaceName,
    ...compactSource
  } = source;
  if (!sharedWorkspace) {
    return {
      ...compactSource,
      normalizedPath: source.normalizedPath ?? normalizeSearchText(source.relativePath),
    };
  }
  return {
    __proto__: sharedWorkspace,
    uri: compactSource.uri,
    kind: compactSource.kind,
    name: compactSource.name,
    relativePath: compactSource.relativePath,
    normalizedPath: source.normalizedPath ?? normalizeSearchText(source.relativePath),
  } as unknown as PathEntry;
}

export function createPathWorkspaceMetadata(
  workspaceName: string,
  workspaceUri: string,
): PathWorkspaceMetadata {
  return {
    workspaceName,
    workspaceUri,
    normalizedWorkspaceName: normalizeSearchText(workspaceName),
  };
}
