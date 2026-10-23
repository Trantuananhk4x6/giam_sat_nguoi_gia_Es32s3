/**
 * Kiểu dữ liệu + hàm thuần cho API Wi-Fi v2 của firmware ESP32.
 *
 * File này dùng chung cho MÁY CHỦ (lib/esp32.ts, các route /api/wifi/...) và
 * TRÌNH DUYỆT (trang /wifi) nên không được import thứ gì của Node.
 *
 * Hợp đồng với firmware (lỗi luôn là HTTP 4xx/5xx + {"ok":false,"err":"<tiếng Việt>"}):
 *   GET  /api/wifi/state                 -> WifiState
 *   GET  /api/wifi/scan[?fresh=1]        -> WifiScanResult (không chặn; scanning=true thì hỏi lại ~1,2 s)
 *   GET  /api/wifi/list                  -> WifiSavedNet[]
 *   POST /api/wifi/add     ssid,pass,connect=1|0 -> {"ok":true,"connecting":bool} | 400 | 500 | 507 (đầy)
 *   POST /api/wifi/remove  ssid          -> 200 | 404 | 500
 *   POST /api/wifi/connect ssid          -> 200 | 404 (thất bại thì thiết bị tự quay về mạng cũ)
 *   POST /api/wifi/portal  on=1|0        -> {"ok":true,"portal":bool}
 *
 *   - Mọi POST phải kèm header "X-OALPHA: 1", thiếu -> 403 (trang web lạ không gửi được
 *     header tùy biến khi chưa qua preflight CORS, nên không giả mạo được lệnh ghi).
 *   - add/remove trả 500 = KHÔNG có gì thay đổi (không ghi được bộ nhớ trong).
 *   - add cho mạng ĐANG NỐI (đổi mật khẩu): firmware luôn thử ngay (connecting=true kể cả
 *     connect=0); sai thì giữ mật khẩu cũ rồi nối lại, attempt.rolledBack=true và
 *     attempt.text kết thúc bằng " — đã giữ lại mật khẩu cũ".
 */

/** Số vạch sóng: 0 = rất yếu / không có sóng, 4 = rất mạnh */
export type WifiBars = 0 | 1 | 2 | 3 | 4;

/** Kết quả một lần thử kết nối */
export type WifiResult = "ok" | "trying" | "wrong_pass" | "not_found" | "timeout" | "fail";

/** Lần thử kết nối gần nhất mà firmware ghi lại */
export type WifiAttempt = {
  /** Tăng dần sau mỗi lần thử — dùng để nhận ra kết quả MỚI sau khi bấm nút */
  id: number;
  ssid: string;
  result: WifiResult;
  /** Mã lý do ngắt kết nối của ESP-IDF (wifi_err_reason_t); 0 nếu không có */
  reason: number;
  /** Câu giải thích tiếng Việt do firmware soạn sẵn */
  text: string;
  /** Cách đây bao nhiêu giây */
  ago: number;
  /** true = người dùng yêu cầu (add/connect); false = firmware tự nối lại */
  user: boolean;
  /**
   * true = lượt đổi mật khẩu mạng đang nối bị hỏng và firmware đã quay về mật khẩu cũ
   * (text kết thúc " — đã giữ lại mật khẩu cũ"). Firmware cũ không gửi -> false.
   */
  rolledBack: boolean;
};

/** Giai đoạn của bộ quản lý Wi-Fi trong firmware */
export type WifiPhase = "idle" | "scanning" | "connecting" | "connected" | "waiting";

/** Vì sao Wi-Fi cấu hình (AP) đang bật; "" = đang tắt */
export type WifiPortalReason = "auto" | "manual" | "";

/** GET /api/wifi/state */
export type WifiState = {
  phase: WifiPhase;
  up: boolean;
  /** Mạng đang nối; "" nếu chưa nối */
  ssid: string;
  ip: string;
  rssi: number;
  bars: WifiBars;
  channel: number;
  /** SSID đang thử nối; "" nếu không thử mạng nào */
  trying: string;
  attempt: WifiAttempt | null;
  /** Wi-Fi cấu hình (AP + trang cấu hình) đang bật */
  portal: boolean;
  portalReason: WifiPortalReason;
  /** Tên (SSID) AP thiết bị đang phát; "" nếu tắt */
  ap: string;
  apIp: string;
  /** Số máy đang nối vào AP */
  apClients: number;
  /** AP tự tắt sau bấy nhiêu giây */
  closesIn: number;
  /** Số mạng đã lưu */
  saved: number;
  /** Số mạng tối đa lưu được; 0 = không rõ */
  max: number;
  /** Firmware đang quét mạng xung quanh */
  scanning: boolean;
  /** Tên máy mDNS: http://<hostname>.local; "" = không rõ */
  hostname: string;
  /**
   * Firmware đang tạm dừng tự nối mạng vì có người dùng trang cấu hình qua Wi-Fi cấu hình
   * (AP) — để STA không kéo AP sang kênh khác làm điện thoại rớt khỏi trang. Bản cũ: false.
   */
  paused: boolean;
  /** Thời gian lớn nhất của một vòng WifiMgr::loop() trong ~60 s gần nhất (µs); 0 = không rõ */
  loopMaxUs: number;
};

/** Một mạng quét được xung quanh thiết bị (firmware đã bỏ mạng ẩn) */
export type WifiScanNet = {
  ssid: string;
  rssi: number;
  bars: WifiBars;
  /** true = có mật khẩu */
  enc: boolean;
  /** Kênh; 0 = không rõ */
  ch: number;
  /** Đã lưu trong thiết bị */
  saved: boolean;
};

/** GET /api/wifi/scan */
export type WifiScanResult = {
  scanning: boolean;
  /** Tuổi của kết quả (giây); -1 = chưa có kết quả nào */
  age: number;
  nets: WifiScanNet[];
};

/** GET /api/wifi/list — một mạng đã lưu (KHÔNG kèm mật khẩu) */
export type WifiSavedNet = {
  ssid: string;
  /** Thiết bị đang nối mạng này */
  current: boolean;
  /** Lưu không mật khẩu (mạng mở) */
  open: boolean;
  /** Có thấy trong lần quét gần nhất */
  seen: boolean;
  rssi: number;
  bars: WifiBars;
  /** Kết quả lần thử gần nhất; "" = chưa thử */
  last: WifiResult | "";
  /** Lần thử gần nhất cách đây bao nhiêu giây; -1 = chưa thử */
  lastAgo: number;
};

// ------------------------------------------------------------ hiển thị ------

/** Quy đổi dBm ra số vạch (khi firmware không gửi `bars`, ví dụ bản cũ) */
export function barsFromRssi(rssi: number): WifiBars {
  if (!Number.isFinite(rssi) || rssi >= 0) return 0; // 0 dBm = chưa nối / không rõ
  if (rssi >= -55) return 4;
  if (rssi >= -65) return 3;
  if (rssi >= -75) return 2;
  if (rssi >= -85) return 1;
  return 0;
}

const SIGNAL_TEXT = ["Rất yếu", "Yếu", "Trung bình", "Mạnh", "Rất mạnh"] as const;

/** Chữ chất lượng sóng: "Rất mạnh" / "Mạnh" / "Trung bình" / "Yếu" / "Rất yếu" */
export function signalText(bars: WifiBars): string {
  return SIGNAL_TEXT[bars] ?? SIGNAL_TEXT[0];
}

/** Nhãn đọc cho trình đọc màn hình, ví dụ "Sóng mạnh, -54 dBm" */
export function signalLabel(bars: WifiBars, rssi: number): string {
  const q = signalText(bars).toLocaleLowerCase("vi-VN");
  return rssi < 0 ? `Sóng ${q}, ${rssi} dBm` : `Sóng ${q}`;
}

const RESULT_LABEL: Record<WifiResult, string> = {
  ok: "Đã kết nối",
  trying: "Đang thử",
  wrong_pass: "Sai mật khẩu",
  not_found: "Không thấy mạng",
  timeout: "Hết thời gian chờ",
  fail: "Lỗi",
};

/** Nhãn tiếng Việt cho kết quả thử kết nối ("" = chưa thử lần nào) */
export function resultLabel(r: WifiResult | ""): string {
  return r ? (RESULT_LABEL[r] ?? RESULT_LABEL.fail) : "Chưa thử";
}

const PHASE_LABEL: Record<WifiPhase, string> = {
  idle: "Chưa kết nối",
  scanning: "Đang quét mạng",
  connecting: "Đang kết nối",
  connected: "Đã kết nối",
  waiting: "Đang chờ để thử lại",
};

/** Nhãn tiếng Việt cho giai đoạn Wi-Fi của firmware */
export function phaseLabel(p: WifiPhase): string {
  return PHASE_LABEL[p] ?? PHASE_LABEL.idle;
}

/**
 * Micro-giây ra chữ mili-giây 1 chữ số thập phân, dấu phẩy kiểu Việt: 420 -> "0,4 ms",
 * 12345 -> "12,3 ms". Dưới 0,05 ms ghi "dưới 0,1 ms" thay vì "0,0 ms".
 */
export function usToMsText(us: number): string {
  if (!Number.isFinite(us) || us <= 0) return "0 ms";
  const tenths = Math.round(us / 100);
  if (tenths === 0) return "dưới 0,1 ms";
  return `${Math.floor(tenths / 10)},${tenths % 10} ms`;
}

/** "45 giây trước", "3 phút trước", "2 giờ trước"; -1 = "chưa thử" */
export function agoText(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "chưa thử";
  const s = Math.round(seconds);
  if (s < 5) return "vừa xong";
  if (s < 60) return `${s} giây trước`;
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  if (s < 86400) return `${Math.floor(s / 3600)} giờ trước`;
  return `${Math.floor(s / 86400)} ngày trước`;
}

// ------------------------------------------------------------- kiểm tra ------

/** Số byte UTF-8 của chuỗi (SSID tối đa 32 byte, chữ có dấu tốn 2–3 byte/ký tự) */
export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

export const SSID_MAX_BYTES = 32;

/** null nếu tên mạng hợp lệ, ngược lại là câu báo lỗi */
export function ssidError(ssid: string): string | null {
  if (!ssid.trim()) return "Hãy nhập tên mạng (SSID).";
  const n = utf8Bytes(ssid);
  if (n > SSID_MAX_BYTES) {
    return `Tên mạng dài ${n} byte, tối đa ${SSID_MAX_BYTES} byte (chữ có dấu tính 2–3 byte mỗi chữ).`;
  }
  return null;
}

/** null nếu mật khẩu hợp lệ: rỗng (mạng mở), 8–63 ký tự, hoặc đúng 64 ký tự hex */
export function passError(pass: string): string | null {
  if (pass === "" || /^[0-9a-fA-F]{64}$/.test(pass)) return null;
  const n = utf8Bytes(pass);
  if (n < 8) return "Mật khẩu Wi-Fi cần ít nhất 8 ký tự (để trống nếu là mạng mở).";
  if (n > 63) return "Mật khẩu Wi-Fi dài tối đa 63 ký tự (hoặc đúng 64 ký tự hex).";
  return null;
}

// ------------------------------------------------------------ chuẩn hóa ------
// Dữ liệu thô từ firmware được nắn về đúng kiểu ở trên: thiếu trường thì lấy giá
// trị mặc định, nên dashboard vẫn chạy với firmware cũ (v1: scan trả thẳng một
// mảng, enc là số, list chỉ có ssid; /api/status ghi "-" khi chưa nối).

type Obj = Record<string, unknown>;

const RESULTS: readonly string[] = ["ok", "trying", "wrong_pass", "not_found", "timeout", "fail"];
const PHASES: readonly string[] = ["idle", "scanning", "connecting", "connected", "waiting"];

function asObj(v: unknown): Obj {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
}
function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function flag(v: unknown): boolean {
  return v === true || v === 1 || v === "1";
}
/** "-" là cách /api/status ghi "chưa có" */
function text(v: unknown): string {
  const s = str(v);
  return s === "-" ? "" : s;
}
function bars(v: unknown, rssi: number): WifiBars {
  const b = num(v, -1);
  return b >= 0 && b <= 4 ? (Math.round(b) as WifiBars) : barsFromRssi(rssi);
}
function result(v: unknown): WifiResult | "" {
  const s = str(v);
  if (!s) return "";
  return RESULTS.includes(s) ? (s as WifiResult) : "fail";
}

function attempt(v: unknown): WifiAttempt | null {
  const o = asObj(v);
  if (typeof o.id !== "number") return null;
  return {
    id: num(o.id),
    ssid: str(o.ssid),
    result: result(o.result) || "fail",
    reason: num(o.reason),
    text: str(o.text),
    ago: num(o.ago),
    user: flag(o.user),
    rolledBack: flag(o.rolledBack),
  };
}

/** Chuẩn hóa GET /api/wifi/state (cũng dùng được cho khối `wifi` của /api/status) */
export function normalizeState(raw: unknown): WifiState {
  const o = asObj(raw);
  const up = flag(o.up);
  const rssi = up ? num(o.rssi) : 0;
  const att = attempt(o.attempt);
  const phase = str(o.phase);
  const reason = str(o.portalReason);
  return {
    phase: PHASES.includes(phase) ? (phase as WifiPhase) : up ? "connected" : "idle",
    up,
    ssid: up ? text(o.ssid) : "",
    ip: up ? text(o.ip) : "",
    rssi,
    bars: up ? bars(o.bars, rssi) : 0,
    channel: num(o.channel),
    // Hợp đồng ghi `trying` là SSID đang thử; nếu firmware gửi true/false thì lấy
    // tên từ lần thử đang chạy.
    trying:
      typeof o.trying === "string"
        ? text(o.trying)
        : o.trying === true && att?.result === "trying"
          ? att.ssid
          : "",
    attempt: att,
    portal: flag(o.portal),
    portalReason: reason === "auto" || reason === "manual" ? reason : "",
    ap: text(o.ap),
    apIp: text(o.apIp),
    apClients: num(o.apClients),
    closesIn: num(o.closesIn),
    saved: num(o.saved),
    max: num(o.max),
    scanning: flag(o.scanning),
    hostname: text(o.hostname),
    paused: flag(o.paused),
    loopMaxUs: Math.max(0, num(o.loopMaxUs)),
  };
}

/** Chuẩn hóa GET /api/wifi/scan: bỏ mạng ẩn, gộp SSID trùng (giữ sóng mạnh nhất), xếp mạnh → yếu */
export function normalizeScan(raw: unknown): WifiScanResult {
  // Firmware cũ trả thẳng một mảng và quét đồng bộ -> kết quả luôn "mới".
  const o: Obj = Array.isArray(raw) ? { scanning: false, age: 0, nets: raw } : asObj(raw);
  const best = new Map<string, WifiScanNet>();
  for (const item of Array.isArray(o.nets) ? o.nets : []) {
    const n = asObj(item);
    const ssid = str(n.ssid);
    if (!ssid) continue;
    const rssi = num(n.rssi, -100);
    const net: WifiScanNet = {
      ssid,
      rssi,
      bars: bars(n.bars, rssi),
      // v2: boolean; v1: số kiểu mã hóa (0 = mạng mở). Thiếu thì coi như có khóa.
      enc: typeof n.enc === "boolean" ? n.enc : num(n.enc, 1) !== 0,
      ch: num(n.ch),
      saved: flag(n.saved),
    };
    const prev = best.get(ssid);
    if (!prev || net.rssi > prev.rssi) best.set(ssid, { ...net, saved: net.saved || Boolean(prev?.saved) });
  }
  return {
    scanning: flag(o.scanning),
    age: num(o.age, -1),
    nets: [...best.values()].sort((a, b) => b.rssi - a.rssi),
  };
}

/** Chuẩn hóa GET /api/wifi/list */
export function normalizeSaved(raw: unknown): WifiSavedNet[] {
  const out: WifiSavedNet[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const n = asObj(item);
    const ssid = str(n.ssid);
    if (!ssid || out.some((x) => x.ssid === ssid)) continue;
    const seen = flag(n.seen);
    const rssi = seen ? num(n.rssi) : 0;
    out.push({
      ssid,
      current: flag(n.current),
      open: flag(n.open),
      seen,
      rssi,
      bars: seen ? bars(n.bars, rssi) : 0,
      last: result(n.last),
      lastAgo: num(n.lastAgo, -1),
    });
  }
  return out;
}
