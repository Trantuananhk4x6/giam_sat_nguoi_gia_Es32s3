/**
 * GET /api/live
 * Một lời gọi duy nhất trả về mọi thứ trang giám sát cần: trạng thái ESP32,
 * các sự kiện gần nhất, lần thử đang chạy và chuỗi dữ liệu để vẽ đồ thị.
 * Gộp như vậy để trình duyệt chỉ phải hỏi 1 lần mỗi chu kỳ.
 */
import { NextResponse } from "next/server";
import { ensurePoller, pollerSnapshot } from "@/lib/poller";
import { getActiveTrial, getEvents, getSessions, getSettings } from "@/lib/store";
import { refreshMarks } from "@/lib/trials";
import type { LivePayload } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensurePoller();

  const snap = pollerSnapshot();
  const [settings, allEvents, sessions] = await Promise.all([
    getSettings(),
    getEvents(),
    getSessions(),
  ]);

  // Lần thử đang chạy: tính lại mốc thời gian để giao diện hiện ngay khi radar báo
  let activeTrial = await getActiveTrial();
  if (activeTrial) activeTrial = await refreshMarks(activeTrial);
  const session = activeTrial
    ? (sessions.find((s) => s.id === activeTrial!.sessionId) ?? null)
    : null;

  const payload: LivePayload = {
    online: snap.online,
    error: snap.error,
    status: snap.status,
    events: allEvents.slice(-60).reverse(),
    activeTrial,
    session,
    settings,
    movementSeries: snap.series.slice(-240),
    vitalsSeries: snap.vitalsSeries.slice(-240),
    storedEventCount: allEvents.length,
  };

  return NextResponse.json(payload);
}
