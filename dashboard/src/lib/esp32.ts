/**
 * Lớp gọi sang firmware ESP32.
 *
 * Mọi lời gọi đều đi từ MÁY CHỦ Next.js chứ không gọi trực tiếp từ trình duyệt.
 * Lý do: firmware không gửi header CORS, nên nếu trình duyệt gọi thẳng sang IP
 * của ESP32 thì sẽ bị chặn. Gọi từ phía máy chủ vừa tránh được CORS, vừa cho
 * phép dashboard tự thu thập dữ liệu kể cả khi không mở trình duyệt.
 */
import type { Esp32Status } from "./types";
import {
  normalizeSaved,
  normalizeScan,
  normalizeState,
  type WifiSavedNet,
  type WifiScanNet,
  type WifiScanResult,
  type WifiState,
} from "./wifi-types";

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

/**
 * Firmware TRẢ LỜI nhưng báo lỗi (HTTP 4xx/5xx). `message` là câu tiếng Việt firmware
 * gửi trong {"ok":false,"err":"…"} nếu có; `status` để route chuyển tiếp đúng mã.
 * Lỗi mạng / quá thời gian chờ KHÔNG dùng lớp này (route trả 502).
 */
export class Esp32HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "Esp32HttpError";
    this.status = status;
  }
}

/** Lấy câu lỗi trong body {"err": "..."} của firmware (firmware cũ có thể trả chữ thường) */
async function httpError(res: Response, pathname: string): Promise<Esp32HttpError> {
  let msg = "";
  try {
    const body = (await res.json()) as { err?: unknown };
    if (typeof body?.err === "string") msg = body.err.trim();
  } catch {
    // không phải JSON -> dùng câu mặc định
  }
  return new Esp32HttpError(res.status, msg || `ESP32 trả về HTTP ${res.status} cho ${pathname}`);
}

async function get<T>(host: string, pathname: string, timeoutMs = TIMEOUT_MS): Promise<T> {
  const url = `${baseUrl(host)}${pathname}`;
  const res = await fetch(url, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!res.ok) throw await httpError(res, pathname);
  return (await res.json()) as T;
}

/**
 * @param tgLeaseS nếu > 0: xin ESP32 nhường quyền đọc tin Telegram trong chừng ấy
 *                 giây (firmware mới hiểu tham số ?tg=, firmware cũ bỏ qua).
 * @param zlLeaseS tương tự cho bot Zalo (?zl=).
 */
export function fetchStatus(host: string, tgLeaseS = 0, zlLeaseS = 0): Promise<Esp32Status> {
  const q = new URLSearchParams();
  if (tgLeaseS > 0) q.set("tg", String(Math.round(tgLeaseS)));
  if (zlLeaseS > 0) q.set("zl", String(Math.round(zlLeaseS)));
  const qs = q.toString();
  return get<Esp32Status>(host, `/api/status${qs ? `?${qs}` : ""}`);
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

// --------------------------------------------------------------- Wi-Fi ------

// API Wi-Fi v2 (hợp đồng ghi ở đầu lib/wifi-types.ts). Dữ liệu được chuẩn hóa
// ngay tại đây nên route và trang /wifi luôn nhận đúng kiểu, kể cả khi gặp
// firmware cũ (scan trả mảng, enc là số, list chỉ có ssid).

/** @deprecated tên cũ — dùng WifiScanNet trong lib/wifi-types.ts */
export type WifiScanEntry = WifiScanNet;
/** @deprecated tên cũ — dùng WifiSavedNet trong lib/wifi-types.ts */
export type WifiSavedEntry = WifiSavedNet;

/** Lệnh ghi Wi-Fi: firmware ghi NVS xong mới trả lời nên cho chờ lâu hơn lệnh thường */
const WIFI_POST_TIMEOUT_MS = 6000;
/**
 * Firmware mới trả /api/wifi/scan ngay (kết quả cũ + cờ scanning), nhưng firmware cũ
 * quét ĐỒNG BỘ trong task web: 13 kênh × 300 ms ≈ 3,9 s cộng overhead -> chờ hẳn 10 s.
 */
const WIFI_SCAN_TIMEOUT_MS = 10000;

type FirmwareReply = { ok?: unknown; err?: unknown; [key: string]: unknown };

/**
 * Gửi form application/x-www-form-urlencoded sang firmware rồi đọc JSON trả về.
 * Luôn kèm header "X-OALPHA: 1": firmware từ chối (403) mọi POST Wi-Fi thiếu header này,
 * để trang web lạ không giả mạo được lệnh bằng form tự submit (firmware cũ bỏ qua header).
 * Firmware báo lỗi bằng 4xx/5xx + {"ok":false,"err":"…"} -> ném Esp32HttpError
 * mang đúng câu và mã đó để route chuyển tiếp cho trình duyệt.
 */
async function postForm(
  host: string,
  pathname: string,
  fields: Record<string, string>,
  timeoutMs = WIFI_POST_TIMEOUT_MS,
): Promise<FirmwareReply> {
  const url = `${baseUrl(host)}${pathname}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/x-www-form-urlencoded",
      "X-OALPHA": "1",
    },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!res.ok) throw await httpError(res, pathname);
  const body = (await res.json().catch(() => ({}))) as FirmwareReply;
  // Hợp đồng: lỗi luôn kèm mã 4xx/5xx. Phòng trường hợp firmware trả 200 mà ok=false.
  if (body.ok === false) {
    const msg = typeof body.err === "string" && body.err.trim() ? body.err.trim() : `ESP32 từ chối lệnh ${pathname}`;
    throw new Esp32HttpError(400, msg);
  }
  return body;
}

/** Trạng thái Wi-Fi chi tiết: giai đoạn, lần thử gần nhất, Wi-Fi cấu hình (AP)… */
export async function wifiState(host: string): Promise<WifiState> {
  return normalizeState(await get<unknown>(host, "/api/wifi/state"));
}

/**
 * Các mạng quanh thiết bị. Không chặn: firmware trả ngay kết quả gần nhất (age giây,
 * -1 = chưa có) kèm cờ scanning; fresh=true yêu cầu quét lại.
 */
export async function wifiScan(host: string, fresh = false): Promise<WifiScanResult> {
  const raw = await get<unknown>(host, `/api/wifi/scan${fresh ? "?fresh=1" : ""}`, WIFI_SCAN_TIMEOUT_MS);
  return normalizeScan(raw);
}

/** Danh sách mạng đã lưu trong firmware (không kèm mật khẩu) */
export async function wifiList(host: string): Promise<WifiSavedNet[]> {
  return normalizeSaved(await get<unknown>(host, "/api/wifi/list"));
}

/**
 * Lưu (hoặc đổi mật khẩu) một mạng. connect=false khi thiết bị đang có mạng -> chỉ
 * lưu, không chuyển. Riêng mạng ĐANG NỐI (đổi mật khẩu): firmware luôn thử ngay
 * (connecting=true), sai thì giữ mật khẩu cũ và nối lại (attempt.rolledBack=true).
 * 400 = dữ liệu sai, 507 = danh sách đầy, 500 = không ghi được bộ nhớ, chưa đổi gì.
 */
export async function wifiAdd(
  host: string,
  ssid: string,
  pass: string,
  connect: boolean,
): Promise<{ connecting: boolean }> {
  const r = await postForm(host, "/api/wifi/add", { ssid, pass, connect: connect ? "1" : "0" });
  // Firmware cũ không gửi `connecting` (và luôn tự nối lại sau khi lưu).
  return { connecting: typeof r.connecting === "boolean" ? r.connecting : connect };
}

/** Xóa một mạng đã lưu (404 = không có mạng đó, 500 = không ghi được bộ nhớ, chưa xóa gì) */
export async function wifiRemove(host: string, ssid: string): Promise<void> {
  await postForm(host, "/api/wifi/remove", { ssid });
}

/** Chuyển ngay sang một mạng ĐÃ LƯU (404 = chưa lưu); thất bại thì firmware tự quay về mạng cũ */
export async function wifiConnect(host: string, ssid: string): Promise<void> {
  await postForm(host, "/api/wifi/connect", { ssid });
}

/** Bật/tắt Wi-Fi cấu hình (AP) của thiết bị */
export async function wifiPortal(host: string, on: boolean): Promise<{ portal: boolean }> {
  const r = await postForm(host, "/api/wifi/portal", { on: on ? "1" : "0" });
  return { portal: typeof r.portal === "boolean" ? r.portal : on };
}

/** Chuyển tiếp một thao tác (iamok, sos, simfall, testvoice, testtg, ...) */
export async function sendAction(host: string, name: string): Promise<void> {
  const url = `${baseUrl(host)}/api/action?name=${encodeURIComponent(name)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...authHeaders(), "X-OALPHA": "1" },
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

/**
 * Mã HTTP + câu lỗi để route trả về trình duyệt:
 *  - firmware trả lời nhưng báo lỗi (4xx/5xx, ví dụ 400 sai dữ liệu, 404 không có mạng,
 *    507 danh sách đầy) -> giữ nguyên mã đó và câu tiếng Việt của firmware;
 *  - lỗi mạng / quá thời gian chờ / dữ liệu hỏng -> 502 + friendlyError.
 */
export function errorReply(err: unknown, host: string): { status: number; error: string } {
  if (err instanceof Esp32HttpError) {
    return { status: err.status, error: err.status === 401 ? friendlyError(err, host) : err.message };
  }
  return { status: 502, error: friendlyError(err, host) };
}
