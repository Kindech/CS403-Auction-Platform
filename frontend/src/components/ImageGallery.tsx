import { useState, type ReactNode } from "react";

interface Props {
  images: string[];
  alt: string;
  children?: ReactNode; // overlays on the main photo (status badges)
}

// Main photo with a thumbnail strip underneath when there's more than one.
export function ImageGallery({ images, alt, children }: Props) {
  const [active, setActive] = useState(0);
  const current = images[Math.min(active, images.length - 1)];

  return (
    <div className="mb-4">
      <div className="relative aspect-4/3 bg-paper rounded-xl overflow-hidden border border-slate-100">
        {current ? (
          <img src={current} alt={alt} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full grid place-items-center text-ink-muted/60 text-sm">ไม่มีรูปภาพ</div>
        )}
        {images.length > 1 && (
          <>
            <button
              type="button"
              aria-label="รูปก่อนหน้า"
              onClick={() => setActive((a) => (a - 1 + images.length) % images.length)}
              className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white/80 text-ink shadow hover:bg-white"
            >
              ‹
            </button>
            <button
              type="button"
              aria-label="รูปถัดไป"
              onClick={() => setActive((a) => (a + 1) % images.length)}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white/80 text-ink shadow hover:bg-white"
            >
              ›
            </button>
            <span className="absolute bottom-2 right-2 px-2 py-0.5 rounded-full bg-ink/70 text-cream text-[10px]">
              {Math.min(active, images.length - 1) + 1} / {images.length}
            </span>
          </>
        )}
        {children}
      </div>
      {images.length > 1 && (
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
          {images.map((src, i) => (
            <button
              key={src + i}
              type="button"
              onClick={() => setActive(i)}
              aria-label={`ดูรูปที่ ${i + 1}`}
              className={`shrink-0 w-16 h-16 rounded-md overflow-hidden border-2 transition-colors ${
                i === active ? "border-gold" : "border-transparent opacity-70 hover:opacity-100"
              }`}
            >
              <img src={src} alt="" className="w-full h-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
