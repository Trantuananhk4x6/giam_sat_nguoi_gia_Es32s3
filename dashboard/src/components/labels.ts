/** Nhãn hiển thị dùng chung cho các trang của người nhà (an toàn ở trình duyệt). */
import type { SpeakStatus } from "@/lib/types";

export const LEVEL_LABEL: Record<string, string> = {
  "binh-thuong": "Bình thường",
  "chu-y": "Cần chú ý",
  "khan-cap": "Khẩn cấp",
  "khong-ro": "Mất liên lạc",
};

export const SPEAK_LABEL: Record<SpeakStatus, { text: string; tone: string }> = {
  "da-gui": { text: "Loa đã nhận", tone: "ok" },
  "loa-ban": { text: "Chưa phát · loa bận", tone: "warn" },
  "dang-canh-bao": { text: "Chưa phát · đang cảnh báo", tone: "warn" },
  "mat-ket-noi": { text: "Chưa phát · mất kết nối", tone: "bad" },
  "qua-cu": { text: "Không phát · tin quá cũ", tone: "" },
  loi: { text: "Chưa phát · lỗi", tone: "bad" },
};

export const CHANNEL_LABEL = { telegram: "Telegram", web: "Trang web" } as const;

const VN = 7 * 3600 * 1000;
export function hm(ms: number): string {
  const d = new Date(ms + VN);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
export function dayVN(ms: number): string {
  const day = Math.floor((ms + VN) / 86_400_000);
  const today = Math.floor((Date.now() + VN) / 86_400_000);
  if (day === today) return "Hôm nay";
  if (day === today - 1) return "Hôm qua";
  const d = new Date(ms + VN);
  const wd = ["Chủ nhật", "Thứ hai", "Thứ ba", "Thứ tư", "Thứ năm", "Thứ sáu", "Thứ bảy"][d.getUTCDay()];
  return `${wd}, ${d.getUTCDate()}/${d.getUTCMonth() + 1}/${d.getUTCFullYear()}`;
}
export function ago(ms: number | null): string {
  if (!ms) return "chưa có dữ liệu";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 10) return "vừa xong";
  if (s < 60) return `${s} giây trước`;
  if (s < 3600) return `${Math.round(s / 60)} phút trước`;
  return `${Math.floor(s / 3600)} giờ trước`;
}
export const capFirst = (s: string) => (s ? s[0].toLocaleUpperCase("vi") + s.slice(1) : s);

/** Bỏ tiền tố lệnh khi hiển thị: "/hoitham@Bot mẹ ơi..." -> "mẹ ơi..." */
export function withoutCommand(text: string): string {
  return text.replace(/^\/(hoitham|loinhan|nhan)(@\w+)?\s*/i, "");
}
