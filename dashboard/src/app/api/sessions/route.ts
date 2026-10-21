/**
 * Quản lý phiên đo.
 *   GET    /api/sessions          danh sách phiên (kèm số lần thử)
 *   POST   /api/sessions          tạo phiên mới
 *   DELETE /api/sessions?id=...   xóa phiên và toàn bộ lần thử của phiên đó
 */
import { NextResponse } from "next/server";
import { addSession, deleteSession, getSessions, getTrials, newId } from "@/lib/store";
import type { Session } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const [sessions, trials] = await Promise.all([getSessions(), getTrials()]);
  const rows = sessions
    .map((s) => ({
      ...s,
      trialCount: trials.filter((t) => t.sessionId === s.id && t.endedAt !== null).length,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
  return NextResponse.json(rows);
}

export async function POST(req: Request) {
  const body = (await req.json()) as Partial<Session>;

  const height = Number(body.installHeightCm);
  const sens = Number(body.sensitivity);
  if (!Number.isFinite(height) || height < 100 || height > 400) {
    return NextResponse.json(
      { error: "Chiều cao lắp phải trong khoảng 100–400 cm" },
      { status: 400 },
    );
  }
  if (!Number.isInteger(sens) || sens < 0 || sens > 3) {
    return NextResponse.json({ error: "Độ nhạy phải là số nguyên 0–3" }, { status: 400 });
  }

  const session: Session = {
    id: newId("ss"),
    name: (body.name ?? "").trim() || `Phiên đo ${new Date().toLocaleString("vi-VN")}`,
    installHeightCm: Math.round(height),
    sensitivity: sens,
    note: (body.note ?? "").trim(),
    createdAt: Date.now(),
  };
  await addSession(session);
  return NextResponse.json(session, { status: 201 });
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Thiếu tham số id" }, { status: 400 });
  await deleteSession(id);
  return NextResponse.json({ ok: true });
}
