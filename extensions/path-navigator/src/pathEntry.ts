import * as vscode from 'vscode';

export type PathEntryKind = 'file' | 'directory';

export interface PathEntry {
  readonly uri: vscode.Uri;
  readonly kind: PathEntryKind;
  readonly name: string;
  readonly relativePath: string;
  readonly workspaceName: string;
  readonly workspaceUri: string;
}
