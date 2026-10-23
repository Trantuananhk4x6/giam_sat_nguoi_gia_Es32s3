/**
 * Lưu / xóa mạng Wi-Fi trên thiết bị (đi qua máy chủ Next.js vì firmware không có CORS):
 *   - POST   { ssid, pass, connect } -> lưu; connect=true thì chuyển sang mạng này ngay.
 *            connect=false khi thiết bị đang có mạng: chỉ lưu. Riêng mạng ĐANG NỐI (đổi
 *            mật khẩu) firmware luôn thử ngay, sai thì giữ mật khẩu cũ (rolledBack).
 *   - DELETE { ssid }                -> xóa mạng đã lưu (hoặc ?ssid=...).
 * Cả hai chỉ nhận JSON gửi từ chính trang dashboard (lib/same-origin.ts), khác -> 403.
 * Lỗi firmware (400 sai dữ liệu, 404 không có mạng, 500 không ghi được bộ nhớ — chưa đổi
 * gì, 507 đầy) được chuyển tiếp đúng mã kèm câu tiếng Việt của firmware; lỗi mạng / quá
 * giờ -> 502.
 */
import { NextResponse } from "next/server";
import { errorReply, wifiAdd, wifiRemove } from "@/lib/esp32";
import { rejectCrossSite } from "@/lib/same-origin";
import { getSettings } from "@/lib/store";
import { passError, ssidError } from "@/lib/wifi-types";

export const dynamic = "force-dynamic";

type Body = Record<string, unknown> | null;

export async function POST(req: Request) {
  const denied = rejectCrossSite(req);
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as Body;
  // Không cắt khoảng trắng: SSID lấy từ danh sách quét phải gửi đúng nguyên văn.
  const ssid = typeof body?.ssid === "string" ? body.ssid : "";
  const pass = typeof body?.pass === "string" ? body.pass : "";
  const connect = body?.connect === undefined ? true : body.connect === true || body.connect === 1;

  const bad = ssidError(ssid) ?? passError(pass);
  if (bad) return NextResponse.json({ ok: false, error: bad }, { status: 400 });

  const { esp32Host: host } = await getSettings();
  try {
    const r = await wifiAdd(host, ssid, pass, connect);
    return NextResponse.json({ ok: true, connecting: r.connecting });
  } catch (err) {
    const e = errorReply(err, host);
    return NextResponse.json({ ok: false, error: e.error }, { status: e.status });
  }
}

export async function DELETE(req: Request) {
  const denied = rejectCrossSite(req);
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as Body;
  const ssid =
    typeof body?.ssid === "string" ? body.ssid : (new URL(req.url).searchParams.get("ssid") ?? "");

  const bad = ssidError(ssid);
  if (bad) return NextResponse.json({ ok: false, error: bad }, { status: 400 });

  const { esp32Host: host } = await getSettings();
  try {
    await wifiRemove(host, ssid);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const e = errorReply(err, host);
    return NextResponse.json({ ok: false, error: e.error }, { status: e.status });
  }
}
