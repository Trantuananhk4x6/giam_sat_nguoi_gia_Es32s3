/**
 * Thêm / xóa mạng Wi-Fi đã lưu trên thiết bị. Gộp hai thao tác vào một route cho
 * gọn:
 *   - POST   { ssid, pass } -> lưu + yêu cầu firmware kết nối
 *   - DELETE { ssid }       -> xóa mạng đã lưu
 * Cả hai đều đi qua máy chủ Next.js (tránh CORS) và gọi hàm tương ứng ở esp32.ts.
 */
import { NextResponse } from "next/server";
import { friendlyError, wifiAdd, wifiRemove } from "@/lib/esp32";
import { getSettings } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let ssid = "";
  let pass = "";
  try {
    const body = (await req.json()) as { ssid?: string; pass?: string };
    ssid = (body.ssid ?? "").trim();
    pass = body.pass ?? "";
  } catch {
    ssid = "";
  }

  if (!ssid) {
    return NextResponse.json({ ok: false, error: "Thiếu tên mạng (SSID)." }, { status: 400 });
  }

  const settings = await getSettings();
  try {
    await wifiAdd(settings.esp32Host, ssid, pass);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: friendlyError(err, settings.esp32Host) },
      { status: 502 },
    );
  }
}

export async function DELETE(req: Request) {
  let ssid = "";
  try {
    const body = (await req.json()) as { ssid?: string };
    ssid = (body.ssid ?? "").trim();
  } catch {
    ssid = new URL(req.url).searchParams.get("ssid")?.trim() ?? "";
  }

  if (!ssid) {
    return NextResponse.json({ ok: false, error: "Thiếu tên mạng (SSID)." }, { status: 400 });
  }

  const settings = await getSettings();
  try {
    await wifiRemove(settings.esp32Host, ssid);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: friendlyError(err, settings.esp32Host) },
      { status: 502 },
    );
  }
}
