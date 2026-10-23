/**
 * POST /api/wifi/portal   body: { on: boolean }
 * Bật / tắt Wi-Fi cấu hình (AP) của thiết bị — ví dụ bật tay để trình diễn cách
 * cấu hình bằng điện thoại khi thiết bị vẫn đang có mạng.
 * Chỉ nhận JSON gửi từ chính trang dashboard (lib/same-origin.ts), khác -> 403.
 */
import { NextResponse } from "next/server";
import { errorReply, wifiPortal } from "@/lib/esp32";
import { rejectCrossSite } from "@/lib/same-origin";
import { getSettings } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const denied = rejectCrossSite(req);
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const on = body?.on;
  if (typeof on !== "boolean" && on !== 0 && on !== 1) {
    return NextResponse.json({ ok: false, error: "Thiếu tham số on (true/false)." }, { status: 400 });
  }

  const { esp32Host: host } = await getSettings();
  try {
    const r = await wifiPortal(host, on === true || on === 1);
    return NextResponse.json({ ok: true, portal: r.portal });
  } catch (err) {
    const e = errorReply(err, host);
    return NextResponse.json({ ok: false, error: e.error }, { status: e.status });
  }
}
