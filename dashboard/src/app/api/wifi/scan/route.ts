/**
 * GET /api/wifi/scan[?fresh=1]
 * Các mạng Wi-Fi quanh thiết bị: { scanning, age, nets }. Firmware không chặn khi
 * quét — trả ngay kết quả gần nhất kèm cờ scanning, trang /wifi hỏi lại mỗi ~1,2 s
 * cho tới khi scanning=false. fresh=1 yêu cầu quét lại.
 * Trình duyệt không gọi thẳng ESP32 (firmware không có CORS) nên phải đi qua đây.
 */
import { NextResponse } from "next/server";
import { errorReply, wifiScan } from "@/lib/esp32";
import { getSettings } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const fresh = new URL(req.url).searchParams.get("fresh") === "1";
  const { esp32Host: host } = await getSettings();
  try {
    return NextResponse.json(await wifiScan(host, fresh));
  } catch (err) {
    const e = errorReply(err, host);
    return NextResponse.json({ ok: false, error: e.error }, { status: e.status });
  }
}
