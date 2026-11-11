import { useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { itemImages, type Bid, type Item } from "../types";
import { formatMoney } from "../lib/format";
import { leadingBidId } from "../lib/bidding";
import { computeBidStats, formatPct } from "../lib/bidStats";
import { BidHistoryTable, formatDateTime } from "./BidHistory";
import { ImageGallery } from "./ImageGallery";

function Trophy() {
  return (
    <svg viewBox="0 0 64 64" className="w-12 h-12" aria-hidden>
      <path d="M18 8h28v14a14 14 0 0 1-28 0V8z" fill="currentColor" />
      <path d="M18 12H8v4a10 10 0 0 0 10 10M46 12h10v4a10 10 0 0 1-10 10" fill="none" stroke="currentColor" strokeWidth="4" />
      <path d="M28 36h8v8h-8zM20 48h24v6H20z" fill="currentColor" />
    </svg>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-4 py-3 text-center">
      <p className="text-[11px] uppercase tracking-wider text-ink-muted">{label}</p>
      <p className="font-mono-digits text-lg sm:text-xl font-bold text-ink mt-1">{value}</p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-2 border-t border-slate-100 text-sm">
      <span className="text-ink-muted">{label}</span>
      <span className="text-ink text-right">{children}</span>
    </div>
  );
}

// The page an ended auction shows: who won, at what price, how the auction
// went (stats), the item itself, and the full ranked bid history.
export function WinnerAnnouncement({
  item,
  winnerName,
  finalPrice,
  bids,
  viewerIsWinner,
}: {
  item: Item;
  winnerName: string | null;
  finalPrice: number | null;
  bids: Bid[];
  viewerIsWinner: boolean;
}) {
  const hasWinner = !!winnerName;
  const leaderId = hasWinner ? leadingBidId(bids) : null;
  const stats = useMemo(() => computeBidStats(bids, item.starting_price), [bids, item.starting_price]);
  const price = finalPrice ?? stats.highest ?? item.starting_price;
  const increasePct = hasWinner ? ((price - item.starting_price) / item.starting_price) * 100 : null;

  return (
    <div className="max-w-5xl mx-auto">
      <div className="relative overflow-hidden bg-ink text-cream rounded-2xl px-6 py-10 sm:py-12 text-center mb-6">
        <div className="absolute inset-0 opacity-20 bg-[radial-gradient(circle_at_50%_0%,var(--color-gold),transparent_60%)]" />
        <div className="relative">
          <div
            className={`mx-auto mb-4 w-20 h-20 rounded-full grid place-items-center ${
              hasWinner ? "bg-gold/20 text-gold ring-4 ring-gold/30" : "bg-cream/10 text-cream/50"
            }`}
          >
            <Trophy />
          </div>
          <p className="text-[11px] tracking-[0.25em] text-gold uppercase mb-2">การประมูลสิ้นสุดแล้ว</p>
          {hasWinner ? (
            <>
              <h1 className="font-serif-display text-3xl sm:text-4xl font-bold mb-2">
                {viewerIsWinner ? "ขอแสดงความยินดี คุณชนะการประมูล!" : "ขอแสดงความยินดีกับผู้ชนะ"}
              </h1>
              <p className="text-cream/70 mb-6">
                <span className="text-gold font-semibold text-lg">{winnerName}</span> ชนะการประมูล{" "}
                <span className="text-cream">{item.title}</span>
              </p>
              <p className="text-cream/60 text-xs uppercase tracking-wider">ราคาที่ชนะ</p>
              <p className="font-mono-digits text-4xl sm:text-5xl font-bold text-gold mt-1">{formatMoney(price)}</p>
            </>
          ) : (
            <>
              <h1 className="font-serif-display text-3xl font-bold mb-2">{item.title}</h1>
              <p className="text-cream/70">ไม่มีผู้เสนอราคา สินค้านี้จึงไม่มีการขาย</p>
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-y sm:divide-y-0 divide-slate-100 rounded-xl border border-slate-100 bg-white shadow-card mb-8">
        <Stat label="จำนวนการเสนอราคา" value={stats.bidCount.toLocaleString()} />
        <Stat label="ผู้เข้าร่วมประมูล" value={`${stats.bidderCount.toLocaleString()} คน`} />
        <Stat label="ราคาเพิ่มขึ้น" value={formatPct(increasePct)} />
        <Stat
          label="สิ้นสุดเมื่อ"
          value={new Date(item.end_time).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit" })}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <div className="lg:col-span-2 rounded-xl border border-slate-100 bg-white shadow-card p-4 h-fit">
          <ImageGallery images={itemImages(item)} alt={item.title} />
          <h2 className="font-serif-display text-xl font-bold text-ink">{item.title}</h2>
          {item.description && <p className="text-sm text-ink-muted mt-1 mb-3 whitespace-pre-line">{item.description}</p>}
          <Row label="ราคาเริ่มต้น">
            <span className="font-mono-digits">{formatMoney(item.starting_price)}</span>
          </Row>
          <Row label="ราคาสุดท้าย">
            <span className="font-mono-digits font-semibold">{hasWinner ? formatMoney(price) : "ไม่มีการขาย"}</span>
          </Row>
          <Row label="ผู้ขาย">{item.seller_name ?? "-"}</Row>
          <Row label="เริ่มประมูล">{formatDateTime(item.start_time)}</Row>
          <Row label="สิ้นสุดประมูล">{formatDateTime(item.end_time)}</Row>
        </div>

        <div className="lg:col-span-3">
          <h2 className="text-lg font-serif-display font-semibold text-ink mb-3">ประวัติการเสนอราคา</h2>
          <BidHistoryTable bids={bids} leaderId={leaderId} leaderLabel="ผู้ชนะ" />
          <div className="mt-6 text-center">
            <Link
              to="/"
              className="inline-block rounded-full border border-ink/15 px-5 py-2 text-sm text-ink hover:bg-paper transition-colors"
            >
              ← กลับไปเรียกดูสินค้าอื่น
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
