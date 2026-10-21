/**
 * Biến dữ liệu radar + nhật ký firmware thành bức tranh DỄ HIỂU cho người nhà.
 *
 * Mức độ (bình thường / chú ý / khẩn cấp) do CODE tính từ máy trạng thái của
 * firmware, không để AI quyết: AI chỉ diễn đạt lại, nên dù AI có viết sai thì
 * thẻ trạng thái trên trang và câu đầu trả lời Telegram vẫn luôn đúng.
 *
 * Giờ giấc tính theo giờ Việt Nam (UTC+7, không đổi giờ mùa).
 */
import { ensurePoller, pollerSnapshot } from "./poller";
import { getEvents, getInteractions, getSettings } from "./store";
import type { Interaction, Settings, StoredEvent } from "./types";

const VN_OFFSET_MS = 7 * 3600 * 1000;
const DAY_MS = 86_400_000;

export function startOfTodayVN(now = Date.now()): number {
  return Math.floor((now + VN_OFFSET_MS) / DAY_MS) * DAY_MS - VN_OFFSET_MS;
}

/** "08:05" theo giờ Việt Nam */
export function timeVN(ms: number): string {
  const d = new Date(ms + VN_OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** "Hôm nay", "Hôm qua" hoặc "Thứ ba, 20/10" */
export function dayLabelVN(ms: number, now = Date.now()): string {
  const day = startOfTodayVN(ms);
  const today = startOfTodayVN(now);
  if (day === today) return "Hôm nay";
  if (day === today - DAY_MS) return "Hôm qua";
  const d = new Date(ms + VN_OFFSET_MS);
  const wd = ["Chủ nhật", "Thứ hai", "Thứ ba", "Thứ tư", "Thứ năm", "Thứ sáu", "Thứ bảy"][d.getUTCDay()];
  return `${wd}, ${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
}

export function agoText(ms: number | null, now = Date.now()): string {
  if (!ms) return "chưa rõ";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "vừa xong";
  if (s < 3600) return `${Math.round(s / 60)} phút trước`;
  if (s < DAY_MS / 1000) return `${Math.floor(s / 3600)} giờ ${Math.round((s % 3600) / 60)} phút trước`;
  return `${Math.floor(s / 86400)} ngày trước`;
}

const cap = (s: string) => (s ? s[0].toLocaleUpperCase("vi") + s.slice(1) : s);

/** Cách gọi người được chăm sóc: theo Cài đặt, không có thì đoán từ tên trên thiết bị. */
export function elderCallOf(settings: Settings, deviceName?: string | null): string {
  const set = settings.elderCall?.trim();
  if (set) return set.toLocaleLowerCase("vi");
  const n = (deviceName ?? "").trim().toLocaleLowerCase("vi");
  if (/^(bà|ba)\s/.test(n)) return "bà";
  if (/^(ông|ong)\s/.test(n)) return "ông";
  if (/^(mẹ|me)\s/.test(n)) return "mẹ";
  if (/^(bố|bo|ba)\s/.test(n)) return "bố";
  return "người thân";
}

// ------------------------------------------------- sự kiện bằng lời thường ---

export type Tone = "ok" | "info" | "warn" | "bad" | "muted";
export type FriendlyEvent = {
  key: string;
  at: number;
  time: string;
  icon: string;
  text: string;
  tone: Tone;
  type: string;
};

function secondsIn(note: string, re: RegExp): string | null {
  const m = re.exec(note);
  return m ? m[1].replace(".", ",") : null;
}

/** Trả null với sự kiện thuần kỹ thuật (người nhà không cần thấy). */
export function friendlyEvent(e: StoredEvent, call: string): FriendlyEvent | null {
  const C = cap(call);
  const note = e.note ?? "";
  // icon la MOT KHOA (xem components/Icon.tsx), khong phai emoji nua.
  let icon = "dot";
  let text = "";
  let tone: Tone = "info";
  switch (e.type) {
    case "PRESENCE_IN": icon = "door"; text = `${C} vào phòng`; tone = "ok"; break;
    case "PRESENCE_OUT": icon = "leave"; text = `${C} ra khỏi phòng`; tone = "muted"; break;
    case "FALL_SUSPECT":
      if (e.state !== "NGHI_NGO_TE_NGA") return null; // radar báo lặp trong thời gian nghỉ
      icon = "warning"; text = `Nghi ngờ ${call} bị ngã, loa đã hỏi thăm`; tone = "warn"; break;
    case "CANCELLED": {
      const s = secondsIn(note, /phan hoi sau\s+([\d.]+)s/i);
      icon = "ok"; text = `${C} bấm “Tôi ổn”${s ? ` sau ${s} giây` : ""}`; tone = "ok"; break;
    }
    case "SOS": icon = "sos"; text = `${C} bấm nút SOS`; tone = "bad"; break;
    case "SOS_REMOTE": icon = "sos"; text = `${C} bấm nút SOS đeo tay`; tone = "bad"; break;
    case "EMERGENCY": icon = "emergency"; text = "Đã phát cảnh báo khẩn cấp cho người nhà"; tone = "bad"; break;
    case "TELEGRAM_OK": {
      const s = secondsIn(note, /tong\s+([\d.]+)s/i);
      icon = "msg-sent"; text = `Tin báo đã tới người nhà${s ? ` (${s} giây sau sự cố)` : ""}`; tone = "info"; break;
    }
    case "TELEGRAM_FAIL": icon = "msg-fail"; text = "Gửi tin báo cho người nhà bị lỗi"; tone = "warn"; break;
    case "RECOVERED": icon = "ok"; text = `Đã xác nhận ${call} an toàn`; tone = "ok"; break;
    case "VITALS_ALERT": icon = "vitals"; text = "Nhịp tim/nhịp thở ước lượng bất thường"; tone = "warn"; break;
    case "RADAR_ERROR": icon = "radar"; text = "Cảm biến radar gặp lỗi"; tone = "warn"; break;
    case "WIFI_DOWN": icon = "wifi"; text = "Thiết bị mất Wi-Fi"; tone = "warn"; break;
    case "BOOT": icon = "reboot"; text = "Thiết bị khởi động lại"; tone = "muted"; break;
    case "MODE_SWITCH": icon = "moon"; text = "Radar đổi chế độ (theo dõi giấc ngủ / phát hiện ngã)"; tone = "muted"; break;
    case "MESSAGE": {
      if (/^bo qua|^ngat/i.test(note)) {
        icon = "speaker-off"; text = "Lời nhắn chưa được đọc vì loa đang dùng cho cảnh báo"; tone = "muted";
      } else {
        const from = /^tu\s+(.+)$/i.exec(note)?.[1];
        icon = "speaker"; text = from ? `Loa đã đọc lời nhắn của ${from}` : "Loa đã đọc lời nhắn của người nhà"; tone = "info";
      }
      break;
    }
    default:
      return null; // WIFI_UP, TEST...
  }
  return { key: e.key, at: e.recvAt, time: timeVN(e.recvAt), icon, text, tone, type: e.type };
}

// ------------------------------------------------------------ tổng quan ---

export type Level = "binh-thuong" | "chu-y" | "khan-cap" | "khong-ro";

export type Overview = {
  online: boolean;
  error: string | null;
  updatedAt: number;
  name: string;
  place: string;
  call: string;
  state: string;
  level: Level;
  headline: string;
  detail: string;
  countdown: number;
  simulate: boolean;
  /** dang-van-dong | nghi-ngoi | vang-mat | khong-ro */
  activity: string;
  /** Mức vận động 5 phút gần nhất, 0..100 (null nếu chưa có dữ liệu) */
  activityLevel: number | null;
  lastSeenAt: number | null;
  today: {
    roomVisits: number;
    suspects: number;
    emergencies: number;
    sos: number;
    okPresses: number;
    messages: number;
    firstSeenAt: number | null;
  };
  timeline: FriendlyEvent[];
  vitals: { heartRate: number; breatheValue: number; sleepState: string; inBed: boolean } | null;
  recentMessages: Interaction[];
  device: { radarOk: boolean; wifiOk: boolean; telegramPoller: string | null };
};

const SLEEP = ["ngủ sâu", "ngủ nông", "tỉnh", "không có người"];

export async function getOverview(): Promise<Overview> {
  await ensurePoller();
  const snap = pollerSnapshot();
  const [settings, events, messages] = await Promise.all([getSettings(), getEvents(), getInteractions(50)]);
  const st = snap.status;
  const now = Date.now();
  const call = elderCallOf(settings, st?.device.name);
  const C = cap(call);
  const today0 = startOfTodayVN(now);
  const todayEvents = events.filter((e) => e.recvAt >= today0);

  // Lần cuối thấy người: chuỗi hiện diện (15 phút gần nhất) rồi tới nhật ký vào/ra
  const lastPresent = [...snap.series].reverse().find((p) => p.present === 1)?.t ?? null;
  const lastIn = [...events].reverse().find((e) => e.type === "PRESENCE_IN" || e.type === "PRESENCE_OUT");
  const lastSeenAt = st?.radar.present ? now : (lastPresent ?? lastIn?.recvAt ?? null);

  const recent = snap.series.filter((p) => p.t >= now - 5 * 60_000);
  const activityLevel = recent.length
    ? Math.round(recent.reduce((a, p) => a + p.range, 0) / recent.length)
    : null;

  let level: Level = "khong-ro";
  let headline = "Chưa liên lạc được với thiết bị trong phòng";
  let detail = snap.error ?? "Dashboard đang chờ dữ liệu đầu tiên từ ESP32.";
  let activity = "khong-ro";
  const online = snap.online && st !== null;

  if (online && st) {
    const moving = st.radar.movement === 2;
    activity = st.radar.present ? (moving ? "dang-van-dong" : "nghi-ngoi") : "vang-mat";
    switch (st.state) {
      case "KHAN_CAP": {
        level = "khan-cap";
        // Firmware ghi lý do vào ghi chú của sự kiện EMERGENCY: "tu nut SOS",
        // "tu nut deo tay" hoặc "het 30s khong phan hoi"
        const em = [...events].reverse().find((e) => e.type === "EMERGENCY");
        const bySos = /nut sos|deo tay/i.test(em?.note ?? "");
        headline = bySos
          ? `KHẨN CẤP: ${call} vừa bấm nút SOS cầu cứu`
          : `KHẨN CẤP: ${call} có thể đã ngã và chưa phản hồi`;
        detail = `Hệ thống đã gửi cảnh báo${em ? ` lúc ${timeVN(em.recvAt)}` : ""}. Hãy gọi điện hoặc tới kiểm tra ngay.`;
        break;
      }
      case "NGHI_NGO_TE_NGA":
        level = "chu-y";
        headline = `Nghi ngờ ${call} vừa bị ngã`;
        detail = `Loa đang hỏi thăm, còn ${st.countdown} giây để ${call} bấm “Tôi ổn”. Hết giờ hệ thống sẽ tự báo người nhà.`;
        break;
      case "CO_NGUOI":
        level = "binh-thuong";
        headline = moving ? `${C} đang đi lại trong phòng` : `${C} đang nghỉ ngơi trong phòng`;
        detail = st.radar.static
          ? `${C} nằm hoặc ngồi yên một chỗ khá lâu, có thể đang ngủ. Mọi thứ bình thường.`
          : "Mọi thứ bình thường.";
        break;
      case "KHONG_NGUOI":
        level = "binh-thuong";
        headline = `${C} đang không ở trong phòng`;
        detail = lastSeenAt ? `Lần cuối thấy ${call} trong phòng lúc ${timeVN(lastSeenAt)}.` : "Radar chưa thấy ai trong phòng.";
        break;
      default:
        headline = "Thiết bị đang khởi động";
        detail = "Đang kết nối với cảm biến radar.";
    }
    if (!st.radar.online && level === "binh-thuong") {
      level = "chu-y";
      headline = "Cảm biến radar mất liên lạc";
      detail = "Thiết bị vẫn chạy nhưng không đọc được radar, lúc này chưa phát hiện được té ngã.";
    }
  }

  const count = (t: string) => todayEvents.filter((e) => e.type === t).length;
  const vit = st?.vitals;
  return {
    online,
    error: snap.error,
    updatedAt: snap.lastOkAt,
    name: st?.device.name ?? "Người được chăm sóc",
    place: st?.device.place ?? "",
    call,
    state: st?.state ?? "KHONG_RO",
    level,
    headline,
    detail,
    countdown: st?.countdown ?? 0,
    simulate: Boolean(st?.simulate),
    activity,
    activityLevel,
    lastSeenAt,
    today: {
      roomVisits: count("PRESENCE_IN"),
      suspects: todayEvents.filter((e) => e.type === "FALL_SUSPECT" && e.state === "NGHI_NGO_TE_NGA").length,
      emergencies: count("EMERGENCY"),
      sos: count("SOS") + count("SOS_REMOTE"),
      okPresses: count("CANCELLED"),
      messages: messages.filter((m) => m.at >= today0 && m.kind === "hoitham").length,
      firstSeenAt: todayEvents.find((e) => e.type === "PRESENCE_IN")?.recvAt ?? null,
    },
    timeline: todayEvents
      .map((e) => friendlyEvent(e, call))
      .filter((x): x is FriendlyEvent => x !== null)
      .reverse()
      .slice(0, 40),
    vitals:
      vit?.valid && (vit.heartRate > 0 || vit.breatheValue > 0)
        ? {
            heartRate: vit.heartRate,
            breatheValue: vit.breatheValue,
            sleepState: SLEEP[vit.sleepState] ?? "chưa rõ",
            inBed: Boolean(vit.inBed),
          }
        : null,
    recentMessages: messages.filter((m) => m.kind === "hoitham").slice(0, 5),
    device: {
      radarOk: Boolean(st?.radar.online),
      wifiOk: Boolean(st?.wifi.up),
      telegramPoller: st?.telegram.poller ?? null,
    },
  };
}

const LEVEL_VI: Record<Level, string> = {
  "binh-thuong": "BÌNH THƯỜNG",
  "chu-y": "CẦN CHÚ Ý",
  "khan-cap": "KHẨN CẤP",
  "khong-ro": "CHƯA RÕ (mất liên lạc thiết bị)",
};

/** Tóm tắt không cần AI — dùng khi chưa có GROQ_API_KEY hoặc Groq lỗi. */
export function ruleSummary(o: Overview): string {
  const C = cap(o.call);
  const parts: string[] = [`${o.headline}.`];
  if (o.detail) parts.push(o.detail);
  const t = o.today;
  if (t.suspects === 0 && t.emergencies === 0 && t.sos === 0) {
    parts.push("Hôm nay chưa có lần nào nghi ngã hay báo động.");
  } else {
    const bits = [];
    if (t.suspects) bits.push(`${t.suspects} lần nghi ngã`);
    if (t.okPresses) bits.push(`${t.okPresses} lần ${o.call} bấm “Tôi ổn”`);
    if (t.emergencies) bits.push(`${t.emergencies} lần cảnh báo khẩn cấp`);
    if (t.sos) bits.push(`${t.sos} lần bấm SOS`);
    parts.push(`Hôm nay có ${bits.join(", ")}.`);
  }
  if (o.vitals) {
    parts.push(
      `Nhịp tim ước lượng ${o.vitals.heartRate} nhịp/phút, nhịp thở ${o.vitals.breatheValue} lần/phút (${o.vitals.sleepState}).`,
    );
  }
  if (!o.online) parts.push(`Chưa biết ${o.call} hiện ra sao vì thiết bị mất liên lạc; nên gọi điện hỏi thăm.`);
  else if (o.level === "binh-thuong" && o.activity === "vang-mat") parts.push(`${C} có thể đang ở phòng khác.`);
  return parts.join(" ");
}

/** Bản dữ kiện gọn đưa cho AI đọc (không có tên thật, chỉ cách xưng hô). */
export function overviewBrief(o: Overview): string {
  const now = Date.now();
  const L: string[] = [];
  L.push(`Thời điểm: ${timeVN(now)} ${dayLabelVN(now).toLowerCase()} (giờ Việt Nam)`);
  L.push(`Người được chăm sóc: gọi là "${o.call}", phòng: ${o.place || "không rõ"}`);
  L.push(`Mức độ do hệ thống xác định: ${LEVEL_VI[o.level]}`);
  L.push(`Tình trạng: ${o.headline}. ${o.detail}`);
  if (o.online) {
    const act = { "dang-van-dong": "đang đi lại", "nghi-ngoi": "đang nằm/ngồi yên", "vang-mat": "không có trong phòng", "khong-ro": "chưa rõ" }[o.activity];
    const lv = o.activityLevel;
    const word = lv === null ? "chưa có số liệu" : lv < 8 ? "rất ít" : lv < 25 ? "ít" : lv < 50 ? "vừa phải" : "nhiều";
    // Chỉ đưa lời (không đưa con số) để AI khỏi đọc số kỹ thuật cho người nhà
    L.push(`Hoạt động lúc này: ${act}; mức vận động 5 phút qua: ${word}`);
  }
  L.push(`Lần cuối thấy trong phòng: ${o.lastSeenAt ? `${timeVN(o.lastSeenAt)} (${agoText(o.lastSeenAt, now)})` : "chưa rõ"}`);
  const t = o.today;
  const visits =
    t.roomVisits === 0 && o.activity !== "vang-mat" && o.online
      ? "chưa ghi nhận lượt vào phòng mới (đã ở trong phòng từ trước)"
      : `vào phòng ${t.roomVisits} lần`;
  L.push(
    `Hôm nay: ${visits}; nghi ngã ${t.suspects}; bấm "Tôi ổn" ${t.okPresses}; cảnh báo khẩn cấp ${t.emergencies}; bấm SOS ${t.sos}; lời nhắn qua loa ${t.messages}`,
  );
  if (o.vitals) {
    L.push(
      `Sinh hiệu ước lượng bằng radar (không phải thiết bị y tế): nhịp tim ${o.vitals.heartRate}/phút, nhịp thở ${o.vitals.breatheValue}/phút, ${o.vitals.sleepState}, ${o.vitals.inBed ? "trên giường" : "ngoài giường"}`,
    );
  } else {
    L.push("Sinh hiệu: không đo (chế độ theo dõi giấc ngủ đang tắt hoặc chưa đo được)");
  }
  if (o.timeline.length) {
    L.push(`Sự kiện GẦN NHẤT: ${o.timeline[0].time} ${o.timeline[0].text}`);
    L.push("Diễn biến hôm nay, MỚI NHẤT ĐỨNG ĐẦU (sự kiện ở dưới xảy ra TRƯỚC, đã xong):");
    for (const e of o.timeline.slice(0, 15)) L.push(`- ${e.time} ${e.text}`);
  }
  if (o.simulate) L.push("LƯU Ý: thiết bị đang chạy chế độ MÔ PHỎNG, số liệu không phải người thật.");
  return L.join("\n");
}
