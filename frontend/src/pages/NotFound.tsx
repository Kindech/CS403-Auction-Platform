import { Link } from "react-router-dom";

export function NotFound() {
  return (
    <div className="text-center py-16">
      <h1 className="font-serif-display text-2xl font-bold text-ink mb-2">ไม่พบหน้าที่คุณต้องการ</h1>
      <p className="text-ink-muted text-sm mb-6">ลิงก์นี้อาจไม่ถูกต้องหรือถูกย้ายไปแล้ว</p>
      <Link to="/" className="text-gold-dark font-semibold text-sm hover:underline">
        กลับไปหน้ารายการสินค้า
      </Link>
    </div>
  );
}
