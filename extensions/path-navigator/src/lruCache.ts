export class LruCache<K, V> {
  private readonly values = new Map<K, V>();
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = Number.isFinite(capacity)
      ? Math.max(0, Math.floor(capacity))
      : 0;
  }

  get(key: K): V | undefined {
    const value = this.values.get(key);
    if (value === undefined) {
      return undefined;
    }
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.capacity === 0) {
      return;
    }
    this.values.delete(key);
    this.values.set(key, value);
    while (this.values.size > this.capacity) {
      const oldest = this.values.keys().next();
      if (oldest.done) {
        return;
      }
      this.values.delete(oldest.value);
    }
  }

  clear(): void {
    this.values.clear();
  }
}
