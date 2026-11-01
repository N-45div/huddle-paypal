import { useEffect, useState } from "react";
import { api, describeError } from "../api.ts";
import { useApp } from "../app-context.ts";
import { loadBoardKey } from "../board-key.ts";
import { Empty, ErrorNote, Hint, Loading } from "../components/bits.tsx";
import { signableIn } from "../components/Payment.tsx";
import { useChanges } from "../events.ts";
import { ago } from "../format.ts";
import { useResource } from "../hooks.ts";
import type { SignerView, SignView } from "../types.ts";

interface Held {
  readonly key?: string;
  readonly approveUrl?: string;
  readonly paypal?: string | null;
}

const held = (link: SignView): Held => (link.result ?? {}) as Held;
const shopName = (link: SignView) => signableIn(link.text)?.shop.name ?? link.shop;

/** Where a link to a shop is, in a few words. */
function linkState(link: SignView, board: string): string {
  if (link.status === "waiting") return `Waiting for ${board} to sign it.`;
  if (link.status === "signed") return held(link).approveUrl ? "Signed. Say yes on PayPal's page to finish." : "Signed; handing it to the shop…";
  if (link.status === "linked") return `Linked${held(link).paypal ? `: ${held(link).paypal}` : ""}. It charges this PayPal only for carts the board signs.`;
  if (link.status === "expired") return "Expired before the board signed it.";
  if (link.status === "declined") return link.error ?? "You said no.";
  return `Didn't link: ${link.error ?? "the shop said no"}`;
}

/**
 * The boards that sign for you (the button, this browser's virtual one) and linking each to your PayPal at a
 * shop: the shop writes what the board signs, the board signs it, then you say yes on PayPal's page, and PayPal
 * sends you back here. From then on the shop charges your PayPal only for carts that board signs.
 */
export function YourBoards() {
  const { authVersion } = useApp();
  const boards = useResource(() => api.signers(), [authVersion]);
  const links = useResource(() => api.links(), [authVersion]);
  const info = useResource(() => api.info(), [authVersion]);
  const [mine, setMine] = useState<string | null>(null);
  const [shop, setShop] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const address = shop ?? info.data?.shop ?? "";

  useEffect(() => {
    void loadBoardKey().then(
      (board) => setMine(board.key),
      () => setMine(null),
    );
  }, []);

  useChanges((change) => {
    if (change.kind === "sign" || change.kind === "devices" || change.kind === "resync") {
      void boards.reload();
      void links.reload();
    }
  });

  // Back from PayPal (?paypal=linked, cancelled or failed): ask the shop how each signed link went, then tidy the address.
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).get("paypal")) return;
    void (async () => {
      try {
        for (const link of (await api.links()).filter((one) => one.status === "signed")) await api.checkLink(link.id);
      } catch (caught) {
        setError(describeError(caught));
      }
      void links.reload();
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
    })();
  }, [authVersion]);

  const link = async (board: SignerView) => {
    if (!/^https?:\/\//.test(address.trim())) return setError("Give the shop's address, like https://huddle.example.com/shop.");
    setBusy(board.key);
    setError(null);
    try {
      await api.startLink(address.trim(), board.key);
      void links.reload();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(null);
    }
  };

  const check = async (one: SignView) => {
    setBusy(one.id);
    try {
      await api.checkLink(one.id);
      void links.reload();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(null);
    }
  };

  const nameOf = (key: string | undefined) => boards.data?.find((board) => board.key === key)?.name ?? "the board";
  const linkedAt = (key: string) => [...new Set((links.data ?? []).filter((one) => one.status === "linked" && held(one).key === key).map(shopName))];

  return (
    <section className="devices" aria-labelledby="boards-title">
      <h2 id="boards-title" className="section-title">
        Boards that sign
      </h2>
      <Hint>Only a board you hold says yes to a payment: it signs the exact cart, and the shop charges your PayPal only for what it signed. Link a board at a shop once, then it can pay there.</Hint>
      <div className="card add-device">
        <div className="field field-grow">
          <label htmlFor="link-shop">Shop's address</label>
          <input id="link-shop" value={address} placeholder="https://huddle.example.com/shop" autoComplete="off" onChange={(event) => setShop(event.target.value)} />
        </div>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </div>
      {boards.error && <ErrorNote message={boards.error} onRetry={() => void boards.reload()} />}
      {boards.loading && !boards.data && <Loading label="Loading boards…" />}
      {boards.data && boards.data.length === 0 && (
        <Empty title="No boards yet.">
          <p className="hint">The virtual button above is one as soon as it connects; the Huddle button is one once it says its key.</p>
        </Empty>
      )}
      {boards.data && boards.data.length > 0 && (
        <ul className="note-list">
          {boards.data.map((board) => (
            <li key={board.key} className="note-item">
              <div className="note-text">
                <p>
                  {board.name}
                  {board.key === mine && <span className="badge board-here">This browser</span>}
                </p>
                <p className="note-meta">
                  <code>{board.fingerprint}</code> · {board.lastSignedAt ? <>signed {ago(board.lastSignedAt)}</> : "hasn't signed yet"}
                  {linkedAt(board.key).length > 0 && <> · linked at {linkedAt(board.key).join(", ")}</>}
                </p>
              </div>
              <div className="note-actions">
                {removing === board.key ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger-solid"
                      onClick={() =>
                        void api.removeSigner(board.key).then(
                          () => {
                            setRemoving(null);
                            void boards.reload();
                          },
                          (caught: unknown) => setError(describeError(caught)),
                        )
                      }
                    >
                      Remove
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRemoving(null)}>
                      Keep
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className="btn btn-sm" disabled={busy === board.key || !address} onClick={() => void link(board)}>
                      {busy === board.key ? "Asking the shop…" : "Link at the shop"}
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost danger-text" onClick={() => setRemoving(board.key)}>
                      Remove
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {links.data && links.data.length > 0 && (
        <ul className="note-list" aria-label="Links to shops">
          {links.data.slice(0, 6).map((one) => (
            <li key={one.id} className="note-item">
              <div className="note-text">
                <p>
                  {shopName(one)} <span className="hint">for {nameOf(held(one).key)}</span>
                </p>
                <p className="note-meta">
                  {linkState(one, nameOf(held(one).key))} {ago(one.createdAt)}
                </p>
              </div>
              {one.status === "signed" && held(one).approveUrl && (
                <div className="note-actions">
                  <a className="btn btn-sm btn-primary" href={held(one).approveUrl}>
                    Open PayPal
                  </a>
                  <button type="button" className="btn btn-sm btn-ghost" disabled={busy === one.id} onClick={() => void check(one)}>
                    Check
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
