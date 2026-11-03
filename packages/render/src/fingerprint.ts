import { readFileSync } from "node:fs";

/**
 * The bytes of a source file with Windows line endings turned into Unix ones. Fingerprints of code are taken over these, so a checkout with CRLF files
 * (or one stray carriage return that git would normalise away) gives the same fingerprint as the committed text and does not make validation evidence stale.
 */
export function readNormalized(path: string): Buffer {
  const raw = readFileSync(path);
  return raw.includes(13) ? Buffer.from(raw.toString("latin1").replace(/\r\n/g, "\n").replace(/\r/g, ""), "latin1") : raw;
}
