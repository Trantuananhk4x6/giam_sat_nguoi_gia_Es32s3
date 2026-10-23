/**
 * Gửi tin cho NGƯỜI NHÀ qua Telegram, Zalo và email (Resend) — phía dashboard.
 *
 * Dùng cho tính năng người cao tuổi nói với thiết bị "gửi cho Tuấn là …" (xem
 * lib/relay.ts). Cảnh báo té ngã KHÔNG đi qua đây: chính firmware ESP32 gửi,
 * kể cả khi laptop tắt.
 *
 * Biến môi trường (dashboard/.env.local):
 *   TELEGRAM_BOT_TOKEN   cùng bot với firmware
 *   ZALO_BOT_TOKEN       cùng bot Zalo với firmware (xem lib/zalo.ts)
 *   RESEND_API_KEY       key Resend (re_...), giống secrets.h
 *   EMAIL_FROM           mặc định "OALPHA <onboarding@resend.dev>"
 *   TELEGRAM_API_BASE, ZALO_API_BASE, RESEND_API_BASE   chỉ dùng khi chạy thử với máy chủ giả
 *
 * Lỗi được dịch thành câu tiếng Việt dễ hiểu (hay gặp nhất: người nhận chưa bấm
 * Start / chưa nhắn cho bot, hoặc Resend chưa xác minh tên miền).
 */
import type { Delivery } from "./types";
import { fitZalo, zaloApi, zaloErrorVi, zaloToken } from "./zalo";

export const DEFAULT_EMAIL_FROM = "OALPHA <onboarding@resend.dev>";
const TIMEOUT_MS = 10_000;

const tgBase = () => (process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, "");
const resendBase = () => (process.env.RESEND_API_BASE || "https://api.resend.com").replace(/\/+$/, "");
const emailFrom = () => (process.env.EMAIL_FROM ?? "").trim() || DEFAULT_EMAIL_FROM;

/** Kênh nào dùng được (để trang Cài đặt báo thiếu khóa nào). Không trả về giá trị khóa. */
export function notifyChannels(): { telegram: boolean; zalo: boolean; email: boolean; emailFrom: string } {
  return {
    telegram: Boolean((process.env.TELEGRAM_BOT_TOKEN ?? "").trim()),
    zalo: Boolean(zaloToken()),
    email: Boolean((process.env.RESEND_API_KEY ?? "").trim()),
    emailFrom: emailFrom(),
  };
}

/** Lỗi mạng của fetch trong Node chỉ ghi "fetch failed"; lấy thêm mã lỗi gốc (ECONNREFUSED…). */
function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { cause?: { code?: string } } | null)?.cause?.code;
  return code ? `${msg}, ${code}` : msg;
}

function telegramError(status: number, desc: string): string {
  if (status === 401 || status === 404) return "Telegram từ chối token của bot (sai hoặc đã thu hồi)";
  if (status === 403) {
    return /blocked/i.test(desc)
      ? "Người nhận đã chặn bot"
      : "Người nhận chưa bấm Start với bot (bot không được nhắn trước)";
  }
  if (status === 400 && /chat not found/i.test(desc)) {
    return "Không tìm thấy chat: mã chat sai hoặc người nhận chưa bấm Start với bot";
  }
  if (status === 429) return "Telegram báo gửi nhanh quá, thử lại sau ít phút";
  return `Telegram báo lỗi ${status}${desc ? `: ${desc.slice(0, 120)}` : ""}`;
}

/** Gửi một tin chữ (không định dạng) tới một chat Telegram. Không bao giờ ném lỗi. */
export async function sendTelegramText(chatId: string, text: string): Promise<Delivery> {
  const base: Delivery = { channel: "telegram", target: chatId, ok: false, error: null, messageId: null };
  const token = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  if (!token) return { ...base, error: "Dashboard chưa khai TELEGRAM_BOT_TOKEN trong .env.local" };
  try {
    const res = await fetch(`${tgBase()}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Không đặt parse_mode: lời nhắn là chữ thường, khỏi lo ký tự đặc biệt
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      description?: string;
      result?: { message_id?: number };
    };
    if (res.ok && json.ok) return { ...base, ok: true, messageId: json.result?.message_id ?? null };
    return { ...base, error: telegramError(res.status, json.description ?? "") };
  } catch (err) {
    return { ...base, error: `Không kết nối được Telegram (${errText(err)})` };
  }
}

/** Gửi một tin chữ tới một chat Zalo (bot Zalo phải đã từng được người đó nhắn). Không bao giờ ném lỗi. */
export async function sendZaloText(chatId: string, text: string): Promise<Delivery> {
  const base: Delivery = { channel: "zalo", target: chatId, ok: false, error: null, messageId: null };
  if (!zaloToken()) return { ...base, error: "Dashboard chưa khai ZALO_BOT_TOKEN trong .env.local" };
  const r = await zaloApi<{ message_id?: string }>("sendMessage", { chat_id: chatId, text: fitZalo(text) }, TIMEOUT_MS);
  if (r.ok) return { ...base, ok: true, messageId: r.result?.message_id ?? null };
  return { ...base, error: zaloErrorVi(r.code, r.description) };
}

function resendError(status: number, msg: string): string {
  if (/own email address|verify a domain|testing emails/i.test(msg)) {
    return "Resend chỉ cho gửi tới đúng email đã đăng ký tài khoản khi chưa xác minh tên miền";
  }
  if (status === 401 || (status === 403 && /api key/i.test(msg))) return "Resend từ chối RESEND_API_KEY (sai hoặc đã thu hồi)";
  if (status === 403 && /domain/i.test(msg)) return "Địa chỉ gửi (EMAIL_FROM) thuộc tên miền chưa xác minh trên Resend";
  if (status === 422) return `Email không hợp lệ${msg ? `: ${msg.slice(0, 120)}` : ""}`;
  if (status === 429) return "Resend báo gửi nhanh quá hoặc hết hạn mức, thử lại sau";
  return `Resend báo lỗi ${status}${msg ? `: ${msg.slice(0, 120)}` : ""}`;
}

/** Gửi một email qua Resend. Không bao giờ ném lỗi. */
export async function sendEmail(to: string, subject: string, html: string, text: string): Promise<Delivery> {
  const base: Delivery = { channel: "email", target: to, ok: false, error: null };
  const key = (process.env.RESEND_API_KEY ?? "").trim();
  if (!key) return { ...base, error: "Dashboard chưa khai RESEND_API_KEY trong .env.local" };
  try {
    const res = await fetch(`${resendBase()}/emails`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ from: emailFrom(), to: [to], subject: subject.slice(0, 150), html, text }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return { ...base, ok: true };
    const body = await res.text().catch(() => "");
    let msg = body;
    try {
      msg = String((JSON.parse(body) as { message?: unknown }).message ?? body);
    } catch {
      /* thân không phải JSON */
    }
    return { ...base, error: resendError(res.status, msg) };
  } catch (err) {
    return { ...base, error: `Không kết nối được dịch vụ email (${errText(err)})` };
  }
}

/** Chặn chèn HTML khi đưa chữ người dùng nói vào email. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
