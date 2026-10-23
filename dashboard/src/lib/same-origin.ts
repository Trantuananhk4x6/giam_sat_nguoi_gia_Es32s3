/**
 * Chặn giả mạo yêu cầu từ trang web khác (CSRF) cho các route GHI của dashboard.
 *
 * Dashboard không có đăng nhập và Next.js lắng nghe mọi giao diện mạng. Một trang lạ
 * đang mở trên máy trong LAN có thể gửi "simple request" (form tự submit, hoặc fetch
 * no-cors với Content-Type text/plain): trình duyệt không hỏi trước (preflight), route
 * vẫn chạy và chuyển tiếp lệnh xuống thiết bị kèm mật khẩu Basic của firmware.
 * Ba lớp chặn:
 *   1. Content-Type phải là application/json. Muốn gửi JSON thật sang origin khác thì
 *      trình duyệt phải preflight, mà dashboard không trả header CORS nên bị chặn ở đó.
 *   2. Sec-Fetch-Site (trình duyệt hiện đại luôn gửi, trang web không giả được) nếu có
 *      thì phải là "same-origin" hoặc "none" (người dùng tự gõ địa chỉ). "same-site" —
 *      ví dụ một cổng khác trên cùng máy — cũng bị chặn.
 *   3. Origin nếu có thì host (kèm cổng) phải trùng Host của yêu cầu.
 * Công cụ dòng lệnh (curl, Invoke-WebRequest) không gửi Sec-Fetch-Site/Origin nên chỉ
 * cần đặt Content-Type: application/json. Trang /wifi vốn gửi JSON cùng origin nên không
 * bị ảnh hưởng.
 *
 * Cách dùng trong route:  const denied = rejectCrossSite(req); if (denied) return denied;
 */
import { NextResponse } from "next/server";

/** null = cho qua; ngược lại là phản hồi 403 { ok: false, error } để route trả về ngay */
export function rejectCrossSite(req: Request): NextResponse | null {
  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") {
    return deny("Yêu cầu phải gửi dạng JSON (Content-Type: application/json).");
  }

  const site = req.headers.get("sec-fetch-site");
  if (site !== null) {
    const s = site.trim().toLowerCase();
    if (s !== "same-origin" && s !== "none") {
      return deny("Từ chối yêu cầu gửi từ trang web khác. Hãy thao tác ngay trên trang dashboard.");
    }
  }

  const origin = req.headers.get("origin");
  if (origin !== null && !sameHost(origin, req.headers.get("host") ?? "")) {
    return deny("Từ chối yêu cầu gửi từ trang web khác (Origin không khớp địa chỉ dashboard).");
  }
  return null;
}

/**
 * Host (kèm cổng) của Origin có trùng Host của yêu cầu không. Origin không phải URL
 * (ví dụ "null" của iframe sandbox hay file://) -> không trùng. Cổng mặc định được bỏ
 * ở cả hai phía theo scheme của Origin nên "localhost" và "localhost:80" là một.
 */
function sameHost(origin: string, host: string): boolean {
  if (!host.trim()) return false;
  try {
    const o = new URL(origin);
    const h = new URL(`${o.protocol}//${host.trim()}`);
    return o.host.toLowerCase() === h.host.toLowerCase();
  } catch {
    return false;
  }
}

function deny(error: string): NextResponse {
  return NextResponse.json({ ok: false, error }, { status: 403 });
}
