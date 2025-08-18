/**
 * LRU (Least Recently Used) Cache Implementation
 * Prevents memory leaks by maintaining a maximum size
 */
export class LRUCache<K, V> {
  private maxSize: number;
  private cache = new Map<K, V>();

  constructor(maxSize: number = 10000) {
    this.maxSize = maxSize;
  }

  set(key: K, value: V): void {
    // If at capacity and key doesn't exist, remove oldest entry
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    
    // Move to end (most recently used) by deleting and re-adding
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    this.cache.set(key, value);
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  keys(): IterableIterator<K> {
    return this.cache.keys();
  }

  values(): IterableIterator<V> {
    return this.cache.values();
  }

  entries(): IterableIterator<[K, V]> {
    return this.cache.entries();
  }

  size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }

  // Get cache statistics
  getStats(): { size: number; maxSize: number; usageRatio: number } {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      usageRatio: this.cache.size / this.maxSize,
    };
  }

  // Prune cache to a specific size (useful for manual cleanup)
  prune(targetSize: number): number {
    let removed = 0;
    while (this.cache.size > targetSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
        removed++;
      } else {
        break;
      }
    }
    return removed;
  }
}
