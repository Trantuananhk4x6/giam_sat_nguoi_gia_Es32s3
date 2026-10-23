/**
 * GET  /api/tong-quan          bức tranh dễ hiểu cho người nhà (trang Tổng quan)
 * POST /api/tong-quan          { force?: boolean } -> nhận xét của trợ lý AI
 *                              (lưu đệm 5 phút; không có GROQ_API_KEY thì trả
 *                              tóm tắt tự động, ai = false)
 */
import { NextResponse } from "next/server";
import { overviewComment } from "@/lib/family-bot";
import { getOverview } from "@/lib/health";
import { pollerSnapshot } from "@/lib/poller";
import { zaloBotInfo } from "@/lib/zalo-bot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  const overview = await getOverview();
  const snap = pollerSnapshot();
  const zalo = zaloBotInfo();
  return NextResponse.json({
    ...overview,
    series: snap.series.slice(-240),
    // Trạng thái bot Zalo của dashboard (null = chưa khai ZALO_BOT_TOKEN)
    zaloBotState: zalo.configured && zalo.enabled ? zalo.state : null,
  });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { force?: boolean };
  try {
    return NextResponse.json(await overviewComment(Boolean(body.force)));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
