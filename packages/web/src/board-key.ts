/**
 * The virtual board's signing key: a P-256 key this browser makes for itself the first time, the way the
 * Huddle button makes one in its flash. The private half is made non-extractable, so no script (Huddle's
 * own included) can read it out; it's kept in this browser's IndexedDB and only ever asked to sign. Huddle and
 * shops get the public half: the raw uncompressed point, base64url, as the button sends it.
 *
 * A key in a browser is only as safe as the browser. It's for trying Huddle without the button; for real
 * money, sign with the button.
 */

export interface BoardKey {
  /** The public point, base64url: sent in hello. */
  readonly key: string;
  /** The first 8 bytes of SHA-256(point), in hex fours: the same in Devices and on the board. */
  readonly fingerprint: string;
  /** False when this browser can't keep it (a private window, storage blocked): it's new on every visit. */
  readonly kept: boolean;
  /** This board's signature of exactly this text: ECDSA P-256 over SHA-256 of its UTF-8, r‖s, base64url. */
  sign(text: string): Promise<string>;
}

const DB = "huddle-board";
const STORE = "keys";
const ID = "board";
const ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** "1A2B 3C4D 5E6F 7A8B" from a key's SHA-256. */
export function fingerprintOf(hash: Uint8Array): string {
  const hex = [...hash.slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
  return hex.match(/.{4}/g)!.join(" ");
}

/** A board key from a key pair: what the board says, and how it signs. */
export async function boardKeyOf(pair: CryptoKeyPair, kept: boolean, subtle: SubtleCrypto = crypto.subtle): Promise<BoardKey> {
  const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  const hash = new Uint8Array(await subtle.digest("SHA-256", raw));
  return {
    key: base64url(raw),
    fingerprint: fingerprintOf(hash),
    kept,
    sign: async (text) => base64url(new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(text)))),
  };
}

/** A new key pair; the private half can sign but never be read out. */
export function makeKeyPair(subtle: SubtleCrypto = crypto.subtle): Promise<CryptoKeyPair> {
  return subtle.generateKey(ALGORITHM, false, ["sign", "verify"]) as Promise<CryptoKeyPair>;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB didn't open."));
  });
}

function read(db: IDBDatabase): Promise<CryptoKeyPair | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).get(ID);
    request.onsuccess = () => resolve(request.result as CryptoKeyPair | undefined);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB didn't read."));
  });
}

function write(db: IDBDatabase, pair: CryptoKeyPair): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put(pair, ID);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB didn't save."));
  });
}

let loading: Promise<BoardKey> | null = null;

/** This browser's board key, made the first time; one that can't be kept lasts until the page closes. */
export function loadBoardKey(): Promise<BoardKey> {
  loading ??= (async () => {
    try {
      const db = await open();
      try {
        const held = await read(db);
        if (held?.privateKey && held.publicKey) return await boardKeyOf(held, true);
        const pair = await makeKeyPair();
        await write(db, pair);
        return await boardKeyOf(pair, true);
      } finally {
        db.close();
      }
    } catch {
      // No IndexedDB here (a private window, storage blocked): a key for this visit only.
      return boardKeyOf(await makeKeyPair(), false);
    }
  })();
  return loading;
}

/** Forgets this browser's key, so the next one is new: after the board's been removed in Devices, say. */
export async function forgetBoardKey(): Promise<void> {
  loading = null;
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).delete(ID);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB didn't delete."));
    });
    db.close();
  } catch {
    // Nothing kept to forget.
  }
}
