import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { fingerprint, keyText, parseSignable, signableText, signedBy } from "../src/countersign.ts";

/**
 * The Huddle button's own signing code (firmware/huddle-button/board_key.h), built on this computer against
 * mbedTLS, the library the board signs with, and checked by the code Huddle and the shop check signatures with.
 * Skipped without a C++ compiler and mbedTLS's headers (apt install g++ libmbedtls-dev).
 */
const host = fileURLToPath(new URL("../../../firmware/huddle-button/test/host", import.meta.url));
const mbedtls = ["/usr/include/mbedtls/ecdsa.h", "/usr/local/include/mbedtls/ecdsa.h", "/opt/homebrew/include/mbedtls/ecdsa.h"].some((path) => existsSync(path));
const compiler = spawnSync("c++", ["--version"]).status === 0;
const skip = !(mbedtls && compiler) && "needs a C++ compiler and mbedTLS (apt install g++ libmbedtls-dev)";

let dir = "";
let program = "";

/** What the board says and signs for this text: its key, its fingerprint, and its signature twice. */
function board(text: string): { key: string; fingerprint: string; signatures: [string, string] } {
  const run = spawnSync(program, { input: Buffer.from(text, "utf8") });
  assert.equal(run.status, 0, run.stderr.toString());
  const [key, print, first, second] = run.stdout.toString().trim().split("\n");
  return { key: key!, fingerprint: print!, signatures: [first!, second!] };
}

describe("the button's own signing code", { skip }, () => {
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "huddle-board-"));
    program = join(dir, "board-sign");
    const built = spawnSync("c++", ["-std=c++17", "-Wall", "-Wno-deprecated-declarations", "-I", host, "-o", program, join(host, "sign.cpp"), "-lmbedcrypto"]);
    assert.equal(built.status, 0, built.stderr.toString());
  });
  after(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("makes a key Huddle can hold, with the fingerprint Huddle shows for it", () => {
    const said = board("huddle");
    assert.equal(keyText(said.key), said.key, "the raw P-256 point, base64url, written the one way");
    assert.equal(said.fingerprint, fingerprint(said.key));
    assert.notEqual(board("huddle").key, said.key, "each board makes its own");
  });

  it("signs a payment so Huddle and the shop take it, the same way every time, and only that payment", () => {
    const text = signableText({
      v: 1,
      kind: "buy",
      id: "pay_00112233445566778899aabb",
      shop: { id: "localhost:7700", name: "Bean & Leaf" },
      cart: "cart_1",
      items: [
        { name: "Café latte", qty: 2, price: "4.50" },
        { name: "House blend beans, 1 lb", qty: 1, price: "12.00" },
      ],
      total: "21.00",
      currency: "USD",
      expires: "2026-11-02T10:15:00Z",
    });
    parseSignable(text);
    const said = board(text);
    assert.equal(signedBy(text, said.signatures[0], said.key), true);
    assert.equal(said.signatures[1], said.signatures[0], "deterministic (RFC 6979): no random number needed to sign");
    assert.equal(signedBy(text.replace("21.00", "2.10"), said.signatures[0], said.key), false);
    assert.equal(signedBy(text, said.signatures[0], board(text).key), false, "another board's key doesn't fit it");
  });

  it("signs an allowance the same way", () => {
    const agent = board("agent").key;
    const text = signableText({ v: 1, kind: "allow", id: "allow_00112233445566778899aabb", shop: { id: "localhost:7700", name: "Bean & Leaf" }, for: "Groceries", agent, each: "20.00", total: "50.00", per: "week", currency: "USD", expires: "2026-12-04T10:00:00Z" });
    parseSignable(text);
    const said = board(text);
    assert.equal(signedBy(text, said.signatures[0], said.key), true);
  });

  it("signs a link to a shop the same way", () => {
    const text = signableText({ v: 1, kind: "link", id: "link_00112233445566778899aabb", shop: { id: "localhost:7700", name: "Bean & Leaf" }, expires: "2026-11-02T10:15:00Z" });
    const said = board(text);
    assert.equal(signedBy(text, said.signatures[0], said.key), true);
  });
});
