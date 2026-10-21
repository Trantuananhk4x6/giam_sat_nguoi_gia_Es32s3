/**
 * GET /api/wifi/scan
 * Quét các mạng Wi-Fi xung quanh thiết bị. Trình duyệt KHÔNG gọi thẳng IP ESP32
 * (firmware không gửi header CORS) nên phải đi qua máy chủ Next.js: lấy host từ
 * getSettings() rồi chuyển tiếp sang firmware.
 */
import { NextResponse } from "next/server";
import { friendlyError, wifiScan } from "@/lib/esp32";
import { getSettings } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const settings = await getSettings();
  try {
    const nets = await wifiScan(settings.esp32Host);
    return NextResponse.json(nets);
  } catch (err) {
    return NextResponse.json(
      { error: friendlyError(err, settings.esp32Host) },
      { status: 502 },
    );
  }
}
