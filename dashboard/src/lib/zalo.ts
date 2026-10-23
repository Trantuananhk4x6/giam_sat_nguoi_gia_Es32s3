/**
 * Gọi Zalo Bot API — dùng chung cho bot hai chiều (lib/zalo-bot.ts) và việc gửi
 * lời nhắn cho người nhà (lib/notify.ts).
 *
 * Zalo Bot Platform (https://bot.zapps.me) là nền tảng bot CHÍNH THỨC của Zalo:
 * tạo bot ngay từ tài khoản Zalo cá nhân qua OA "Zalo Bot Manager", miễn phí,
 * không cần Zalo OA doanh nghiệp. API gần giống Telegram:
 *
 *   POST https://bot-api.zaloplatforms.com/bot<TOKEN>/<method>    (thân JSON)
 *
 * Khác Telegram:
 *   - chat_id là CHUỖI (ví dụ "3becaa50ae12474c1e03"), không phải số;
 *   - tin tối đa 2000 ký tự; không có setMyCommands, không trích dẫn tin;
 *   - getUpdates trả MỘT tin mỗi lần và không có offset (tin đã giao cho ai thì
 *     người đó phải xử lý); hết lượt chờ mà không có tin -> error_code 408;
 *   - getUpdates và webhook loại trừ nhau.
 *
 * Biến môi trường (dashboard/.env.local):
 *   ZALO_BOT_TOKEN   token bot (cùng bot với ZALO_BOT_TOKEN trong secrets.h)
 *   ZALO_API_BASE    chỉ dùng khi chạy thử với máy chủ giả
 */

/** Giới hạn độ dài một tin Zalo (đơn vị UTF-16, đúng như String.length của JS) */
export const ZALO_TEXT_MAX = 2000;

export function zaloToken(): string {
  return (process.env.ZALO_BOT_TOKEN ?? "").trim();
}

const apiBase = () => (process.env.ZALO_API_BASE || "https://bot-api.zaloplatforms.com").replace(/\/+$/, "");

export type ZaloResult<T> = {
  ok: boolean;
  /** HTTP status (0 = không kết nối được) */
  status: number;
  /** 200 khi thành công; nếu lỗi: error_code trong thân JSON, không có thì HTTP status */
  code: number;
  description: string;
  result?: T;
};

/** Lỗi mạng của fetch trong Node chỉ ghi "fetch failed"; lấy thêm mã lỗi gốc (ECONNREFUSED…). */
function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { cause?: { code?: string } } | null)?.cause?.code;
  return code ? `${msg}, ${code}` : msg;
}

/** Gọi một phương thức của Zalo Bot API. Không bao giờ ném lỗi. */
export async function zaloApi<T>(method: string, body: unknown, timeoutMs = 15_000): Promise<ZaloResult<T>> {
  try {
    const res = await fetch(`${apiBase()}/bot${zaloToken()}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      error_code?: number;
      description?: string;
    };
    const ok = res.ok && json.ok === true;
    // Zalo hay trả HTTP 200 kèm {"ok":false,"error_code":408}: ưu tiên mã trong thân
    const code = ok ? 200 : Number(json.error_code) || (res.status !== 200 ? res.status : 400);
    return { ok, status: res.status, code, description: String(json.description ?? ""), result: json.result };
  } catch (err) {
    return { ok: false, status: 0, code: 0, description: errText(err) };
  }
}

/** Câu tiếng Việt dễ hiểu cho một lỗi của Zalo. */
export function zaloErrorVi(code: number, desc: string): string {
  if (code === 0) return `Không kết nối được Zalo (${desc || "lỗi mạng"})`;
  if (code === 401 || code === 404) return "Zalo từ chối token của bot (sai hoặc đã bị thu hồi)";
  if (code === 403) return "Người nhận chưa nhắn cho bot Zalo lần nào, hoặc đã chặn bot";
  if (code === 400 && /chat|user|recipient/i.test(desc)) {
    return "Không tìm thấy chat Zalo: mã chat sai hoặc người nhận chưa nhắn cho bot";
  }
  if (code === 429) return "Zalo báo gửi nhanh quá, thử lại sau ít phút";
  return `Zalo báo lỗi ${code}${desc ? `: ${desc.slice(0, 120)}` : ""}`;
}

/** Cắt tin cho vừa giới hạn của Zalo (không cắt đôi cặp surrogate của emoji). */
export function fitZalo(text: string): string {
  if (text.length <= ZALO_TEXT_MAX) return text;
  let cut = ZALO_TEXT_MAX - 1;
  const c = text.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut--;
  return `${text.slice(0, cut)}…`;
}
