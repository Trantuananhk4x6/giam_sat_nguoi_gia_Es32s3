/**
 * GET  /api/settings    đọc cấu hình (địa chỉ ESP32, chu kỳ hỏi, xưng hô, giọng đọc, Telegram, Zalo, relayLabel)
 * POST /api/settings    lưu cấu hình; nếu đổi địa chỉ ESP32 thì thử kết nối ngay để báo kết quả
 */
import { NextResponse } from "next/server";
import { fetchStatus, friendlyError } from "@/lib/esp32";
import { notifyChannels } from "@/lib/notify";
import { pollNow, pollerSnapshot } from "@/lib/poller";
import { getSettings, saveSettings } from "@/lib/store";
import { telegramBotInfo } from "@/lib/telegram-bot";
import { VOICES } from "@/lib/tts";
import type { Settings } from "@/lib/types";
import { ensureZaloBot, zaloBotInfo } from "@/lib/zalo-bot";

export const dynamic = "force-dynamic";

export async function GET() {
  ensureZaloBot();
  // Firmware có gửi cảnh báo qua Zalo không (để trang Cài đặt nhắc khai secrets.h)
  const snap = pollerSnapshot();
  const fw = snap.status?.zalo;
  return NextResponse.json({
    ...(await getSettings()),
    bot: telegramBotInfo(),
    zalo: {
      ...zaloBotInfo(),
      firmwareOnline: snap.online,
      firmwareChats: fw?.chats ?? null,
      firmwarePoller: fw?.poller ?? null,
    },
    channels: notifyChannels(),
    voices: VOICES,
  });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Partial<Settings>;
  const patch: Partial<Settings> = {};

  if (typeof body.esp32Host === "string") {
    const host = body.esp32Host.trim();
    if (!host) return NextResponse.json({ error: "Chưa nhập địa chỉ ESP32" }, { status: 400 });
    patch.esp32Host = host;
  }
  if (Number.isFinite(body.pollMs)) patch.pollMs = Math.round(Number(body.pollMs));
  if (typeof body.elderCall === "string") patch.elderCall = body.elderCall.trim().slice(0, 20);
  if (typeof body.ttsVoice === "string" && body.ttsVoice in VOICES) patch.ttsVoice = body.ttsVoice;
  if (typeof body.telegramEnabled === "boolean") patch.telegramEnabled = body.telegramEnabled;
  if (typeof body.zaloEnabled === "boolean") patch.zaloEnabled = body.zaloEnabled;
  if (typeof body.relayLabel === "string") patch.relayLabel = body.relayLabel.trim().slice(0, 40) || "Người thân";

  const settings = await saveSettings(patch);
  if (patch.esp32Host === undefined && patch.pollMs === undefined) {
    return NextResponse.json({ ok: true, settings, message: "Đã lưu." });
  }

  // Thử kết nối ngay để người dùng biết địa chỉ vừa nhập có đúng không
  try {
    const status = await fetchStatus(settings.esp32Host);
    await pollNow();
    return NextResponse.json({
      ok: true,
      settings,
      message: `Đã kết nối được. Thiết bị: ${status.device.name} – ${status.device.place}`,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, settings, message: friendlyError(err, settings.esp32Host) });
  }
}
