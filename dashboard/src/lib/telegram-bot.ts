/**
 * Bot Telegram chạy trong máy chủ dashboard (long polling getUpdates).
 *
 * MỘT BOT, HAI NƠI ĐỌC TIN: firmware ESP32 cũng biết đọc tin Telegram để vẫn trả
 * lời được khi laptop tắt. Telegram không cho hai bên cùng gọi getUpdates (tin
 * có thể bị trả lời hai lần), nên làm theo kiểu "thuê quyền":
 *   1. Bot muốn đọc -> poller gửi GET /api/status?tg=<giây> cho ESP32.
 *   2. ESP32 ngừng đọc, báo telegram.poller = "dashboard".
 *   3. Chỉ khi thấy "dashboard" (hoặc ESP32 tắt hẳn) bot mới gọi getUpdates.
 *   4. Laptop tắt -> hết hạn thuê -> ESP32 tự đọc lại như cũ.
 *
 * BẢO MẬT: chỉ trả lời các chat trong danh sách cho phép (TELEGRAM_CHAT_ID +
 * TELEGRAM_ALLOWED_CHAT_IDS). Không có danh sách thì người lạ biết tên bot là có
 * thể làm loa trong phòng người già nói hoặc hỏi được tình hình sức khỏe.
 */
import { handleFamilyMessage, logSkipped, parseCommand } from "./family-bot";
import { timeVN } from "./health";
import { pollerSnapshot } from "./poller";
import { getSettings, getTelegramState, saveTelegramState } from "./store";
import type { TelegramBotInfo } from "./types";

const API_BASE = (process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, "");
/** Tin tới trễ hơn mức này (máy chủ vừa bật lại) thì không xử lý nữa */
const STALE_S = 10 * 60;

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
  refusedAt: Map<string, number>;
  commandsSet: boolean;
  /** Số lần liên tiếp Telegram báo 409 (nơi khác cũng đọc tin) */
  conflicts?: number;
};

const g = globalThis as typeof globalThis & {
  __tgBot?: Runtime;
  __tgWantsLease?: () => boolean;
};

function rt(): Runtime {
  g.__tgBot ??= {
    started: false, state: "off", detail: "", botName: null, lastUpdateAt: 0, lastOkAt: 0,
    handled: 0, errorStreak: 0, holdUntil: 0, conflictUntil: 0, refusedAt: new Map(), commandsSet: false,
  };
  return g.__tgBot;
}

function config() {
  const token = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  // TELEGRAM_CHAT_ID cũng có thể là danh sách cách nhau dấu phẩy, giống secrets.h của firmware
  const allowed = [...(process.env.TELEGRAM_CHAT_ID ?? "").split(","), ...(process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "").split(",")]
    .map((s) => s.trim())
    .filter(Boolean);
  return { token, allowed: [...new Set(allowed)], disabled: process.env.TELEGRAM_BOT_DISABLED === "1" };
}

let enabledCache = true;

/** Poller hỏi hàm này mỗi nhịp để biết có xin ESP32 nhường quyền đọc tin không. */
function wantsLease(): boolean {
  const c = config();
  const r = rt();
  // Đang lỗi token / lỗi mạng thì KHÔNG giữ quyền, để ESP32 tự trả lời người nhà
  return (
    Boolean(c.token) && !c.disabled && enabledCache &&
    r.state !== "loi-token" && r.state !== "loi-mang" && Date.now() >= r.holdUntil
  );
}
g.__tgWantsLease = wantsLease;

type TgResult<T> = { ok: boolean; status: number; result?: T; description?: string };

async function tg<T>(method: string, body: unknown, timeoutMs = 15_000): Promise<TgResult<T>> {
  const { token } = config();
  try {
    const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => ({}))) as TgResult<T>;
    return { ...json, ok: Boolean(json.ok), status: res.status };
  } catch (err) {
    return { ok: false, status: 0, description: err instanceof Error ? err.message : String(err) };
  }
}

type TgMessage = {
  message_id: number;
  date: number;
  text?: string;
  chat: { id: number; type: string; title?: string };
  from?: { first_name?: string; last_name?: string; is_bot?: boolean };
};
type TgUpdate = { update_id: number; message?: TgMessage };

/** Telegram giới hạn 4096 ký tự một tin */
async function send(chatId: string, text: string, replyTo?: number): Promise<void> {
  const r = await tg("sendMessage", {
    chat_id: chatId,
    text: text.slice(0, 4000),
    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
  });
  if (!r.ok) console.warn("[telegram] Gui tin loi:", r.status, r.description);
}

async function handleUpdate(u: TgUpdate): Promise<void> {
  const m = u.message;
  if (!m || m.from?.is_bot) return;
  const chatId = String(m.chat.id);
  const from = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ").trim() || "Người nhà";
  const text = (m.text ?? "").trim();
  const r = rt();
  r.lastUpdateAt = Date.now();

  if (!config().allowed.includes(chatId)) {
    // Người lạ: trả lời tối đa 1 lần / 10 phút để không thành vòng spam
    const last = r.refusedAt.get(chatId) ?? 0;
    if (Date.now() - last > 10 * 60_000) {
      r.refusedAt.set(chatId, Date.now());
      await send(chatId, `Xin lỗi, bot này chỉ phục vụ gia đình đã đăng ký.\nNếu anh/chị là người nhà, hãy gửi mã chat ${chatId} cho người quản lý thiết bị để được thêm vào danh sách.`);
    }
    await logSkipped({ channel: "telegram", kind: "tu-choi", from, chatId, text: text.slice(0, 200), reply: "từ chối (chat chưa được phép)", spokenText: null, speak: null, ai: false });
    return;
  }
  if (!text) {
    await send(chatId, "Em mới đọc được tin chữ thôi ạ. Anh/chị gõ câu hỏi hoặc /hoitham <lời nhắn> nhé.", m.message_id);
    return;
  }
  const ageS = Date.now() / 1000 - m.date;
  if (ageS > STALE_S) {
    const isSpeak = parseCommand(text).cmd === "hoitham";
    const reply = `⌛ Tin lúc ${timeVN(m.date * 1000)} tới khi máy chủ đang tắt nên em chưa xử lý${isSpeak ? " (lời nhắn không đọc ra loa nữa)" : ""}. Anh/chị gửi lại giúp em nhé.`;
    await send(chatId, reply, m.message_id);
    await logSkipped({ channel: "telegram", kind: isSpeak ? "hoitham" : "hoi", from, chatId, text, reply, spokenText: null, speak: isSpeak ? "qua-cu" : null, ai: false });
    return;
  }

  void tg("sendChatAction", { chat_id: chatId, action: "typing" });
  try {
    const out = await handleFamilyMessage({ channel: "telegram", from, chatId, text });
    await send(chatId, out.reply, m.message_id);
    r.handled++;
  } catch (err) {
    console.error("[telegram] Xu ly tin loi:", err);
    await send(chatId, "Xin lỗi, em đang gặp lỗi khi xử lý. Anh/chị thử lại sau ít phút nhé.", m.message_id);
  }
}

async function setupBot(): Promise<boolean> {
  const r = rt();
  const me = await tg<{ username?: string; first_name?: string }>("getMe", {});
  if (!me.ok) {
    if (me.status === 401 || me.status === 404) {
      r.state = "loi-token";
      r.detail = "Telegram từ chối token (sai hoặc đã thu hồi). Kiểm tra TELEGRAM_BOT_TOKEN.";
    } else {
      r.state = "loi-mang";
      r.detail = `Không gọi được Telegram: ${me.description ?? me.status}`;
    }
    return false;
  }
  r.botName = me.result?.username ? `@${me.result.username}` : (me.result?.first_name ?? null);
  if (!r.commandsSet) {
    await tg("setMyCommands", {
      commands: [
        { command: "hoitham", description: "Nhắn lời để loa trong phòng đọc" },
        { command: "tinhhinh", description: "Tình hình ngay lúc này" },
        { command: "homnay", description: "Tóm tắt cả ngày" },
        { command: "hoi", description: "Hỏi trợ lý (dùng trong nhóm)" },
        { command: "help", description: "Hướng dẫn" },
      ],
    });
    // Bot đang có webhook thì getUpdates bị từ chối -> gỡ webhook (giữ tin chờ)
    await tg("deleteWebhook", { drop_pending_updates: false });
    r.commandsSet = true;
  }
  await saveTelegramState({ botName: r.botName });
  return true;
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function loop(): Promise<void> {
  const r = rt();
  let ready = false;
  for (;;) {
    const c = config();
    const settings = await getSettings();
    enabledCache = settings.telegramEnabled !== false;
    if (!c.token || c.disabled || !enabledCache) {
      r.state = "off";
      r.detail = !c.token ? "Chưa khai TELEGRAM_BOT_TOKEN trong dashboard/.env.local" : "Đang tắt trong Cài đặt";
      ready = false;
      await sleep(5000);
      continue;
    }
    if (Date.now() < r.holdUntil) { await sleep(2000); continue; }
    if (!ready) {
      ready = await setupBot();
      if (!ready) { await sleep(r.state === "loi-token" ? 60_000 : 15_000); continue; }
    }

    // Chỉ đọc tin khi ESP32 đã nhường quyền (hoặc ESP32 đang tắt hẳn). Phải chờ
    // poller hỏi xong lượt đầu: chưa biết ESP32 có đang tự đọc tin hay không.
    const snap = pollerSnapshot();
    if (snap.ticks === 0) {
      r.state = "cho-thiet-bi";
      r.detail = "Đang hỏi trạng thái ESP32…";
      await sleep(1000);
      continue;
    }
    const poller = snap.status?.telegram?.poller;
    if (snap.online && poller === undefined) {
      r.state = "firmware-cu";
      r.detail = "Firmware trên ESP32 chưa hỗ trợ nhường quyền đọc tin. Nạp firmware mới để dashboard trả lời Telegram.";
      await sleep(5000);
      continue;
    }
    if (snap.online && poller === "device") {
      r.state = "cho-thiet-bi";
      r.detail = "Đang chờ ESP32 nhường quyền đọc tin Telegram…";
      await sleep(1500);
      continue;
    }
    if (Date.now() < r.conflictUntil) { await sleep(1000); continue; }

    const st = await getTelegramState();
    const res = await tg<TgUpdate[]>(
      "getUpdates",
      { offset: st.offset || undefined, timeout: 25, allowed_updates: ["message"] },
      35_000,
    );
    if (!res.ok) {
      if (res.status === 409) {
        // Nơi khác (ESP32 không liên lạc được từ đây, hoặc dashboard thứ hai) đang
        // đọc tin: lùi hẳn ra để không trả lời trùng; xung đột lặp lại thì lùi lâu hơn.
        r.conflicts = (r.conflicts ?? 0) + 1;
        r.state = "xung-dot";
        r.detail = "Có nơi khác cũng đang đọc tin của bot (ESP32 firmware cũ hoặc sai địa chỉ ESP32, hoặc một dashboard khác). Dashboard tạm nhường.";
        r.conflictUntil = Date.now() + (r.conflicts >= 2 ? 5 * 60_000 : 60_000);
      } else if (res.status === 401 || res.status === 404) {
        r.state = "loi-token";
        r.detail = "Telegram từ chối token (sai hoặc đã thu hồi).";
        ready = false;
      } else {
        r.errorStreak++;
        r.state = "loi-mang";
        r.detail = `Lỗi gọi Telegram: ${res.description ?? res.status}`;
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
    r.detail = "Dashboard đang trả lời tin nhắn Telegram.";
    for (const u of res.result ?? []) {
      await saveTelegramState({ offset: u.update_id + 1 });
      try {
        await handleUpdate(u);
      } catch (err) {
        console.error("[telegram] Loi update", u.update_id, err);
      }
    }
  }
}

/** Bật bot một lần duy nhất cho cả tiến trình (gọi nhiều lần cũng không sao). */
export function ensureTelegramBot(): void {
  const r = rt();
  if (r.started) return;
  r.started = true;
  void loop().catch((err) => {
    console.error("[telegram] Vong lap dung:", err);
    r.started = false;
  });
  console.log("[telegram] Da bat bot Telegram cua dashboard");
}

export function telegramBotInfo(): TelegramBotInfo {
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
