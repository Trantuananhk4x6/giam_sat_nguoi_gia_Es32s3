/**
 * GET /api/wifi/state
 * Trạng thái Wi-Fi chi tiết của thiết bị: giai đoạn (đang quét / đang nối / chờ thử
 * lại…), lần thử kết nối gần nhất, Wi-Fi cấu hình (AP) và số mạng đã lưu.
 * Trang /wifi hỏi mỗi 1 s khi đang chờ kết quả kết nối, 4 s lúc bình thường.
 * Firmware cũ chưa có API này -> 404 được chuyển tiếp nguyên mã.
 */
import { NextResponse } from "next/server";
import { errorReply, wifiState } from "@/lib/esp32";
import { getSettings } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const { esp32Host: host } = await getSettings();
  try {
    return NextResponse.json(await wifiState(host));
  } catch (err) {
    const e = errorReply(err, host);
    return NextResponse.json({ ok: false, error: e.error }, { status: e.status });
  }
}
