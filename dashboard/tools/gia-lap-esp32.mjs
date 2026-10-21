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
    wifi: { up: true, ssid: "GIA_LAP_WIFI", rssi: -52, ip: "127.0.0.1" },
    telegram: { ...telegram, channels: "Telegram", poller: Date.now() < leaseUntil ? "dashboard" : "device" },
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

  if (url.pathname === "/api/status") {
    const tg = Number(url.searchParams.get("tg") ?? 0);
    if (tg > 0) {
      if (Date.now() >= leaseUntil) console.log("[tg] Dashboard nhan quyen doc tin Telegram");
      leaseUntil = Date.now() + Math.min(120, Math.max(5, tg)) * 1000;
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
  console.log(`Vào trang Cài đặt của dashboard và nhập: localhost:${PORT}\n`);
});
