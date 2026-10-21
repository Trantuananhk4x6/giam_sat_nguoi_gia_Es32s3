/**
 * POST /api/action   body: { name: "iamok" | "sos" | "simfall" | ... }
 * Chuyển tiếp thao tác sang firmware ESP32 rồi hỏi lại trạng thái ngay để giao
 * diện cập nhật tức thì, không phải chờ hết chu kỳ.
 */
import { NextResponse } from "next/server";
import { friendlyError, sendAction } from "@/lib/esp32";
import { pollNow } from "@/lib/poller";
import { getSettings } from "@/lib/store";

export const dynamic = "force-dynamic";

const ALLOWED = new Set([
  "iamok",
  "sos",
  "simfall",
  "present_on",
  "present_off",
  "testvoice",
  "testtg",
  "clearlog",
]);

export async function POST(req: Request) {
  let name = "";
  try {
    const body = (await req.json()) as { name?: string };
    name = body.name ?? "";
  } catch {
    name = new URL(req.url).searchParams.get("name") ?? "";
  }

  if (!ALLOWED.has(name)) {
    return NextResponse.json({ ok: false, error: `Thao tác không hợp lệ: "${name}"` }, { status: 400 });
  }

  const settings = await getSettings();
  try {
    await sendAction(settings.esp32Host, name);
    await pollNow();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: friendlyError(err, settings.esp32Host) },
      { status: 502 },
    );
  }
}
