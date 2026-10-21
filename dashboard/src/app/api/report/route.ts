/**
 * GET /api/report?sessionId=...
 *
 * Trả về chỉ số của một phiên đo, kèm bảng so sánh GIỮA CÁC PHIÊN — đúng gợi ý
 * của bản kế hoạch: "thử thêm ở 2 độ cao lắp đặt hoặc 2 mức độ nhạy để có số
 * liệu so sánh, phần này làm báo cáo dày hơn hẳn".
 */
import { NextResponse } from "next/server";
import { computeMetrics } from "@/lib/metrics";
import { getSessions, getTrials } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const sessionId = new URL(req.url).searchParams.get("sessionId");
  const [sessions, allTrials] = await Promise.all([getSessions(), getTrials()]);

  const session = sessionId ? (sessions.find((s) => s.id === sessionId) ?? null) : null;
  const trials = sessionId ? allTrials.filter((t) => t.sessionId === sessionId) : allTrials;

  // So sánh tất cả các phiên có dữ liệu
  const comparison = sessions
    .map((s) => {
      const m = computeMetrics(allTrials.filter((t) => t.sessionId === s.id));
      return {
        sessionId: s.id,
        name: s.name,
        installHeightCm: s.installHeightCm,
        sensitivity: s.sensitivity,
        trials: m.totalTrials,
        precision: m.precision,
        recall: m.recall,
        f1: m.f1,
        accuracy: m.accuracy,
        alertMeanMs: m.alertLatency.meanMs,
        alertMaxMs: m.alertLatency.maxMs,
      };
    })
    .filter((row) => row.trials > 0)
    .sort((a, b) => a.installHeightCm - b.installHeightCm || a.sensitivity - b.sensitivity);

  return NextResponse.json({
    session,
    metrics: computeMetrics(trials),
    comparison,
    sessions: sessions.slice().sort((a, b) => b.createdAt - a.createdAt),
  });
}
