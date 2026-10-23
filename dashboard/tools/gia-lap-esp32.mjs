/**
 * Bộ giả lập firmware ESP32 — dùng để phát triển và demo dashboard khi chưa có
 * phần cứng (radar chưa về, hoặc đang ngồi ở quán cà phê viết báo cáo).
 *
 * Nó dựng một máy chủ HTTP trả về ĐÚNG định dạng JSON mà firmware thật trả về,
 * kèm một máy trạng thái y như trong main.cpp: nghi ngờ té ngã -> đếm ngược 30
 * giây -> khẩn cấp, bấm "Tôi ổn" thì hủy, có cả thời gian nghỉ 60 giây.
 *
 * CÁCH DÙNG
 *   1) node tools/gia-lap-esp32.mjs            (mặc định cổng 8080)
 *   2) Mở dashboard -> trang Cài đặt -> nhập địa chỉ: localhost:8080 -> Lưu
 *   3) Dùng dashboard như bình thường: bấm "Mô phỏng té ngã", đo thực nghiệm...
 *
 * Đổi cổng:  node tools/gia-lap-esp32.mjs 9090
 *
 * Lời nhắn /hoitham gửi xuống "loa" được lưu thành file WAV trong thư mục tạm
 * (in ra màn hình) để mở nghe lại. Đổi thư mục: SIM_SAY_DIR=...
 *
 * WI-FI v2 (trang /wifi của dashboard; hợp đồng ở src/lib/wifi-types.ts)
 *   GET  /api/wifi/state | /api/wifi/scan[?fresh=1] | /api/wifi/list
 *   POST /api/wifi/add | /remove | /connect | /portal — form x-www-form-urlencoded,
 *        BẮT BUỘC kèm header "X-OALPHA: 1" như firmware thật (thiếu -> 403).
 *   Khối "wifi" của /api/status có đủ trường v2 (phase, attempt, paused, loopMaxUs…).
 *   Mô phỏng:
 *     - quét mất ~2 s (scanning=true rồi xong); mỗi lượt thử ~4 s:
 *         mật khẩu "saimatkhau" -> wrong_pass; SSID không có trong danh sách quét
 *         giả -> not_found; còn lại -> ok.
 *     - đổi mật khẩu mạng đã lưu mà thử ngay (mạng đang nối — luôn thử, kể cả
 *       connect=0 —, connect=1, hoặc chưa có mạng): mật khẩu mới chỉ được giữ khi
 *       nối được; hỏng thì attempt.rolledBack=true, giữ mật khẩu cũ rồi thử nhanh
 *       lại bằng mật khẩu cũ (lượt nền). Chuyển mạng hỏng thì quay về mạng vừa dùng.
 *     - chưa có mạng: cứ 10 s thử một mạng đã lưu; mất mạng quá 25 s thì tự bật AP
 *       cấu hình; có mạng lại thì AP tự tắt. Bật tay qua /portal thì tắt sau 10 phút.
 *     - mở http://localhost:<cổng>/wifi lúc AP đang TỰ bật = giả làm điện thoại
 *       đang dùng trang cấu hình -> paused=true trong 30 s (ngừng tự nối nền).
 *   Danh sách quét giả có SSID tiếng Việt, một mạng mở, SSID dài đúng 32 byte và
 *   hai SSID chứa ký tự HTML để thử XSS (phải hiện NGUYÊN VĂN, không thành thẻ).
 *   Biến môi trường:
 *     SIM_WIFI_ATTEMPT_MS=4000  thời gian một lượt thử
 *     SIM_WIFI_SETTLE_MS=250    nghỉ sau lượt hỏng trước lượt kế; tăng lên (vd 3000)
 *                               để dashboard kịp đọc lượt có rolledBack=true
 *     SIM_WIFI_DROP=1           lúc thiết bị chưa có mạng thì không trả lời HTTP
 *                               (như thiết bị thật: dashboard tạm mất liên lạc)
 *     SIM_WIFI_NVS_FAIL=1       add/remove trả 500 "không ghi được bộ nhớ" (không đổi gì)
 *   Muốn về trạng thái ban đầu thì khởi động lại bộ giả lập.
 */
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.argv[2] ?? 8080);

// --- Nhuong quyen doc Telegram (?tg=) + loa doc loi nhan (POST /api/say) ---
// Giong firmware that: dashboard "thue" quyen doc tin qua GET /api/status?tg=<giay>;
// file WAV loi nhan duoc luu ra dia de nghe lai (mac dinh thu muc tam cua may).
const SAY_DIR = process.env.SIM_SAY_DIR ?? join(tmpdir(), "oalpha-gia-lap-loa");
const SAY_MAX_BYTES = 700 * 1024;
let leaseUntil = 0;
// Bot Zalo cua firmware: thue quyen qua ?zl=<giay>. SIM_ZALO_CHATS=0 -> gia lap
// firmware chua khai Zalo (poller "off").
const ZALO_CHATS = Number(process.env.SIM_ZALO_CHATS ?? 1);
let zaloLeaseUntil = 0;
let sayCount = 0;
let lastSayFile = "";

// Các hằng số giống trong include/config.h của firmware
const CONFIRM_WINDOW_S = 30;
const FALL_COOLDOWN_S = Number(process.env.SIM_COOLDOWN_S ?? 60);
/** Giong RADAR_FALL_TIME_S: radar chi bao nga sau khi xac nhan lien tuc 5 giay */
const FALL_CONFIRM_S = Number(process.env.SIM_FALL_CONFIRM_S ?? 5);
const INSTALL_HEIGHT_CM = 270;
const SENSITIVITY = 3;

const bootAt = Date.now();
let state = "CO_NGUOI";
let stateSince = Date.now();
let suspectStart = 0;
let cooldownUntil = 0;
let emergencyAt = 0;
let latencyMs = 0;
let present = true;
let fallFlag = false;
let voiceUntil = 0;
/** Thoi diem "nga that" (khac voi thoi diem radar bao nga) */
let fallAt = 0;

// --- Che do lam viec + sinh hieu (gia lap che do giac ngu) ---
const SLEEP_MODE_ON = process.env.SIM_SLEEP_MODE === "1";
let mode = "TE_NGA";           // TE_NGA | GIAC_NGU | DANG_DOI_CHE_DO
let modeSince = Date.now();
let modeSwitches = 0;
let blindMs = 0;
let inBed = 0;
let rfPresses = 0;
let rfRejected = 0;
let rfLastCode = 0;

// --- Chuoi mau dac trung (gia lap /api/features cua firmware) ---
const FEATURE_PERIOD_MS = 250;
const FEATURE_RING = 400;
const WINDOW = 12;
const features = [];
let featureTotal = 0;
const bootMs = Date.now();
/** millis() cua "thiet bi" gia lap */
const deviceMs = () => Date.now() - bootMs;

let nextId = 1;
const events = [];
const stats = { suspects: 0, cancelled: 0, emergency: 0, sos: 0 };
const telegram = { sent: 0, pending: 0, last: "chua gui lan nao" };

function nowS() {
  return Math.floor(Date.now() / 1000);
}

function log(type, label, src, note = "") {
  events.push({
    id: nextId++,
    ts: nowS(),
    uptime: Math.floor((Date.now() - bootAt) / 1000),
    type,
    label,
    src,
    state,
    note,
  });
  if (events.length > 40) events.shift(); // firmware chỉ giữ 40 dòng trong RAM
  console.log(`[ev] ${type.padEnd(14)} ${note}`);
}

function goto(next) {
  if (state === next) return;
  state = next;
  stateSince = Date.now();
  console.log(`[state] -> ${next}`);
}

function enterSuspect(src) {
  suspectStart = Date.now();
  fallFlag = true;
  voiceUntil = Date.now() + 2200;
  goto("NGHI_NGO_TE_NGA");
  stats.suspects++;
  log("FALL_SUSPECT", "Nghi ngờ té ngã", src, "radar bao te nga");
}

function raiseEmergency(src, note) {
  emergencyAt = Date.now();
  goto("KHAN_CAP");
  stats.emergency++;
  log("EMERGENCY", "Phát cảnh báo khẩn cấp", src, note);
  // Giả lập thời gian bắt tay HTTPS + gửi Telegram: 1,2 – 2,2 giây
  const delay = 1200 + Math.random() * 1000;
  telegram.pending++;
  setTimeout(() => {
    telegram.pending--;
    telegram.sent++;
    telegram.last = "OK";
    latencyMs = Date.now() - suspectStart;
    log(
      "TELEGRAM_OK",
      "Gửi Telegram thành công",
      "SYSTEM",
      `tong ${(latencyMs / 1000).toFixed(1)}s tu luc nga`,
    );
  }, delay);
}

function confirmSafe(src) {
  if (state === "NGHI_NGO_TE_NGA") {
    const ms = Date.now() - suspectStart;
    stats.cancelled++;
    log("CANCELLED", 'Người dùng bấm "Tôi ổn"', src, `phan hoi sau ${(ms / 1000).toFixed(1)}s`);
    cooldownUntil = Date.now() + FALL_COOLDOWN_S * 1000;
    fallFlag = false;
    fallAt = 0;
    goto("CO_NGUOI");
  } else if (state === "KHAN_CAP") {
    log(
      "RECOVERED",
      "Đã xác nhận an toàn",
      src,
      `xac nhan an toan sau ${Math.round((Date.now() - emergencyAt) / 1000)}s`,
    );
    cooldownUntil = Date.now() + FALL_COOLDOWN_S * 1000;
    fallFlag = false;
    fallAt = 0;
    goto("CO_NGUOI");
  } else {
    log("TEST", "Thao tác thử nghiệm", src, "bam nut xanh luc binh thuong");
  }
}

/**
 * Sinh mot mau dac trung moi 250 ms, co "hinh dang" giong that:
 *   - binh thuong : bien do chuyen dong 20-55, khoang cach dao quanh 200 cm
 *   - vua te nga  : bien do vot len roi tut xuong gan 0, khoang cach giam
 *   - khan cap    : nam im, bien do rat thap, co co nam im mot cho
 * Nho vay model huan luyen tu bo gia lap van hoc duoc mot thu gi co nghia.
 */
setInterval(() => {
  const sinceFall = fallAt ? Date.now() - fallAt : 1e9;
  const falling = sinceFall < 1500;          // cu va dap keo dai ~1,5 giay
  // Sau cu va dap thi nam im cho den khi duoc xac nhan an toan
  const down = !falling && sinceFall < 1e9 && (
    state === "KHAN_CAP" || state === "NGHI_NGO_TE_NGA" || sinceFall < FALL_CONFIRM_S * 1000);

  let range;
  if (falling) range = 70 + Math.round(Math.random() * 30);   // vot len luc dang nga
  else if (down) range = Math.round(Math.random() * 8);        // nam im sau khi nga
  else if (present) range = 20 + Math.round(Math.random() * 35);
  else range = 0;

  let dist;
  if (!present) dist = 0;
  else if (down || falling) dist = 240 + Math.round(Math.random() * 40);
  else dist = 150 + Math.round(Math.random() * 120);

  const movement = !present ? 0 : down ? 1 : 2;
  const staticStay = down && sinceFall > 8000 ? 1 : 0;

  features.push([deviceMs(), present ? 1 : 0, movement, range, staticStay, dist, 0, 0]);
  if (features.length > FEATURE_RING) features.shift();
  featureTotal++;
}, FEATURE_PERIOD_MS);

/** Vòng lặp máy trạng thái, 200 ms một nhịp */
setInterval(() => {
  if (state === "NGHI_NGO_TE_NGA" && Date.now() - suspectStart >= CONFIRM_WINDOW_S * 1000) {
    raiseEmergency("RADAR", `het ${CONFIRM_WINDOW_S}s khong phan hoi`);
  }
  if (state === "CO_NGUOI" && !present) goto("KHONG_NGUOI");
  if (state === "KHONG_NGUOI" && present) goto("CO_NGUOI");
}, 200);

/** Thoi gian "mu" khi doi che do. Rut ngan duoc qua bien moi truong de test nhanh. */
const SWITCH_BLIND_MS = Number(process.env.SIM_SWITCH_BLIND_MS ?? 15000);

function doSwitchMode(target) {
  if (mode === target || mode === "DANG_DOI_CHE_DO") return;
  const from = mode;
  mode = "DANG_DOI_CHE_DO";
  console.log(`[sim] doi che do ${from} -> ${target} (mu ${SWITCH_BLIND_MS / 1000}s)`);
  setTimeout(() => {
    mode = target;
    modeSince = Date.now();
    modeSwitches++;
    blindMs += SWITCH_BLIND_MS;
    inBed = target === "GIAC_NGU" ? 1 : 0;
    log("MODE_SWITCH", "Radar đổi chế độ làm việc", "SYSTEM",
        `sang ${target}, mu ${(SWITCH_BLIND_MS / 1000).toFixed(1)}s`);
  }, SWITCH_BLIND_MS);
}

/** Sinh hieu gia lap: chi co so lieu khi dang o che do giac ngu */
function vitalsJson() {
  if (mode !== "GIAC_NGU") {
    return {
      valid: false, heartRate: 0, breatheValue: 0, breatheState: 0,
      inBed: 0, sleepState: 3, sleepScore: 0, struggle: 0, ageMs: 0,
    };
  }
  return {
    valid: true,
    heartRate: 58 + Math.round(Math.random() * 14),      // 58-72 nhip/phut
    breatheValue: 13 + Math.round(Math.random() * 5),    // 13-18 lan/phut
    breatheState: 1,
    inBed,
    sleepState: Math.random() < 0.6 ? 0 : 1,             // ngu sau / ngu nong
    sleepScore: 70 + Math.round(Math.random() * 25),
    struggle: 0,
    ageMs: 300,
  };
}

// =========================================================================
//  Wi-Fi v2 giả lập — cùng hợp đồng với firmware (dashboard/src/lib/wifi-types.ts,
//  src/net/wifi_mgr.cpp). Rút gọn: không có quét trong lượt thử, không giãn cách
//  3/6/12 s, không trần 5 phút cho lúc tạm dừng.
// =========================================================================
const WIFI_HOSTNAME = "canhbao-tenga";      // HOSTNAME trong include/config.h
const WIFI_AP_SSID = WIFI_HOSTNAME;          // AP_SSID mặc định = HOSTNAME
const WIFI_AP_IP = "192.168.4.1";
const WIFI_MAX_SAVED = 8;                    // WIFI_MAX_SAVED
const WIFI_ATTEMPT_MS = Number(process.env.SIM_WIFI_ATTEMPT_MS ?? 4000);
const WIFI_FAST_MS = Math.min(WIFI_ATTEMPT_MS, 2500);   // lượt thử nhanh (mạng vừa dùng)
const WIFI_SETTLE_MS = Number(process.env.SIM_WIFI_SETTLE_MS ?? 250);   // nghỉ sau lượt hỏng
const WIFI_SCAN_MS = 2000;
const WIFI_SCAN_CACHE_MS = 20000;            // kết quả cũ hơn thì tự quét lại
const WIFI_SCAN_FRESH_MIN_MS = 3000;         // ?fresh=1 ngay sau lượt quét vừa xong thì thôi
const WIFI_PORTAL_AFTER_MS = 25000;          // mất mạng quá 25 s -> tự bật AP cấu hình
const WIFI_PORTAL_MANUAL_MS = 10 * 60000;    // AP bật tay tự tắt sau 10 phút (khi đã có mạng)
const WIFI_PORTAL_ACTIVE_MS = 30000;         // có người mở trang cấu hình trong 30 s -> tạm dừng nền
const WIFI_CYCLE_GAP_MS = 10000;             // chưa có mạng: cứ 10 s thử một mạng đã lưu
const WIFI_WRONG_PASS = "saimatkhau";        // mật khẩu này luôn bị bộ phát "từ chối"
/** SIM_WIFI_DROP=1: lúc thiết bị chưa có mạng thì không trả lời HTTP (như thiết bị thật) */
const WIFI_DROP = process.env.SIM_WIFI_DROP === "1";
/** SIM_WIFI_NVS_FAIL=1: add/remove trả 500 "không ghi được bộ nhớ trong" (không đổi gì) */
const WIFI_NVS_FAIL = process.env.SIM_WIFI_NVS_FAIL === "1";

/** "Không khí" quanh thiết bị: mạng nào ở đây thì quét thấy; không có = not_found */
const WIFI_AIR = [
  { ssid: "GIA_LAP_WIFI", rssi: -52, enc: true, ch: 6 },
  { ssid: "Nhà Bà Nội", rssi: -61, enc: true, ch: 1 },
  { ssid: "Nhà Bà Nội", rssi: -83, enc: true, ch: 11 },   // bộ phát thứ hai cùng tên (gộp khi quét)
  { ssid: "Phòng Khách 2.4G", rssi: -67, enc: true, ch: 11 },
  { ssid: "Wi-Fi Tầng Hai Nhà Ông Bảy", rssi: -74, enc: true, ch: 3 },   // đúng 32 byte UTF-8
  { ssid: "Quán Cà Phê Gió", rssi: -79, enc: false, ch: 6 },              // mạng mở
  // Thử XSS: hai SSID này phải hiện NGUYÊN VĂN, không được thành thẻ HTML.
  { ssid: "<b>x</b> \"&amp;\" 'y'", rssi: -70, enc: true, ch: 9 },
  { ssid: "<img src=x onerror=alert(1)>", rssi: -88, enc: true, ch: 13 },
];

/** Mạng đã lưu. Mật khẩu KHÔNG BAO GIỜ ra JSON (giống firmware). */
const wifiSaved = [
  { ssid: "GIA_LAP_WIFI", pass: "matkhau123", last: "ok", lastAt: Date.now() },
  { ssid: "Nhà Bà Nội", pass: "banoi2024", last: "", lastAt: 0 },
];

const wifi = {
  up: true,
  ssid: "GIA_LAP_WIFI",
  rssi: -52,
  channel: 6,
  ip: "127.0.0.1",
  downSince: 0,
  /** Lượt thử gần nhất: { id, ssid, result, reason, startedAt, endedAt, user, rolledBack, cancelled } */
  attempt: null,
  attemptSeq: 0,
  kind: "",            // loại lượt đang/vừa thử: "user" | "fast" | "cand"
  timer: null,         // hẹn kết thúc lượt đang thử
  settleTimer: null,   // hẹn lượt kế tiếp sau khi nghỉ
  prev: "",            // mạng đang dùng lúc người dùng đổi mạng (hỏng thì quay về)
  trial: null,         // { seq, ssid, pass }: mật khẩu MỚI chờ thử, chỉ "ghi NVS" khi nối được
  trialSeq: 0,
  attTrial: 0,         // trial.seq mà lượt đang thử dùng (0 = dùng mật khẩu đã lưu)
  prevLast: { last: "", lastAt: 0 },   // kết quả cũ của mạng đang thử (trả lại khi lùi/hủy)
  portal: false,
  portalReason: "",    // "auto" | "manual"
  closeAt: 0,
  holdAutoUntil: 0,    // người dùng tự tắt AP lúc chưa có mạng -> 10 phút không tự bật lại
  portalHitAt: 0,      // lần cuối có người mở trang cấu hình (GET /wifi)
  scanning: false,
  scanAt: 0,
  scanNets: [],
  nextBgAt: 0,
  bgIndex: 0,
  loop: { start: Date.now(), cur: 0, prev: 0 },
};
// Lúc khởi động firmware thử thẳng mạng dùng gần nhất (lượt thử nhanh, không quét) và nối được.
wifi.attempt = {
  id: ++wifi.attemptSeq, ssid: wifi.ssid, result: "ok", reason: 0,
  startedAt: Date.now(), endedAt: Date.now(), user: false, rolledBack: false, cancelled: false,
};

const WIFI_TEXT = {
  trying: "Đang kết nối…",
  ok: "Đã kết nối",
  wrong_pass: "Sai mật khẩu Wi-Fi",
  not_found: "Không thấy mạng này (ESP32 chỉ bắt Wi-Fi 2,4 GHz)",
  timeout: "Quá thời gian chờ (sóng yếu hoặc router không cấp IP)",
};

function wifiBars(rssi) {
  if (rssi >= 0) return 0;
  if (rssi >= -55) return 4;
  if (rssi >= -65) return 3;
  if (rssi >= -75) return 2;
  if (rssi >= -85) return 1;
  return 0;
}
const wifiFind = (ssid) => wifiSaved.find((n) => n.ssid === ssid);
/** Bộ phát mạnh nhất của một SSID trong "không khí" (undefined = không có) */
const wifiAir = (ssid) =>
  WIFI_AIR.filter((a) => a.ssid === ssid).sort((a, b) => b.rssi - a.rssi)[0];
const wifiValidSsid = (s) => {
  const n = Buffer.byteLength(s, "utf8");
  return n >= 1 && n <= 32;
};
const wifiValidPass = (p) => {
  if (p === "" || /^[0-9a-fA-F]{64}$/.test(p)) return true;
  const n = Buffer.byteLength(p, "utf8");
  return n >= 8 && n <= 63;
};

/** Ghi nhận thời gian một vòng WifiMgr::loop() giả lập (µs); loopMaxUs = lớn nhất ~60 s */
function wifiCost(minUs, maxUs) {
  const us = Math.round(minUs + Math.random() * (maxUs - minUs));
  const now = Date.now();
  if (now - wifi.loop.start >= 60000) {
    wifi.loop.prev = wifi.loop.cur;
    wifi.loop.cur = 0;
    wifi.loop.start = now;
  }
  if (us > wifi.loop.cur) wifi.loop.cur = us;
}

/**
 * Như updatePause() của firmware: chỉ tạm dừng khi AP TỰ bật, thiết bị chưa có mạng và có
 * người dùng trang cấu hình trong 30 s gần nhất (bỏ qua trần 5 phút của firmware).
 */
function wifiPaused(now = Date.now()) {
  return wifi.portal && wifi.portalReason === "auto" && !wifi.up && wifi.portalHitAt > 0 &&
    now - wifi.portalHitAt < WIFI_PORTAL_ACTIVE_MS;
}
function wifiApClients(now = Date.now()) {
  return wifi.portal && wifi.portalHitAt > 0 && now - wifi.portalHitAt < 60000 ? 1 : 0;
}

function wifiDown(now) {
  if (!wifi.up) return;
  console.log(`[wifi] Roi mang "${wifi.ssid}"`);
  wifi.up = false;
  wifi.ssid = "";
  wifi.rssi = 0;
  wifi.channel = 0;
  wifi.downSince = now;
}

function wifiUp(ssid, air, now) {
  wifi.up = true;
  wifi.ssid = ssid;
  wifi.rssi = air.rssi + Math.round(Math.random() * 4 - 2);
  wifi.channel = air.ch;
  wifi.downSince = 0;
  wifi.prev = "";
  // AP tự bật mà nay đã có mạng: còn người dùng thì giữ 60 s cho kịp thấy kết quả, không thì 5 s.
  if (wifi.portal && wifi.portalReason === "auto") wifi.closeAt = now + (wifiApClients(now) ? 60000 : 5000);
}

function wifiPortalOpen(reason, now) {
  wifi.portal = true;
  wifi.portalReason = reason;
  wifi.closeAt = reason === "manual" ? now + WIFI_PORTAL_MANUAL_MS : 0;
  wifiCost(3000, 4500);
  console.log(`[wifi] Bat AP cau hinh "${WIFI_AP_SSID}" (${reason === "manual" ? "bat tay" : "tu bat vi mat mang"})`);
}

function wifiPortalClose() {
  wifi.portal = false;
  wifi.portalReason = "";
  wifi.closeAt = 0;
  wifi.portalHitAt = 0;
  wifiCost(2500, 4000);
  console.log("[wifi] Tat AP cau hinh");
}

/** Lượt đang thử dùng đúng mật khẩu chờ thử MỚI NHẤT? (bị thay giữa chừng thì không) */
const wifiOwnsTrial = () => wifi.attTrial !== 0 && wifi.trial?.seq === wifi.attTrial;

/** Kết quả một lượt thử theo luật của bộ giả lập */
function wifiOutcome(ssid, pass) {
  const air = wifiAir(ssid);
  if (!air) return { result: "not_found", reason: 201 };            // WIFI_REASON_NO_AP_FOUND
  if (pass === WIFI_WRONG_PASS) return { result: "wrong_pass", reason: 15 };   // 4WAY_HANDSHAKE_TIMEOUT
  return { result: "ok", reason: 0, air };
}

/** Bắt đầu một lượt thử (kind: "user" | "fast" | "cand"). false nếu mạng không còn lưu. */
function wifiStart(ssid, kind) {
  const net = wifiFind(ssid);
  if (!net) return false;
  const now = Date.now();
  if (wifi.up) wifiDown(now);
  const useTrial = kind === "user" && wifi.trial?.ssid === ssid;
  wifi.attTrial = useTrial ? wifi.trial.seq : 0;
  wifi.kind = kind;
  wifi.prevLast = { last: net.last, lastAt: net.lastAt };
  net.last = "trying";
  net.lastAt = now;
  wifi.attempt = {
    id: ++wifi.attemptSeq, ssid, result: "trying", reason: 0,
    startedAt: now, endedAt: 0, user: kind === "user", rolledBack: false, cancelled: false,
  };
  wifiCost(1500, 2600);   // WiFi.begin()
  const outcome = wifiOutcome(ssid, useTrial ? wifi.trial.pass : net.pass);
  wifi.timer = setTimeout(() => wifiFinish(outcome), kind === "fast" ? WIFI_FAST_MS : WIFI_ATTEMPT_MS);
  const why = kind === "user" ? "nguoi dung yeu cau" : kind === "fast" ? "thu nhanh" : "chu trinh";
  console.log(`[wifi] Thu #${wifi.attempt.id} "${ssid}" (${why}${useTrial ? ", mat khau moi" : ""})`);
  return true;
}

function wifiFinish(outcome) {
  wifi.timer = null;
  const a = wifi.attempt;
  const net = wifiFind(a.ssid);
  const now = Date.now();
  a.result = outcome.result;
  a.reason = outcome.reason;
  a.endedAt = now;
  if (outcome.result === "ok") {
    // Mật khẩu mới nối được -> giờ mới thay mật khẩu cũ ("ghi NVS").
    if (wifiOwnsTrial()) {
      if (net) net.pass = wifi.trial.pass;
      wifi.trial = null;
      wifiCost(6000, 12000);
    }
    wifi.attTrial = 0;
    if (net) {
      net.last = "ok";
      net.lastAt = now;
    }
    wifiUp(a.ssid, outcome.air, now);
    console.log(`[wifi] Thu #${a.id} "${a.ssid}" -> OK`);
    return;
  }
  // Thử mật khẩu MỚI mà hỏng -> bỏ nó, giữ mật khẩu cũ; "last" trả lại kết quả cũ.
  const rolledBack = wifiOwnsTrial();
  if (rolledBack) wifi.trial = null;
  wifi.attTrial = 0;
  a.rolledBack = rolledBack;
  if (net) {
    if (rolledBack) Object.assign(net, wifi.prevLast);
    else {
      net.last = outcome.result;
      net.lastAt = now;
    }
  }
  console.log(`[wifi] Thu #${a.id} "${a.ssid}" -> ${outcome.result}${rolledBack ? " (giu lai mat khau cu)" : ""}`);
  // Giống firmware: người dùng đổi mạng mà hỏng -> thử nhanh lại mạng vừa dùng; đổi mật
  // khẩu hỏng -> thử nhanh lại chính mạng đó bằng mật khẩu cũ (lượt nền, user=false).
  let fast = "";
  if (wifi.kind === "user") {
    if (wifi.prev && wifi.prev !== a.ssid) fast = wifi.prev;
    else if (rolledBack) fast = a.ssid;
  } else if (wifi.kind === "fast") {
    wifi.prev = "";
  }
  wifi.nextBgAt = now + (fast ? WIFI_SETTLE_MS : WIFI_CYCLE_GAP_MS);
  if (fast) {
    wifi.settleTimer = setTimeout(() => {
      wifi.settleTimer = null;
      if (!wifi.up && !wifi.timer) wifiStart(fast, "fast");
    }, WIFI_SETTLE_MS);
  }
}

/** Hủy lượt đang thử (người dùng chọn mạng khác / mạng bị xóa) */
function wifiAbort(now) {
  if (!wifi.timer) return;
  clearTimeout(wifi.timer);
  wifi.timer = null;
  const a = wifi.attempt;
  const rolledBack = wifiOwnsTrial();
  if (rolledBack) wifi.trial = null;
  wifi.attTrial = 0;
  Object.assign(a, { result: "fail", reason: 0, endedAt: now, cancelled: true, rolledBack });
  const net = wifiFind(a.ssid);
  if (net) Object.assign(net, wifi.prevLast);
  console.log(`[wifi] Huy luot thu #${a.id} "${a.ssid}"${rolledBack ? " -> giu lai mat khau cu" : ""}`);
}

/** Yêu cầu nối của người dùng (add có thử ngay, hoặc connect) */
function wifiUserRequest(ssid, force) {
  const now = Date.now();
  if (wifi.trial && wifi.trial.ssid === ssid) force = true;    // mật khẩu mới chờ thử -> phải thử thật
  else if (wifi.trial && !wifiOwnsTrial()) wifi.trial = null;  // mật khẩu chờ thử của mạng khác -> bỏ
  if (wifi.up && !force && wifi.ssid === ssid) {
    // Đang nối đúng mạng này: báo thành công luôn, khỏi ngắt kết nối vô ích.
    wifi.attempt = {
      id: ++wifi.attemptSeq, ssid, result: "ok", reason: 0,
      startedAt: now, endedAt: now, user: true, rolledBack: false, cancelled: false,
    };
    const net = wifiFind(ssid);
    if (net) Object.assign(net, { last: "ok", lastAt: now });
    return;
  }
  if (wifi.settleTimer) {
    clearTimeout(wifi.settleTimer);
    wifi.settleTimer = null;
  }
  if (wifi.up) {
    wifi.prev = wifi.ssid;
    console.log(`[wifi] Nguoi dung chon "${ssid}" -> roi mang "${wifi.ssid}"`);
  }
  if (wifi.timer) {
    // Giành quyền: lượt đang chạy bị hủy (vẫn hiện ~250 ms) rồi mới tới lượt của người dùng.
    wifiAbort(now);
    wifi.settleTimer = setTimeout(() => {
      wifi.settleTimer = null;
      wifiStart(ssid, "user");
    }, WIFI_SETTLE_MS);
  } else {
    wifiStart(ssid, "user");
  }
}

function wifiRemoveNet(ssid, now) {
  const i = wifiSaved.findIndex((n) => n.ssid === ssid);
  if (i < 0) return false;
  wifiSaved.splice(i, 1);
  if (wifi.trial?.ssid === ssid) wifi.trial = null;
  if (wifi.prev === ssid) wifi.prev = "";
  if (wifi.timer && wifi.attempt?.ssid === ssid) wifiAbort(now);
  // Giống firmware: xóa mạng ĐANG nối không ngắt kết nối; lần rớt mạng sau mới tìm mạng khác.
  console.log(`[wifi] Da xoa mang "${ssid}" (con ${wifiSaved.length})`);
  return true;
}

function wifiScanNow() {
  if (wifi.scanning) return;
  wifi.scanning = true;
  console.log("[wifi] Bat dau quet mang");
  setTimeout(() => {
    wifi.scanning = false;
    wifi.scanAt = Date.now();
    wifi.scanNets = WIFI_AIR.map((n) => ({ ...n, rssi: n.rssi + Math.round(Math.random() * 6 - 3) }));
    console.log(`[wifi] Quet xong: ${new Set(wifi.scanNets.map((n) => n.ssid)).size} mang`);
  }, WIFI_SCAN_MS);
}

/** Mạng quét được, đã gộp SSID trùng (giữ sóng mạnh nhất) như cache của firmware */
function wifiScanBest() {
  const best = new Map();
  for (const n of wifi.scanNets) {
    const p = best.get(n.ssid);
    if (!p || n.rssi > p.rssi) best.set(n.ssid, n);
  }
  return best;
}

function wifiAttemptJson(now) {
  const a = wifi.attempt;
  if (!a) return null;
  const base =
    a.result === "fail" ? (a.cancelled ? "Đã hủy lượt thử" : "Không kết nối được") : WIFI_TEXT[a.result];
  return {
    id: a.id,
    ssid: a.ssid,
    result: a.result,
    reason: a.reason,
    text: a.rolledBack ? `${base} — đã giữ lại mật khẩu cũ` : base,
    ago: Math.floor((now - (a.result === "trying" ? a.startedAt : a.endedAt)) / 1000),
    user: a.user,
    rolledBack: a.rolledBack,
  };
}

function wifiPhase() {
  if (wifi.attempt?.result === "trying" || wifi.settleTimer) return "connecting";
  if (wifi.up) return "connected";
  if (wifi.scanning) return "scanning";
  return wifiSaved.length > 0 && !wifiPaused() ? "waiting" : "idle";
}

/** GET /api/wifi/state */
function wifiStateJson() {
  const now = Date.now();
  return {
    phase: wifiPhase(),
    up: wifi.up,
    ssid: wifi.up ? wifi.ssid : "",
    ip: wifi.up ? wifi.ip : "",
    rssi: wifi.up ? wifi.rssi : 0,
    bars: wifi.up ? wifiBars(wifi.rssi) : 0,
    channel: wifi.up ? wifi.channel : 0,
    trying: wifi.attempt?.result === "trying" ? wifi.attempt.ssid : "",
    attempt: wifiAttemptJson(now),
    portal: wifi.portal,
    portalReason: wifi.portal ? wifi.portalReason : "",
    ap: wifi.portal ? WIFI_AP_SSID : "",
    apIp: wifi.portal ? WIFI_AP_IP : "",
    apClients: wifiApClients(now),
    closesIn: wifi.portal && wifi.closeAt ? Math.max(1, Math.ceil((wifi.closeAt - now) / 1000)) : 0,
    saved: wifiSaved.length,
    max: WIFI_MAX_SAVED,
    scanning: wifi.scanning,
    hostname: WIFI_HOSTNAME,
    paused: wifiPaused(now),
    loopMaxUs: Math.max(wifi.loop.cur, wifi.loop.prev),
  };
}

/** Khối "wifi" của /api/status: trường cũ ("-" khi chưa nối) + trường v2 */
function wifiStatusJson() {
  const s = wifiStateJson();
  return {
    up: s.up,
    ssid: s.up ? s.ssid : "-",
    rssi: s.rssi,
    ip: s.up ? s.ip : "-",
    saved: s.saved,
    portal: s.portal,
    ap: s.ap,
    phase: s.phase,
    trying: s.trying,
    bars: s.bars,
    channel: s.channel,
    apIp: s.apIp,
    apClients: s.apClients,
    attempt: s.attempt,
    paused: s.paused,
    loopMaxUs: s.loopMaxUs,
  };
}

/** GET /api/wifi/scan[?fresh=1]: KHÔNG chặn — trả kết quả gần nhất, cũ thì xin quét lại */
function wifiScanJson(fresh) {
  const now = Date.now();
  const age = wifi.scanAt ? now - wifi.scanAt : 0;
  const stale = !wifi.scanAt || age > WIFI_SCAN_CACHE_MS || (fresh && age >= WIFI_SCAN_FRESH_MIN_MS);
  if (stale) wifiScanNow();
  return {
    scanning: wifi.scanning,
    age: wifi.scanAt ? Math.floor(age / 1000) : -1,
    nets: [...wifiScanBest().values()]
      .sort((a, b) => b.rssi - a.rssi)
      .map((n) => ({
        ssid: n.ssid,
        rssi: n.rssi,
        bars: wifiBars(n.rssi),
        enc: n.enc,
        ch: n.ch,
        saved: Boolean(wifiFind(n.ssid)),
      })),
  };
}

/** GET /api/wifi/list (không kèm mật khẩu) */
function wifiListJson() {
  const now = Date.now();
  const best = wifi.scanAt && now - wifi.scanAt < 5 * 60000 ? wifiScanBest() : new Map();
  return wifiSaved.map((n) => {
    const current = wifi.up && wifi.ssid === n.ssid;
    const s = best.get(n.ssid);
    const seen = current || Boolean(s);
    const rssi = current ? wifi.rssi : s ? s.rssi : 0;
    return {
      ssid: n.ssid,
      current,
      open: n.pass === "",
      seen,
      rssi: seen ? rssi : 0,
      bars: seen ? wifiBars(rssi) : 0,
      last: n.last,
      lastAgo: n.last ? Math.floor((now - n.lastAt) / 1000) : -1,
    };
  });
}

/** Lệnh ghi Wi-Fi (form đã đọc). Trả [mã HTTP, thân JSON] đúng như firmware. */
function wifiCommand(pathname, f) {
  const now = Date.now();
  const notFound = [404, { ok: false, err: "Không có mạng này trong danh sách đã lưu" }];
  const storage = [500, { ok: false, err: "Không ghi được vào bộ nhớ trong" }];
  if (pathname === "/api/wifi/portal") {
    const on = f.get("on");
    if (on !== "1" && on !== "0") return [400, { ok: false, err: "Tham số on phải là 1 (bật) hoặc 0 (tắt)" }];
    if (on === "1") {
      if (!wifi.portal) wifiPortalOpen("manual", now);
      else Object.assign(wifi, { portalReason: "manual", closeAt: now + WIFI_PORTAL_MANUAL_MS });
    } else if (wifi.portal) {
      wifiPortalClose();
      if (!wifi.up) wifi.holdAutoUntil = now + WIFI_PORTAL_MANUAL_MS;
    }
    return [200, { ok: true, portal: on === "1" }];
  }
  const ssid = f.get("ssid") ?? "";
  if (!ssid) return [400, { ok: false, err: "Thiếu tên mạng (ssid)" }];
  if (pathname === "/api/wifi/connect") {
    if (!wifiFind(ssid)) return notFound;
    wifiUserRequest(ssid, false);
    return [200, { ok: true }];
  }
  if (pathname === "/api/wifi/remove") {
    if (!wifiFind(ssid)) return notFound;
    if (WIFI_NVS_FAIL) return storage;
    wifiRemoveNet(ssid, now);
    return [200, { ok: true }];
  }
  // /api/wifi/add
  const pass = f.get("pass") ?? "";
  const connectNow = f.get("connect") === "1";
  if (!wifiValidSsid(ssid)) return [400, { ok: false, err: "Tên mạng phải dài từ 1 đến 32 byte" }];
  if (!wifiValidPass(pass)) {
    return [400, {
      ok: false,
      err: "Mật khẩu phải dài 8–63 ký tự hoặc đúng 64 ký tự hex (để trống nếu mạng không đặt mật khẩu)",
    }];
  }
  const net = wifiFind(ssid);
  const current = wifi.up && wifi.ssid === ssid;
  if (net && (current || connectNow || !wifi.up)) {
    // Đổi mật khẩu mạng ĐÃ LƯU mà sắp thử (mạng đang nối thì LUÔN thử, kể cả connect=0):
    // mật khẩu mới chờ riêng, chỉ thay mật khẩu cũ khi nối được.
    wifi.trial = { seq: ++wifi.trialSeq, ssid, pass };
    console.log(`[wifi] Doi mat khau mang "${ssid}" -> thu ngay, chi luu khi noi duoc`);
    wifiUserRequest(ssid, true);
    return [200, { ok: true, connecting: true }];
  }
  if (!net && wifiSaved.length >= WIFI_MAX_SAVED) {
    return [507, { ok: false, err: `Đã lưu đủ ${WIFI_MAX_SAVED} mạng, hãy xóa bớt một mạng rồi thêm lại` }];
  }
  if (WIFI_NVS_FAIL) return storage;
  if (net) Object.assign(net, { pass, last: "", lastAt: 0 });
  else wifiSaved.push({ ssid, pass, last: "", lastAt: 0 });
  if (wifi.trial?.ssid === ssid) wifi.trial = null;
  const start = connectNow || !wifi.up;
  console.log(`[wifi] ${net ? "Da cap nhat mat khau" : "Da them"} mang "${ssid}" (tong ${wifiSaved.length})${start ? " -> thu noi ngay" : ""}`);
  if (start) wifiUserRequest(ssid, true);
  return [200, { ok: true, connecting: start }];
}

/** Đọc thân form x-www-form-urlencoded (tối đa 4 KB; quá thì null) */
function readForm(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size <= 4096) chunks.push(c);
    });
    req.on("end", () => resolve(size > 4096 ? null : new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", () => resolve(null));
  });
}

/** Nhịp của WifiMgr::loop() giả lập: AP tự bật/tắt, chu trình tự nối khi chưa có mạng */
setInterval(() => {
  const now = Date.now();
  wifiCost(120, 480);
  if (!wifi.up && !wifi.portal && wifi.downSince && now - wifi.downSince >= WIFI_PORTAL_AFTER_MS &&
      now >= wifi.holdAutoUntil) {
    wifiPortalOpen("auto", now);
  }
  if (wifi.portal && wifi.closeAt && now >= wifi.closeAt && wifi.up) wifiPortalClose();
  if (!wifi.up && !wifi.timer && !wifi.settleTimer && now >= wifi.nextBgAt && !wifiPaused(now)) {
    wifi.nextBgAt = now + WIFI_CYCLE_GAP_MS;
    const cands = wifiSaved.filter((n) => wifiAir(n.ssid)).sort((a, b) => wifiAir(b.ssid).rssi - wifiAir(a.ssid).rssi);
    if (cands.length > 0) wifiStart(cands[wifi.bgIndex++ % cands.length].ssid, "cand");
  }
}, 250);
// Lượt quét đầu tiên sau khởi động, để trang /wifi có ngay danh sách.
wifiScanNow();

const WIFI_PORTAL_HTML =
  "<!doctype html><meta charset=\"utf-8\"><title>Cấu hình Wi-Fi (giả lập)</title>" +
  "<h2>Trang cấu hình Wi-Fi (giả lập)</h2>" +
  "<p>Bộ giả lập coi như có điện thoại đang dùng trang cấu hình qua Wi-Fi cấu hình: nếu AP đang " +
  "<b>tự bật</b> (mất mạng quá 25 giây), thiết bị tạm dừng tự nối mạng trong 30 giây " +
  "(<code>paused=true</code>).</p><p>Trang cấu hình thật nằm trong firmware " +
  "(<code>src/net/wifi_portal_page.h</code>).</p>";

const WIFI_POST_PATHS = new Set(["/api/wifi/add", "/api/wifi/remove", "/api/wifi/connect", "/api/wifi/portal"]);

function statusJson() {
  const countdown =
    state === "NGHI_NGO_TE_NGA"
      ? Math.max(0, Math.ceil((CONFIRM_WINDOW_S * 1000 - (Date.now() - suspectStart)) / 1000))
      : 0;
  const stateVi = {
    KHONG_NGUOI: "Không có người",
    CO_NGUOI: "Có người – bình thường",
    NGHI_NGO_TE_NGA: "NGHI NGỜ TÉ NGÃ – đang chờ phản hồi",
    KHAN_CAP: "KHẨN CẤP – đã gửi cảnh báo",
  }[state];

  return {
    state,
    stateVi,
    countdown,
    cooldown: Math.max(0, Math.round((cooldownUntil - Date.now()) / 1000)),
    stateAge: Math.round((Date.now() - stateSince) / 1000),
    latencyMs,
    simulate: true,
    confirmWin: CONFIRM_WINDOW_S,
    voice: Date.now() < voiceUntil,
    radar: {
      online: true,
      present,
      movement: present ? (state === "KHAN_CAP" ? 1 : 2) : 0,
      range: present ? 25 + Math.round(Math.random() * 35) : 0,
      distance: present ? 120 + Math.round(Math.random() * 160) : 0,
      fall: fallFlag,
      static: state === "KHAN_CAP",
      falls: stats.suspects,
      errors: 0,
      health: "GIA LAP (khong co radar that)",
      ageMs: 120,
    },
    mode: {
      code: mode,
      vi: {
        TE_NGA: "Phát hiện té ngã",
        GIAC_NGU: "Theo dõi giấc ngủ",
        DANG_DOI_CHE_DO: "Đang đổi chế độ (tạm không phát hiện té ngã)",
      }[mode],
      sinceS: Math.round((Date.now() - modeSince) / 1000),
      switches: modeSwitches,
      blindMs,
      enabled: SLEEP_MODE_ON,
    },
    vitals: vitalsJson(),
    remote: {
      enabled: true,
      presses: rfPresses,
      rejected: rfRejected,
      lastCode: rfLastCode,
    },
    config: {
      installHeightCm: INSTALL_HEIGHT_CM,
      sensitivity: SENSITIVITY,
      fallTimeS: FALL_CONFIRM_S,
      unmannedTimeS: 3,
      confirmWindowS: CONFIRM_WINDOW_S,
      cooldownS: FALL_COOLDOWN_S,
      queryIntervalMs: 150,
      sleepModeOn: SLEEP_MODE_ON,
      sleepFromHour: 22,
      sleepToHour: 6,
      hrAlertMin: 40,
      hrAlertMax: 130,
    },
    wifi: wifiStatusJson(),
    telegram: {
      ...telegram,
      channels: ZALO_CHATS > 0 ? "Telegram, Zalo" : "Telegram",
      poller: Date.now() < leaseUntil ? "dashboard" : "device",
    },
    zalo: {
      poller: ZALO_CHATS > 0 ? (Date.now() < zaloLeaseUntil ? "dashboard" : "device") : "off",
      chats: ZALO_CHATS,
      last: "OK",
    },
    say: { pending: false },
    stats,
    device: {
      name: "Bà Nguyễn Thị A (giả lập)",
      place: "Phòng ngủ tầng 1",
      uptimeS: Math.floor((Date.now() - bootAt) / 1000),
      heap: 210000,
      psram: 8000000,
      clients: 0,
      epoch: nowS(),
      clock: new Date().toLocaleString("vi-VN"),
    },
  };
}

function handleAction(name) {
  switch (name) {
    case "simfall":
      if (Date.now() < cooldownUntil) {
        // Giống firmware: báo ngã trong thời gian nghỉ thì chỉ ghi log rồi bỏ qua
        log(
          "FALL_SUSPECT",
          "Nghi ngờ té ngã",
          "RADAR",
          `bo qua, con ${Math.round((cooldownUntil - Date.now()) / 1000)}s nghi`,
        );
      } else {
        // Giong radar that: cu nga xay ra ngay, nhung mo-dun chi BAO sau khi
        // xac nhan lien tuc FALL_CONFIRM_S giay.
        fallAt = Date.now();
        console.log(`[sim] cu nga xay ra, se bao sau ${FALL_CONFIRM_S}s`);
        setTimeout(() => {
          if (Date.now() >= cooldownUntil) enterSuspect("RADAR");
        }, FALL_CONFIRM_S * 1000);
      }
      return true;
    case "iamok":
      confirmSafe("WEB");
      return true;
    case "sos":
      stats.sos++;
      suspectStart = Date.now();
      log("SOS", "Bấm nút SOS", "WEB", "nut SOS");
      raiseEmergency("WEB", "tu nut SOS");
      return true;
    case "present_on":
      present = true;
      log("TEST", "Thao tác thử nghiệm", "WEB", "mo phong co nguoi");
      return true;
    case "present_off":
      present = false;
      log("TEST", "Thao tác thử nghiệm", "WEB", "mo phong khong nguoi");
      return true;
    case "testvoice":
      voiceUntil = Date.now() + 2200;
      log("TEST", "Thao tác thử nghiệm", "WEB", "thu loa");
      return true;
    case "testtg":
      telegram.sent++;
      telegram.last = "OK";
      log("TEST", "Thao tác thử nghiệm", "WEB", "gui tin thu");
      return true;
    case "testzalo":
      if (ZALO_CHATS <= 0) {
        log("TEST", "Thao tác thử nghiệm", "WEB", "kenh Zalo chua bat");
        return true;
      }
      telegram.sent++;
      telegram.last = "Zalo: OK";
      log("TEST", "Thao tác thử nghiệm", "WEB", "gui tin thu Zalo");
      return true;
    case "simsleep":
      doSwitchMode("GIAC_NGU");
      return true;
    case "simfall_mode":
      doSwitchMode("TE_NGA");
      return true;
    case "simremote":
      rfPresses++;
      rfLastCode = 5592332;
      stats.sos++;
      suspectStart = Date.now();
      log("SOS_REMOTE", "Bấm nút SOS đeo tay", "REMOTE", "nut SOS deo tay");
      raiseEmergency("REMOTE", "tu nut deo tay");
      return true;
    case "clearlog":
      events.length = 0;
      log("TEST", "Thao tác thử nghiệm", "WEB", "da xoa nhat ky");
      return true;
    default:
      return false;
  }
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const send = (code, body, type = "application/json") => {
    res.writeHead(code, { "Content-Type": `${type}; charset=utf-8` });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };

  // SIM_WIFI_DROP=1: thiết bị chưa vào mạng thì dashboard không với tới (trừ trang cấu hình "trên AP").
  if (WIFI_DROP && !wifi.up && url.pathname !== "/wifi") {
    req.socket.destroy();
    return;
  }

  // ------------------------------------------------------------ Wi-Fi v2 ---
  if (url.pathname === "/api/wifi/state") return send(200, wifiStateJson());
  if (url.pathname === "/api/wifi/scan") return send(200, wifiScanJson(url.searchParams.get("fresh") === "1"));
  if (url.pathname === "/api/wifi/list") return send(200, wifiListJson());
  if (WIFI_POST_PATHS.has(url.pathname) && req.method === "POST") {
    // Giống firmware: chỉ xét header CÓ MẶT (chống form tự submit từ trang lạ).
    if (req.headers["x-oalpha"] === undefined) {
      req.resume();
      console.log(`[wifi] Tu choi ${url.pathname}: thieu header X-OALPHA`);
      return send(403, { ok: false, err: "Thiếu header X-OALPHA (chống giả mạo yêu cầu từ trang lạ)" });
    }
    void readForm(req).then((form) => {
      if (!form) return send(413, { ok: false, err: "Dữ liệu gửi lên quá lớn" });
      const [code, body] = wifiCommand(url.pathname, form);
      send(code, body);
    });
    return;
  }
  if (url.pathname === "/wifi") {
    if (wifi.portal) wifi.portalHitAt = Date.now();
    return send(200, WIFI_PORTAL_HTML, "text/html");
  }

  if (url.pathname === "/api/status") {
    const tg = Number(url.searchParams.get("tg") ?? 0);
    if (tg > 0) {
      if (Date.now() >= leaseUntil) console.log("[tg] Dashboard nhan quyen doc tin Telegram");
      leaseUntil = Date.now() + Math.min(120, Math.max(5, tg)) * 1000;
    }
    const zl = Number(url.searchParams.get("zl") ?? 0);
    if (zl > 0 && ZALO_CHATS > 0) {
      if (Date.now() >= zaloLeaseUntil) console.log("[zl] Dashboard nhan quyen doc tin Zalo");
      zaloLeaseUntil = Date.now() + Math.min(120, Math.max(5, zl)) * 1000;
    }
    return send(200, statusJson());
  }
  if (url.pathname === "/api/say" && req.method === "POST") {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size <= SAY_MAX_BYTES) chunks.push(c); });
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const from = url.searchParams.get("from") ?? "";
      if (size === 0 || size > SAY_MAX_BYTES) return send(413, { ok: false, err: "file qua lon" });
      if (body.toString("ascii", 0, 4) !== "RIFF" || body.toString("ascii", 8, 12) !== "WAVE") {
        return send(415, { ok: false, err: "khong phai WAV" });
      }
      if (state === "NGHI_NGO_TE_NGA" || state === "KHAN_CAP") return send(423, { ok: false, err: "dang canh bao" });
      if (Date.now() < voiceUntil) return send(409, { ok: false, err: "loa dang ban" });
      mkdirSync(SAY_DIR, { recursive: true });
      lastSayFile = join(SAY_DIR, `loi-nhan-${++sayCount}.wav`);
      writeFileSync(lastSayFile, body);
      const rate = body.readUInt32LE(24) || 16000;
      const seconds = Math.max(0, body.length - 44) / (rate * 2);
      voiceUntil = Date.now() + seconds * 1000;
      log("MESSAGE", "Loa đọc lời nhắn người nhà", "WEB", from ? `tu ${from.slice(0, 40)}` : "loi nhan nguoi nha");
      console.log(`[loa] ${seconds.toFixed(1)}s, ${body.length} byte -> ${lastSayFile}`);
      return send(202, { ok: true });
    });
    return;
  }
  if (url.pathname === "/api/features") {
    const since = Number(url.searchParams.get("since") ?? 0);
    const picked = features.filter((f) => f[0] > since).slice(0, 150);
    return send(200, {
      now: deviceMs(),
      total: featureTotal,
      spec: 1,
      window: WINDOW,
      periodMs: FEATURE_PERIOD_MS,
      samples: picked,
    });
  }
  if (url.pathname === "/api/events") return send(200, [...events].reverse());
  if (url.pathname === "/api/action") {
    // Giong firmware sau khi va CSRF: chi POST + bat buoc header X-OALPHA.
    if (req.method !== "POST") { req.resume(); return send(405, { ok: false, err: "chi chap nhan POST" }); }
    if (req.headers["x-oalpha"] === undefined) {
      req.resume();
      console.log("[action] Tu choi: thieu header X-OALPHA");
      return send(403, { ok: false, err: "Thieu header X-OALPHA (chong gia mao yeu cau tu trang la)" });
    }
    req.resume();
    const ok = handleAction(url.searchParams.get("name") ?? "");
    return send(ok ? 200 : 400, { ok });
  }
  if (url.pathname === "/") {
    return send(
      200,
      "<h2>Bộ giả lập firmware ESP32</h2><p>Trỏ dashboard tới địa chỉ này trong trang Cài đặt.</p>",
      "text/html",
    );
  }
  return send(404, { error: "khong tim thay" });
}).listen(PORT, () => {
  log("BOOT", "Khởi động hệ thống", "SYSTEM", "che do gia lap");
  console.log(`\nBộ giả lập ESP32 đang chạy: http://localhost:${PORT}`);
  console.log(`Vào trang Cài đặt của dashboard và nhập: localhost:${PORT}`);
  console.log(`Wi-Fi giả lập: mật khẩu "${WIFI_WRONG_PASS}" = sai mật khẩu; SSID ngoài danh sách quét = không thấy mạng\n`);
});
