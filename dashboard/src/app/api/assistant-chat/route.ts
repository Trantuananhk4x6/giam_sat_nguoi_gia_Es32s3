/**
 * POST /api/assistant-chat
 *
 * Khung chat "Hỏi thăm sức khỏe" trên web: người nhà hỏi, trợ lý trả lời DỰA
 * TRÊN DỮ LIỆU RADAR (cùng bộ não với bot Telegram, xem lib/family-bot.ts).
 * Gõ "/hoitham <lời nhắn>" ngay trong khung chat cũng được: loa sẽ đọc.
 *
 * Body:  { "messages": [ { "role": "user" | "assistant", "content": string }, ... ], "from"?: string }
 * Trả:   200 { reply, kind, ai, spoken }  |  400 { error }
 * Không có GROQ_API_KEY vẫn trả lời được (tóm tắt tự động, ai = false).
 */
import { NextResponse } from "next/server";
import { handleFamilyMessage, type ChatTurn } from "@/lib/family-bot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 90;

function parseMessages(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatTurn[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { role, content } = item as Record<string, unknown>;
    if ((role === "user" || role === "assistant") && typeof content === "string" && content.trim()) {
      out.push({ role, content: content.trim().slice(0, 2000) });
    }
  }
  return out.slice(-20);
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { messages?: unknown; from?: string } | null;
  if (!body) return NextResponse.json({ error: "Body không phải JSON hợp lệ." }, { status: 400 });
  const messages = parseMessages(body.messages);
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") {
    return NextResponse.json({ error: "Thiếu câu hỏi của người dùng." }, { status: 400 });
  }
  try {
    const out = await handleFamilyMessage({
      channel: "web",
      from: (body.from ?? "").trim().slice(0, 40) || "Người nhà",
      chatId: null,
      text: last.content,
      history: messages.slice(0, -1),
    });
    return NextResponse.json(out);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
