/**
 * Lần thử.
 *   GET  /api/trials?sessionId=...   danh sách lần thử của phiên
 *   POST /api/trials                { action: "start" | "stop", ... }
 */
import { NextResponse } from "next/server";
import { getActiveTrial, getTrials } from "@/lib/store";
import { startTrial, stopTrial } from "@/lib/trials";
import type { Outcome } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const sessionId = new URL(req.url).searchParams.get("sessionId") ?? undefined;
  const trials = await getTrials(sessionId);
  return NextResponse.json(trials.slice().sort((a, b) => b.startedAt - a.startedAt));
}

export async function POST(req: Request) {
  const body = (await req.json()) as {
    action?: "start" | "stop";
    sessionId?: string;
    scenarioId?: string;
    trialId?: string;
    outcome?: Outcome | null;
    note?: string;
  };

  try {
    if (body.action === "start") {
      if (!body.sessionId || !body.scenarioId) {
        return NextResponse.json(
          { error: "Cần chọn phiên đo và kịch bản trước khi bắt đầu" },
          { status: 400 },
        );
      }
      const trial = await startTrial(body.sessionId, body.scenarioId);
      return NextResponse.json(trial, { status: 201 });
    }

    if (body.action === "stop") {
      const id = body.trialId ?? (await getActiveTrial())?.id;
      if (!id) {
        return NextResponse.json({ error: "Không có lần thử nào đang chạy" }, { status: 400 });
      }
      const trial = await stopTrial(id, { outcome: body.outcome, note: body.note });
      return NextResponse.json(trial);
    }

    return NextResponse.json({ error: "Thiếu action (start hoặc stop)" }, { status: 400 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
