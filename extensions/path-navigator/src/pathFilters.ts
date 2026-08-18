export function normalizeExcludedFileExtensions(values: readonly string[]): Set<string> {
  const extensions = new Set<string>();
  for (const value of values) {
    const normalized = value.trim().toLocaleLowerCase();
    if (!normalized) {
      continue;
    }
    extensions.add(normalized.startsWith('.') ? normalized : `.${normalized}`);
  }
  return extensions;
}

export function hasExcludedFileExtension(
  normalizedName: string,
  extensions: ReadonlySet<string>,
): boolean {
  for (const extension of extensions) {
    if (normalizedName.endsWith(extension)) {
      return true;
    }
  }
  return false;
}
