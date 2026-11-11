import { useState } from "react";

// An item photo that falls back to a neutral "no photo" box when there is no
// URL or the image fails to load (e.g. an external link that has gone away),
// instead of the browser's broken-image icon with the alt text over it.
export function ItemPhoto({ src, alt, className = "" }: { src?: string; alt: string; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!src || failed === src) {
    return (
      <div className="w-full h-full grid place-items-center text-ink-muted/50" role="img" aria-label={`${alt} (ไม่มีรูปภาพ)`}>
        <div className="flex flex-col items-center gap-1 text-xs">
          <svg viewBox="0 0 24 24" className="w-8 h-8" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <circle cx="8.5" cy="10" r="1.5" />
            <path d="M21 16l-5-5-8 8" />
          </svg>
          ไม่มีรูปภาพ
        </div>
      </div>
    );
  }
  return <img src={src} alt={alt} onError={() => setFailed(src)} className={className} />;
}
