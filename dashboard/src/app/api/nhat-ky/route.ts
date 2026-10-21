/**
 * GET /api/nhat-ky?days=7&all=0
 * Nhật ký nhiều ngày viết bằng lời thường cho người nhà (mới nhất trước).
 * all=1 thì hiện cả sự kiện kỹ thuật (Wi-Fi, thao tác thử...) bằng nhãn của firmware.
 */
import { NextResponse } from "next/server";
import { elderCallOf, friendlyEvent, startOfTodayVN, timeVN, type FriendlyEvent } from "@/lib/health";
import { ensurePoller, pollerSnapshot } from "@/lib/poller";
import { getEvents, getSettings } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  await ensurePoller();
  const url = new URL(req.url);
  const days = Math.min(60, Math.max(1, Number(url.searchParams.get("days")) || 7));
  const all = url.searchParams.get("all") === "1";
  const [settings, events] = await Promise.all([getSettings(), getEvents()]);
  const call = elderCallOf(settings, pollerSnapshot().status?.device.name);
  const since = startOfTodayVN() - (days - 1) * 86_400_000;

  const items: FriendlyEvent[] = [];
  for (let i = events.length - 1; i >= 0 && items.length < 1500; i--) {
    const e = events[i];
    if (e.recvAt < since) break;
    const f = friendlyEvent(e, call);
    if (f) items.push(f);
    else if (all) {
      items.push({ key: e.key, at: e.recvAt, time: timeVN(e.recvAt), icon: "gear", text: `${e.label}${e.note ? ` (${e.note})` : ""}`, tone: "muted", type: e.type });
    }
  }
  return NextResponse.json({ call, days, items });
}
