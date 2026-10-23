// The two host capabilities the digest builders need but shared/ cannot import: a hash for grouping keys and path
// relativisation. The plugin server injects Node's `createHash`/`node:path` so its digest output is unchanged; the
// remote-host screen injects the pure-JS pair below, which runs anywhere React Native does.
export interface DigestEnv {
  /** Deterministic key for grouping identical paths and commands; never read back, never a security boundary. */
  hash(value: string): string;
  /** `path` as seen from `cwd`: a relative path when it is inside, the absolute path when it is not. */
  relativize(cwd: string, path: string): string;
}

/** FNV-1a style 64-bit mix, as hex. Only ever compared for equality (pathKey / commandKey). */
export function stableHash(value: string): string {
  let low = 0x811c9dc5, high = 0x01000193;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    low = Math.imul(low ^ code, 0x01000193) >>> 0;
    high = Math.imul(high ^ code, 0x85ebca6b) >>> 0;
  }
  return low.toString(16).padStart(8, "0") + high.toString(16).padStart(8, "0");
}

/** POSIX segments with `.` dropped and `..` applied; enough for a remote host's display path and grouping key. */
function segmentsOf(path: string): string[] {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (out.length && out[out.length - 1] !== "..") out.pop(); else out.push(".."); continue; }
    out.push(part);
  }
  return out;
}
function resolvePosix(cwd: string, path: string): string {
  const segments = path.startsWith("/") ? segmentsOf(path) : segmentsOf(`${cwd}/${path}`);
  return `/${segments.filter(segment => segment !== "..").join("/")}`;
}
/** The same rule as the server's node:path version: inside the cwd it reads relative, outside it stays absolute. */
export function relativizePosix(cwd: string, path: string): string {
  const base = cwd || "/", absolute = resolvePosix(base, path);
  const from = segmentsOf(base.startsWith("/") ? base : `/${base}`), to = segmentsOf(absolute);
  let shared = 0;
  while (shared < from.length && shared < to.length && from[shared] === to[shared]) shared++;
  const inside = [...Array.from({ length: from.length - shared }, () => ".."), ...to.slice(shared)].join("/");
  return !inside.startsWith("../") && inside !== ".." && !inside.startsWith("/") ? inside || "." : absolute;
}

/** What the remote-host screen passes: no node:crypto, no node:path. */
export const jsDigestEnv: DigestEnv = { hash: stableHash, relativize: relativizePosix };

/** UTF-8 byte length. Node's Buffer when present, so the server's size bounding is byte-identical to before. */
export const utf8Length: (text: string) => number =
  typeof Buffer !== "undefined" && typeof Buffer.byteLength === "function" ? (text: string) => Buffer.byteLength(text, "utf8")
    : typeof TextEncoder !== "undefined" ? (() => { const encoder = new TextEncoder(); return (text: string) => encoder.encode(text).length; })()
      : (text: string) => {
        let bytes = 0;
        for (let index = 0; index < text.length; index++) {
          const code = text.charCodeAt(index);
          if (code < 0x80) bytes += 1;
          else if (code < 0x800) bytes += 2;
          else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) { bytes += 4; index++; }
          else bytes += 3;
        }
        return bytes;
      };

/** Lets other work run between batches of a long first read: Node's setImmediate when it exists, else a 0 ms timer. */
export const yieldTurn = (): Promise<void> =>
  new Promise<void>(resolve => { if (typeof setImmediate === "function") setImmediate(resolve); else setTimeout(resolve, 0); });
