/**
 * The whole storage surface. Four methods, because Hdrive runs N configured
 * instances at once and every file remembers which one holds its bytes.
 */
export interface StorageBackend {
  /** Synchronous: Bun's presign() is not a promise. */
  presignPut(key: string, mime: string, expiresIn?: number): string;
  /** Passes an HTTP Range through; returns 206 when a range was requested. */
  getStream(key: string, range?: string | null): Promise<Response>;
  /** null means "no such object". Any other failure throws. */
  head(key: string): Promise<{ size: number; mime: string } | null>;
  /** Idempotent: deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
}
