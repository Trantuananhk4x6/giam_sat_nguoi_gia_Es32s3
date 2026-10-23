/**
 * Bot Zalo chạy trong máy chủ dashboard (long polling getUpdates) — anh em sinh
 * đôi của lib/telegram-bot.ts, dùng chung "bộ não" lib/family-bot.ts nên người
 * nhà hỏi qua Zalo hay Telegram đều được trả lời như nhau (AI + /hoitham ra loa).
 *
 * MỘT BOT, HAI NƠI ĐỌC TIN (giống Telegram): firmware ESP32 cũng tự đọc tin Zalo
 * để vẫn trả lời được khi laptop tắt. Dashboard "thuê quyền" qua
 * GET /api/status?zl=<giây>, và chỉ gọi getUpdates khi ESP32 báo
 * zalo.poller = "dashboard" (hoặc firmware không tự đọc Zalo / ESP32 tắt hẳn).
 *
 * KHÁC TELEGRAM: Zalo không có offset — tin đã giao cho bên nào thì bên đó phải
 * trả lời, không "trả lại" được. Vì vậy firmware chỉ báo "dashboard" khi đã
 * thật sự ngừng chờ tin, và bot này không bao giờ bỏ một tin đã nhận.
 *
 * BẢO MẬT: chỉ trả lời các chat trong ZALO_CHAT_ID + ZALO_ALLOWED_CHAT_IDS.
 * Người lạ nhắn bot được báo mã chat của họ (tối đa 1 lần / 10 phút) để người
 * quản lý thêm vào nếu đúng là người nhà; không lộ gì về người cao tuổi.
 */
import { handleFamilyMessage, logSkipped, parseCommand } from "./family-bot";
import { timeVN } from "./health";
import { pollerSnapshot } from "./poller";
import { getSettings } from "./store";
import type { ZaloBotInfo } from "./types";
import { fitZalo, zaloApi, zaloErrorVi, zaloToken } from "./zalo";

/** Tin tới trễ hơn mức này (máy chủ vừa bật lại) thì không xử lý nữa */
const STALE_S = 10 * 60;
/** Mỗi lượt getUpdates, Zalo giữ kết nối chờ tin tối đa chừng này giây */
const POLL_TIMEOUT_S = 25;

type Runtime = {
  started: boolean;
  state: string;
  detail: string;
  botName: string | null;
  lastUpdateAt: number;
  lastOkAt: number;
  handled: number;
  errorStreak: number;
  holdUntil: number;
  conflictUntil: number;
  conflicts: number;
  refusedAt: Map<string, number>;
  webhookCleared: boolean;
  /** message_id vừa xử lý (phòng Zalo giao lại cùng một tin) */
  seen: string[];
};

const g = globalThis as typeof globalThis & {
  __zaloBot?: Runtime;
  __zaloWantsLease?: () => boolean;
};

function rt(): Runtime {
  g.__zaloBot ??= {
    started: false, state: "off", detail: "", botName: null, lastUpdateAt: 0, lastOkAt: 0, handled: 0,
    errorStreak: 0, holdUntil: 0, conflictUntil: 0, conflicts: 0, refusedAt: new Map(), webhookCleared: false, seen: [],
  };
  return g.__zaloBot;
}

function config() {
  const allowed = [...(process.env.ZALO_CHAT_ID ?? "").split(","), ...(process.env.ZALO_ALLOWED_CHAT_IDS ?? "").split(",")]
    .map((s) => s.trim())
    .filter(Boolean);
  return { token: zaloToken(), allowed: [...new Set(allowed)], disabled: process.env.ZALO_BOT_DISABLED === "1" };
}

let enabledCache = true;

/** Poller hỏi hàm này mỗi nhịp để biết có xin ESP32 nhường quyền đọc tin Zalo không. */
function wantsLease(): boolean {
  const c = config();
  const r = rt();
  // Vòng đọc tin chưa chạy, lỗi token / lỗi mạng: KHÔNG giữ quyền, để ESP32 tự trả lời người nhà
  return (
    r.started && Boolean(c.token) && !c.disabled && enabledCache &&
    r.state !== "loi-token" && r.state !== "loi-mang" && Date.now() >= r.holdUntil
  );
}
g.__zaloWantsLease = wantsLease;

type ZaloMessage = {
  message_id?: string;
  /** Zalo ghi bằng MILI giây */
  date?: number;
  text?: string;
  chat?: { id?: string | number; chat_type?: string };
  from?: { id?: string | number; display_name?: string; name?: string; is_bot?: boolean };
};
type ZaloUpdate = { event_name?: string; message?: ZaloMessage };

async function send(chatId: string, text: string): Promise<void> {
  const r = await zaloApi("sendMessage", { chat_id: chatId, text: fitZalo(text) });
  if (!r.ok) console.warn("[zalo] Gui tin loi:", r.code, r.description);
}

/** Mốc thời gian của Zalo là mili giây; phòng khi API trả giây. */
function toMs(d: unknown): number {
  const n = Number(d);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n;
}

async function handleUpdate(u: ZaloUpdate): Promise<void> {
  const m = u.message;
  if (!m || m.from?.is_bot) return;
  const chatId = String(m.chat?.id ?? m.from?.id ?? "").trim();
  if (!chatId) return;
  const r = rt();
  if (m.message_id) {
    if (r.seen.includes(m.message_id)) return;
    r.seen.push(m.message_id);
    if (r.seen.length > 100) r.seen.splice(0, r.seen.length - 100);
  }
  const from = (m.from?.display_name ?? m.from?.name ?? "").trim() || "Người nhà";
  const text = (m.text ?? "").trim();
  r.lastUpdateAt = Date.now();

  if (!config().allowed.includes(chatId)) {
    // Người lạ: trả lời tối đa 1 lần / 10 phút để không thành vòng spam
    const last = r.refusedAt.get(chatId) ?? 0;
    if (Date.now() - last > 10 * 60_000) {
      r.refusedAt.set(chatId, Date.now());
      await send(
        chatId,
        `Xin lỗi, bot này chỉ phục vụ gia đình đã đăng ký.\nMã chat Zalo của anh/chị là: ${chatId}\nNếu anh/chị là người nhà, hãy gửi mã này cho người quản lý thiết bị để được thêm vào danh sách.`,
      );
    }
    await logSkipped({ channel: "zalo", kind: "tu-choi", from, chatId, text: text.slice(0, 200), reply: "từ chối (chat chưa được phép)", spokenText: null, speak: null, ai: false });
    return;
  }
  // Ảnh, nhãn dán, hoặc tin Zalo không cho bot đọc nội dung (message.unsupported.received)
  if (u.event_name !== "message.text.received" || !text) {
    await send(chatId, "Em mới đọc được tin nhắn chữ thôi ạ. Anh/chị gõ câu hỏi hoặc /hoitham <lời nhắn> nhé.");
    return;
  }
  const sentAt = toMs(m.date);
  if (sentAt && (Date.now() - sentAt) / 1000 > STALE_S) {
    const isSpeak = parseCommand(text).cmd === "hoitham";
    const reply = `⌛ Tin lúc ${timeVN(sentAt)} tới khi máy chủ đang tắt nên em chưa xử lý${isSpeak ? " (lời nhắn không đọc ra loa nữa)" : ""}. Anh/chị gửi lại giúp em nhé.`;
    await send(chatId, reply);
    await logSkipped({ channel: "zalo", kind: isSpeak ? "hoitham" : "hoi", from, chatId, text, reply, spokenText: null, speak: isSpeak ? "qua-cu" : null, ai: false });
    return;
  }

  void zaloApi("sendChatAction", { chat_id: chatId, action: "typing" }, 5000);
  try {
    const out = await handleFamilyMessage({ channel: "zalo", from, chatId, text });
    await send(chatId, out.reply);
    r.handled++;
  } catch (err) {
    console.error("[zalo] Xu ly tin loi:", err);
    await send(chatId, "Xin lỗi, em đang gặp lỗi khi xử lý. Anh/chị thử lại sau ít phút nhé.");
  }
}

async function setupBot(): Promise<boolean> {
  const r = rt();
  const me = await zaloApi<{ id?: string; account_name?: string; display_name?: string; name?: string }>("getMe", {});
  if (!me.ok) {
    if (me.code === 401 || me.code === 403 || me.code === 404) {
      r.state = "loi-token";
      r.detail = "Zalo từ chối token (sai hoặc đã thu hồi). Kiểm tra ZALO_BOT_TOKEN.";
    } else {
      r.state = "loi-mang";
      r.detail = zaloErrorVi(me.code, me.description);
    }
    return false;
  }
  const info = me.result ?? {};
  r.botName = info.display_name || info.account_name || info.name || null;
  if (!r.webhookCleared) {
    // getUpdates không chạy khi bot đang đặt webhook -> gỡ webhook. Bot chưa từng
    // đặt webhook thì Zalo có thể báo lỗi: bỏ qua.
    await zaloApi("deleteWebhook", {});
    r.webhookCleared = true;
  }
  return true;
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function loop(): Promise<void> {
  const r = rt();
  let ready = false;
  for (;;) {
    const c = config();
    const settings = await getSettings();
    enabledCache = settings.zaloEnabled !== false;
    if (!c.token || c.disabled || !enabledCache) {
      r.state = "off";
      r.detail = !c.token ? "Chưa khai ZALO_BOT_TOKEN trong dashboard/.env.local" : "Đang tắt trong Cài đặt";
      ready = false;
      await sleep(5000);
      continue;
    }
    if (Date.now() < r.holdUntil) { await sleep(2000); continue; }
    if (!ready) {
      ready = await setupBot();
      if (!ready) { await sleep(r.state === "loi-token" ? 60_000 : 15_000); continue; }
    }

    // Chỉ đọc tin khi ESP32 đã nhường quyền. Firmware cũ (chưa có Zalo Bot, không
    // có trường zalo) không tự đọc tin Zalo nên dashboard đọc luôn; ESP32 tắt hẳn cũng vậy.
    const snap = pollerSnapshot();
    if (snap.ticks === 0) {
      r.state = "cho-thiet-bi";
      r.detail = "Đang hỏi trạng thái ESP32…";
      await sleep(1000);
      continue;
    }
    if (snap.online && snap.status?.zalo?.poller === "device") {
      r.state = "cho-thiet-bi";
      r.detail = "Đang chờ ESP32 nhường quyền đọc tin Zalo…";
      await sleep(1000);
      continue;
    }
    if (Date.now() < r.conflictUntil) { await sleep(1000); continue; }

    const res = await zaloApi<ZaloUpdate | ZaloUpdate[]>(
      "getUpdates",
      { timeout: String(POLL_TIMEOUT_S) },
      (POLL_TIMEOUT_S + 10) * 1000,
    );
    if (!res.ok && res.code !== 408) {
      if (res.code === 401 || res.code === 403 || res.code === 404) {
        r.state = "loi-token";
        r.detail = "Zalo từ chối token (sai hoặc đã thu hồi).";
        ready = false;
      } else if (res.code === 409) {
        // Bot đang đặt webhook, hoặc một dashboard khác cũng đang chờ tin
        r.conflicts++;
        r.state = "xung-dot";
        r.detail = "Zalo báo xung đột: bot đang đặt webhook hoặc có nơi khác cũng đang đọc tin. Dashboard tạm nhường.";
        r.conflictUntil = Date.now() + (r.conflicts >= 2 ? 5 * 60_000 : 30_000);
        r.webhookCleared = false; // lần kết nối lại sẽ gỡ webhook thêm lần nữa
        ready = false;
      } else {
        r.errorStreak++;
        r.state = "loi-mang";
        r.detail = `Lỗi gọi Zalo: ${zaloErrorVi(res.code, res.description)}`;
        // Lỗi liên tục thì trả quyền đọc tin cho ESP32 một lúc
        if (r.errorStreak >= 3) { r.holdUntil = Date.now() + 60_000; r.errorStreak = 0; }
        await sleep(3000);
      }
      continue;
    }
    r.errorStreak = 0;
    r.conflicts = 0;
    r.lastOkAt = Date.now();
    r.state = "dang-doc";
    r.detail = "Dashboard đang trả lời tin nhắn Zalo.";
    if (!res.ok) continue; // 408: hết lượt chờ, không có tin mới

    // Zalo trả MỘT tin mỗi lượt; vẫn nhận mảng phòng khi API đổi giống Telegram
    const list = Array.isArray(res.result) ? res.result : res.result ? [res.result] : [];
    for (const u of list) {
      try {
        await handleUpdate(u);
      } catch (err) {
        console.error("[zalo] Loi xu ly tin:", err);
      }
    }
  }
}

/** Bật bot một lần duy nhất cho cả tiến trình (gọi nhiều lần cũng không sao). */
export function ensureZaloBot(): void {
  const r = rt();
  if (r.started) return;
  r.started = true;
  void loop().catch((err) => {
    console.error("[zalo] Vong lap dung:", err);
    r.started = false;
  });
  if (zaloToken()) console.log("[zalo] Da bat bot Zalo cua dashboard");
}

export function zaloBotInfo(): ZaloBotInfo {
  const c = config();
  const r = rt();
  return {
    configured: Boolean(c.token),
    enabled: !c.disabled && enabledCache,
    state: r.state,
    detail: r.detail,
    botName: r.botName,
    allowedChats: c.allowed,
    lastUpdateAt: r.lastUpdateAt,
    handled: r.handled,
  };
}
