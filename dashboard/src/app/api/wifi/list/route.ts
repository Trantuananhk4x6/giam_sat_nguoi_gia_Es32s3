/**
 * GET /api/wifi/list
 * Danh sách mạng Wi-Fi đã lưu trong firmware (không kèm mật khẩu). Proxy qua máy
 * chủ Next.js để tránh CORS khi gọi sang ESP32.
 */
import { NextResponse } from "next/server";
import { friendlyError, wifiList } from "@/lib/esp32";
import { getSettings } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const settings = await getSettings();
  try {
    const saved = await wifiList(settings.esp32Host);
    return NextResponse.json(saved);
  } catch (err) {
    return NextResponse.json(
      { error: friendlyError(err, settings.esp32Host) },
      { status: 502 },
    );
  }
}
