import { useEffect, useRef, useState } from "react";
import { wsURL } from "./api";
import type { WSEvent } from "../types";

export interface LiveAuctionState {
  price: number | null;
  bidderName: string | null;
  endTimeMs: number | null;
  minIncrement: number | null;
  connected: boolean;
  lastRejectReason: string | null;
  ended: boolean;
  winnerName: string | null;
  finalPrice: number | null;
}

/**
 * Owns the WS connection for one auction room. Reconnects with backoff on
 * drop; every (re)connect gets an immediate "sync" event from the server so
 * the UI never shows stale state after a network hiccup (see report TC-07).
 */
export function useAuctionSocket(itemID: string | undefined) {
  const [state, setState] = useState<LiveAuctionState>({
    price: null,
    bidderName: null,
    endTimeMs: null,
    minIncrement: null,
    connected: false,
    lastRejectReason: null,
    ended: false,
    winnerName: null,
    finalPrice: null,
  });
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!itemID) return;
    let cancelled = false;
    let retryDelay = 1000;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    function connect() {
      if (cancelled) return;
      const ws = new WebSocket(wsURL(itemID!));
      socketRef.current = ws;

      ws.onopen = () => {
        retryDelay = 1000;
        setState((s) => ({ ...s, connected: true }));
      };

      ws.onmessage = (evt) => {
        const data: WSEvent = JSON.parse(evt.data);
        setState((s) => {
          switch (data.type) {
            case "sync":
            case "price_update":
              return {
                ...s,
                price: data.price ?? s.price,
                bidderName: data.bidder_name ?? s.bidderName,
                endTimeMs: data.end_time_ms ?? s.endTimeMs,
                minIncrement: data.min_increment ?? s.minIncrement,
                lastRejectReason: null,
              };
            case "bid_rejected":
              return { ...s, lastRejectReason: data.reason ?? "rejected" };
            case "auction_ended":
              return {
                ...s,
                ended: true,
                winnerName: data.winner_name ?? null,
                finalPrice: data.final_price ?? s.price,
              };
            default:
              return s;
          }
        });
      };

      ws.onclose = () => {
        setState((s) => ({ ...s, connected: false }));
        if (cancelled) return;
        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 10000);
      };

      ws.onerror = () => ws.close();
    }

    connect();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      socketRef.current?.close();
    };
  }, [itemID]);

  function sendBid(amount: number) {
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "bid", amount }));
    }
  }

  return { state, sendBid };
}
