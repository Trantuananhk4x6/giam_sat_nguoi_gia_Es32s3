/** Các hàm định dạng dùng chung cho giao diện (an toàn khi chạy ở trình duyệt). */

export function hhmmss(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} giờ ${m} phút`;
  if (m > 0) return `${m} phút ${s % 60} giây`;
  return `${s} giây`;
}

export function clockOf(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleTimeString("vi-VN");
}

export function dateTimeOf(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("vi-VN");
}

export function movementText(m: number): string {
  return ["Không có", "Nằm/ngồi im", "Đang hoạt động"][m] ?? "—";
}

/** Lớp CSS cho thẻ trạng thái lớn, theo mã trạng thái của firmware */
export function heroClass(state: string | undefined): string {
  switch (state) {
    case "CO_NGUOI":
      return "ok";
    case "NGHI_NGO_TE_NGA":
      return "warn";
    case "KHAN_CAP":
      return "bad";
    default:
      return "idle";
  }
}

/** Hiệu hai mốc thời gian, ra chuỗi giây; trả "—" nếu thiếu mốc nào */
export function deltaSec(a: number | null, b: number | null, digits = 1): string {
  if (a === null || b === null) return "—";
  return `${((a - b) / 1000).toFixed(digits)} s`;
}
