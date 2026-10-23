/**
 * GET  /api/loi-nhan                 nhật ký tương tác (Telegram + Zalo + web) + trạng thái hai bot
 * POST /api/loi-nhan                 { from, text, preview? }
 *        preview = true : chỉ trả câu loa SẼ đọc (AI biên tập), chưa gửi xuống loa
 *        còn lại        : giống lệnh /hoitham trên Telegram / Zalo (đọc giọng -> ESP32)
 */
import { NextResponse } from "next/server";
import { handleFamilyMessage, speakerSentence } from "@/lib/family-bot";
import { getOverview } from "@/lib/health";
import { getInteractions } from "@/lib/store";
import { ensureTelegramBot, telegramBotInfo } from "@/lib/telegram-bot";
import { ensureZaloBot, zaloBotInfo } from "@/lib/zalo-bot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 90;

export async function GET() {
  ensureTelegramBot();
  ensureZaloBot();
  return NextResponse.json({ items: await getInteractions(300), bot: telegramBotInfo(), zalo: zaloBotInfo() });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { from?: string; text?: string; preview?: boolean } | null;
  const text = (body?.text ?? "").trim();
  const from = (body?.from ?? "").trim().slice(0, 40) || "Người nhà";
  if (!text) return NextResponse.json({ error: "Chưa nhập lời nhắn." }, { status: 400 });
  if (text.length > 500) return NextResponse.json({ error: "Lời nhắn dài quá (tối đa 500 ký tự)." }, { status: 400 });

  if (body?.preview) {
    const o = await getOverview();
    return NextResponse.json(await speakerSentence(from, text, o.call));
  }
  const out = await handleFamilyMessage({ channel: "web", from, chatId: null, text: `/hoitham ${text}` });
  return NextResponse.json(out);
}
