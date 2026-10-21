/**
 * Lớp gọi sang firmware ESP32.
 *
 * Mọi lời gọi đều đi từ MÁY CHỦ Next.js chứ không gọi trực tiếp từ trình duyệt.
 * Lý do: firmware không gửi header CORS, nên nếu trình duyệt gọi thẳng sang IP
 * của ESP32 thì sẽ bị chặn. Gọi từ phía máy chủ vừa tránh được CORS, vừa cho
 * phép dashboard tự thu thập dữ liệu kể cả khi không mở trình duyệt.
 */
import type { Esp32Status } from "./types";

const TIMEOUT_MS = 4000;

/** Sự kiện thô đúng như firmware trả về */
export type RawEvent = {
  id: number;
  ts: number;
  uptime: number;
  type: string;
  label: string;
  src: string;
  state: string;
  note: string;
};

export function baseUrl(host: string): string {
  const h = host.trim().replace(/\/+$/, "");
  if (!h) return "";
  return /^https?:\/\//i.test(h) ? h : `http://${h}`;
}

/** Nếu trang web của firmware có đặt mật khẩu thì khai trong .env.local */
function authHeaders(): Record<string, string> {
  const user = process.env.ESP32_USER;
  const pass = process.env.ESP32_PASS;
  if (!user) return {};
  const token = Buffer.from(`${user}:${pass ?? ""}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

async function get<T>(host: string, pathname: string): Promise<T> {
  const url = `${baseUrl(host)}${pathname}`;
  const res = await fetch(url, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`ESP32 trả về HTTP ${res.status} cho ${pathname}`);
  return (await res.json()) as T;
}

/**
 * @param tgLeaseS nếu > 0: xin ESP32 nhường quyền đọc tin Telegram trong chừng ấy
 *                 giây (firmware mới hiểu tham số ?tg=, firmware cũ bỏ qua).
 */
export function fetchStatus(host: string, tgLeaseS = 0): Promise<Esp32Status> {
  const q = tgLeaseS > 0 ? `?tg=${Math.round(tgLeaseS)}` : "";
  return get<Esp32Status>(host, `/api/status${q}`);
}

/** Kết quả đẩy một file WAV xuống loa */
export type SayResult = { ok: true } | { ok: false; status: number; err: string };

/**
 * Đẩy lời nhắn (file WAV PCM 16-bit mono 16 kHz) xuống ESP32 để phát ra loa.
 * Firmware trả 202 khi đã nhận; 409 loa bận; 423 đang cảnh báo; 413/415 sai file.
 * Ghi ~200–700 KB xuống flash mất vài giây nên thời gian chờ dài hơn lệnh thường.
 */
export async function sendSay(host: string, wav: Buffer, from: string): Promise<SayResult> {
  const url = `${baseUrl(host)}/api/say?from=${encodeURIComponent(from.slice(0, 40))}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "audio/wav" },
      body: new Uint8Array(wav),
      signal: AbortSignal.timeout(45_000),
      cache: "no-store",
    });
    if (res.status === 202 || res.status === 200) return { ok: true };
    const body = (await res.json().catch(() => ({}))) as { err?: string };
    return { ok: false, status: res.status, err: body.err ?? `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: 0, err: friendlyError(err, host) };
  }
}

export function fetchEvents(host: string): Promise<RawEvent[]> {
  return get<RawEvent[]>(host, "/api/events");
}

/** Một lượt trả về của /api/features trên firmware */
export type FeatureResponse = {
  now: number;
  total: number;
  spec: number;
  window: number;
  periodMs: number;
  samples: number[][];
};

/** Lấy chuỗi mẫu đặc trưng, chỉ những mẫu có mốc thời gian lớn hơn `since` */
export function fetchFeatures(host: string, since: number): Promise<FeatureResponse> {
  return get<FeatureResponse>(host, `/api/features?since=${since}`);
}

/** Chuyển tiếp một thao tác (iamok, sos, simfall, testvoice, testtg, ...) */
export async function sendAction(host: string, name: string): Promise<void> {
  const url = `${baseUrl(host)}/api/action?name=${encodeURIComponent(name)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`ESP32 từ chối thao tác "${name}" (HTTP ${res.status})`);
}

/**
 * Khóa chống trùng cho một sự kiện.
 * Ưu tiên dùng giờ thật của thiết bị (ts) để khóa vẫn đúng sau khi khởi động lại
 * dashboard; nếu ESP32 chưa đồng bộ NTP thì dùng uptime.
 */
export function eventKey(e: RawEvent): string {
  return e.ts > 1600000000 ? `t${e.ts}-${e.id}-${e.type}` : `u${e.uptime}-${e.id}-${e.type}`;
}

/** Thông điệp lỗi dễ hiểu cho người dùng cuối */
export function friendlyError(err: unknown, host: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/timeout|abort/i.test(msg)) {
    return `Không nhận được trả lời từ ${host} (quá thời gian chờ). Kiểm tra ESP32 đã cắm điện và cùng mạng Wi-Fi.`;
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) {
    return `Không tìm thấy địa chỉ "${host}". Thử dùng địa chỉ IP (ví dụ 192.168.1.50) thay cho tên .local.`;
  }
  if (/ECONNREFUSED/i.test(msg)) {
    return `${host} từ chối kết nối. ESP32 đã bật nhưng web server chưa chạy?`;
  }
  if (/HTTP 401/.test(msg)) {
    return "Trang web firmware yêu cầu mật khẩu. Khai ESP32_USER / ESP32_PASS trong dashboard/.env.local.";
  }
  return msg;
}
