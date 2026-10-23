/**
 * Lá chắn CSRF tập trung cho mọi route GHI dưới /api.
 *
 * Dashboard không có đăng nhập và Next.js lắng nghe trên mọi giao diện mạng, nên
 * một trang web lạ đang mở trong trình duyệt ở cùng máy / cùng LAN có thể tự gửi
 * yêu cầu tới dashboard (CSRF) để bắn lệnh xuống thiết bị, bắt loa trong phòng
 * đọc chữ tùy ý, xóa nhật ký hay đổi cấu hình. Thay vì phải nhớ gọi
 * rejectCrossSite() trong từng route, chặn một chỗ tại đây: mọi method ghi
 * (POST/PUT/PATCH/DELETE) tới /api đều phải cùng nguồn (xem lib/same-origin.ts).
 *
 * Next.js 16 gọi tầng này là "proxy" (tên cũ là "middleware"); nó chạy ở Edge,
 * trước khi request đi vào route.
 *
 * NGOẠI LỆ: /api/assistant do CHÍNH ESP32 gọi (multipart/form-data, không phải
 * trình duyệt, không gửi Origin/Sec-Fetch và không dùng JSON) nên được bỏ qua.
 * Các method đọc (GET/HEAD/OPTIONS) không đổi trạng thái nên cũng cho qua.
 */
import { NextResponse, type NextRequest } from "next/server";
import { rejectCrossSite } from "@/lib/same-origin";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** Route do firmware ESP32 gọi trực tiếp, không áp quy tắc cùng nguồn của trình duyệt. */
const DEVICE_ROUTES = new Set(["/api/assistant"]);

export function proxy(req: NextRequest): NextResponse {
  if (SAFE_METHODS.has(req.method) || DEVICE_ROUTES.has(req.nextUrl.pathname)) {
    return NextResponse.next();
  }
  return rejectCrossSite(req) ?? NextResponse.next();
}

export const config = { matcher: "/api/:path*" };