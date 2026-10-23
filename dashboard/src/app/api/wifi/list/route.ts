/**
 * GET /api/wifi/list
 * Mạng Wi-Fi đã lưu trong firmware (KHÔNG kèm mật khẩu), kèm mạng nào đang dùng,
 * sóng nếu thấy trong lần quét gần nhất và kết quả lần thử gần nhất.
 */
import { NextResponse } from "next/server";
import { errorReply, wifiList } from "@/lib/esp32";
import { getSettings } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const { esp32Host: host } = await getSettings();
  try {
    return NextResponse.json(await wifiList(host));
  } catch (err) {
    const e = errorReply(err, host);
    return NextResponse.json({ ok: false, error: e.error }, { status: e.status });
  }
}
