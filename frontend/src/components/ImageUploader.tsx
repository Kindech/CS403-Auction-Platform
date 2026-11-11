import { useEffect, useRef, useState, type DragEvent } from "react";
import { ApiError, MAX_IMAGE_BYTES, MAX_IMAGES, uploadImage } from "../lib/api";

const ACCEPT = "image/jpeg,image/png,image/webp,image/gif";

interface Pending {
  key: string;
  preview: string; // local object URL while uploading
}

interface Props {
  urls: string[];
  onChange: (urls: string[]) => void;
  onBusyChange?: (busy: boolean) => void;
}

// Picks photos from the seller's computer (click or drag-and-drop), uploads
// each one as soon as it's chosen, and keeps the uploaded URLs in order. The
// first photo is the cover shown on item cards.
export function ImageUploader({ urls, onChange, onBusyChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // latest list, so uploads finishing out of order append to the current one
  const urlsRef = useRef(urls);
  urlsRef.current = urls;

  async function addFiles(files: FileList | File[]) {
    setError(null);
    const list = Array.from(files);
    const room = MAX_IMAGES - urlsRef.current.length - pending.length;
    if (list.length > room) setError(`ใส่ได้สูงสุด ${MAX_IMAGES} รูปต่อสินค้า`);
    const accepted: File[] = [];
    for (const f of list.slice(0, Math.max(room, 0))) {
      if (!ACCEPT.split(",").includes(f.type)) {
        setError(`${f.name}: รองรับเฉพาะไฟล์ JPG, PNG, WebP, GIF`);
      } else if (f.size > MAX_IMAGE_BYTES) {
        setError(`${f.name}: ไฟล์ใหญ่เกิน 8 MB`);
      } else {
        accepted.push(f);
      }
    }
    if (accepted.length === 0) return;

    const jobs = accepted.map((f) => ({ file: f, key: crypto.randomUUID(), preview: URL.createObjectURL(f) }));
    setPending((p) => [...p, ...jobs.map(({ key, preview }) => ({ key, preview }))]);
    // one at a time, so the photos keep the order they were picked in
    for (const job of jobs) {
      try {
        const url = await uploadImage(job.file);
        urlsRef.current = [...urlsRef.current, url];
        onChange(urlsRef.current);
      } catch (err) {
        setError(`${job.file.name}: ${err instanceof ApiError ? err.message : "อัปโหลดไม่สำเร็จ"}`);
      } finally {
        URL.revokeObjectURL(job.preview);
        setPending((p) => p.filter((x) => x.key !== job.key));
      }
    }
  }

  // busy while any upload (from any pick) is still running
  const busy = pending.length > 0;
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  function remove(i: number) {
    onChange(urls.filter((_, j) => j !== i));
  }

  function makeCover(i: number) {
    onChange([urls[i], ...urls.filter((_, j) => j !== i)]);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  }

  const full = urls.length + pending.length >= MAX_IMAGES;

  return (
    <div>
      <p className="text-xs uppercase tracking-wider text-ink-muted mb-1">
        รูปภาพสินค้า <span className="normal-case tracking-normal">({urls.length}/{MAX_IMAGES})</span>
      </p>
      <div className="grid grid-cols-4 sm:grid-cols-5 gap-2">
        {urls.map((u, i) => (
          <div key={u} className="relative aspect-square rounded-md overflow-hidden border border-slate-200 group">
            <img src={u} alt={`รูปที่ ${i + 1}`} className="w-full h-full object-cover" />
            {i === 0 ? (
              <span className="absolute bottom-0 inset-x-0 bg-ink/75 text-gold text-[10px] text-center py-0.5">
                รูปปก
              </span>
            ) : (
              <button
                type="button"
                onClick={() => makeCover(i)}
                className="absolute bottom-0 inset-x-0 bg-ink/60 text-white text-[10px] py-0.5 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
              >
                ตั้งเป็นรูปปก
              </button>
            )}
            <button
              type="button"
              onClick={() => remove(i)}
              aria-label={`ลบรูปที่ ${i + 1}`}
              className="absolute top-1 right-1 w-5 h-5 rounded-full bg-ink/70 text-white text-xs leading-5 hover:bg-red-600"
            >
              ×
            </button>
          </div>
        ))}
        {pending.map((p) => (
          <div key={p.key} className="relative aspect-square rounded-md overflow-hidden border border-slate-200">
            <img src={p.preview} alt="" className="w-full h-full object-cover opacity-40" />
            <span className="absolute inset-0 grid place-items-center text-[10px] text-ink">กำลังอัปโหลด…</span>
          </div>
        ))}
        {!full && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`aspect-square rounded-md border-2 border-dashed text-ink-muted text-[11px] flex flex-col items-center justify-center gap-1 transition-colors ${
              dragging ? "border-gold bg-gold/10" : "border-slate-300 hover:border-gold"
            }`}
          >
            <span className="text-xl leading-none">+</span>
            เพิ่มรูป
          </button>
        )}
      </div>
      <p className="text-[11px] text-ink-muted mt-1">
        เลือกหรือลากไฟล์มาวาง · JPG, PNG, WebP, GIF ไม่เกิน 8 MB ต่อรูป · รูปแรกคือรูปปก
      </p>
      {error && <p className="text-red-600 text-xs mt-1">{error}</p>}
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) addFiles(e.target.files);
          e.target.value = ""; // picking the same file again still fires onChange
        }}
      />
    </div>
  );
}
