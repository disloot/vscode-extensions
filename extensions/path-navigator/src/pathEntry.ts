import type * as vscode from 'vscode';
import { normalizeSearchText } from './search';

export type PathEntryKind = 'file' | 'directory';

export interface PathEntry {
  readonly uri: vscode.Uri;
  readonly kind: PathEntryKind;
  readonly name: string;
  readonly relativePath: string;
  readonly workspaceName: string;
  readonly workspaceUri: string;
  readonly normalizedName: string;
  readonly normalizedPath: string;
  readonly normalizedWorkspaceName: string;
  readonly searchIdentity: string;
}

export interface PathEntrySource {
  readonly uri: vscode.Uri;
  readonly kind: PathEntryKind;
  readonly name: string;
  readonly relativePath: string;
  readonly workspaceName: string;
  readonly workspaceUri: string;
  readonly normalizedName?: string;
  readonly normalizedPath?: string;
  readonly normalizedWorkspaceName?: string;
}

export function createPathEntry(source: PathEntrySource): PathEntry {
  return {
    ...source,
    normalizedName: source.normalizedName ?? normalizeSearchText(source.name),
    normalizedPath: source.normalizedPath ?? normalizeSearchText(source.relativePath),
    normalizedWorkspaceName:
      source.normalizedWorkspaceName ?? normalizeSearchText(source.workspaceName),
    searchIdentity: `${source.workspaceUri}\0${source.kind}\0${source.relativePath}`,
  };
}
