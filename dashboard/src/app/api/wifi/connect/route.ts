/**
 * POST /api/wifi/connect   body: { ssid }
 * Chuyển thiết bị sang một mạng ĐÃ LƯU ngay lập tức. Nếu nối không được, firmware
 * tự quay về mạng cũ. Kết quả xem ở GET /api/wifi/state (attempt có id lớn hơn).
 * 404 từ firmware = mạng chưa được lưu.
 * Chỉ nhận JSON gửi từ chính trang dashboard (lib/same-origin.ts), khác -> 403.
 */
import { NextResponse } from "next/server";
import { errorReply, wifiConnect } from "@/lib/esp32";
import { rejectCrossSite } from "@/lib/same-origin";
import { getSettings } from "@/lib/store";
import { ssidError } from "@/lib/wifi-types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const denied = rejectCrossSite(req);
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const ssid = typeof body?.ssid === "string" ? body.ssid : "";

  const bad = ssidError(ssid);
  if (bad) return NextResponse.json({ ok: false, error: bad }, { status: 400 });

  const { esp32Host: host } = await getSettings();
  try {
    await wifiConnect(host, ssid);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const e = errorReply(err, host);
    return NextResponse.json({ ok: false, error: e.error }, { status: e.status });
  }
}
