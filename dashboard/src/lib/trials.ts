/**
 * Nghiệp vụ của một lần thử: bắt đầu – theo dõi – kết thúc – chấm điểm.
 */
import { autoOutcome, markTrialFromEvents } from "./metrics";
import { findScenario } from "./scenarios";
import {
  getActiveTrial,
  getEventsBetween,
  getTrials,
  newId,
  upsertTrial,
} from "./store";
import type { Outcome, Trial } from "./types";

/** Khoảng thời gian cộng thêm sau khi bấm "kết thúc" để kịp nhận tin Telegram */
export const TAIL_MS = 2000;

/**
 * Bắt đầu một lần thử mới. Nếu đang có lần thử dở thì tự kết thúc lần đó trước
 * để không bao giờ tồn tại hai lần thử cùng lúc (sẽ làm lẫn mốc thời gian).
 */
export async function startTrial(sessionId: string, scenarioId: string): Promise<Trial> {
  const sc = findScenario(scenarioId);
  if (!sc) throw new Error(`Không có kịch bản "${scenarioId}"`);

  const dangling = await getActiveTrial();
  if (dangling) await stopTrial(dangling.id, {});

  const trial: Trial = {
    id: newId("tr"),
    sessionId,
    scenarioId: sc.id,
    scenarioName: sc.name,
    expectFall: sc.expectFall,
    countInDetection: sc.countInDetection,
    startedAt: Date.now(),
    endedAt: null,
    detectedAt: null,
    alertedAt: null,
    telegramAt: null,
    cancelledAt: null,
    sosAt: null,
    deviceAlertMs: null,
    deviceResponseMs: null,
    outcome: null,
    manualOutcome: false,
    cooldownIgnored: false,
    note: "",
  };
  return upsertTrial(trial);
}

/** Tính lại các mốc thời gian của một lần thử từ nhật ký đã thu được. */
export async function refreshMarks(trial: Trial, until?: number): Promise<Trial> {
  const to = until ?? Date.now();
  const events = await getEventsBetween(trial.startedAt, to);
  const marks = markTrialFromEvents(events);
  return {
    ...trial,
    detectedAt: marks.detectedAt,
    alertedAt: marks.alertedAt,
    telegramAt: marks.telegramAt,
    cancelledAt: marks.cancelledAt,
    sosAt: marks.sosAt,
    deviceAlertMs: marks.deviceAlertMs,
    deviceResponseMs: marks.deviceResponseMs,
    cooldownIgnored: marks.cooldownIgnored,
  };
}

/**
 * Kết thúc lần thử: chốt mốc thời gian rồi tự chấm kết quả.
 * Người đo có thể truyền `outcome` để chấm tay (ví dụ khi ngã nhưng người thử
 * đỡ tay xuống sàn nên không coi là một ca hợp lệ).
 */
export async function stopTrial(
  trialId: string,
  opts: { outcome?: Outcome | null; note?: string },
): Promise<Trial> {
  const all = await getTrials();
  const found = all.find((t) => t.id === trialId);
  if (!found) throw new Error("Không tìm thấy lần thử");

  const endedAt = Date.now();
  const withMarks = await refreshMarks(found, endedAt + TAIL_MS);
  const auto = autoOutcome(withMarks);
  const manual = opts.outcome !== undefined && opts.outcome !== null;

  const finished: Trial = {
    ...withMarks,
    endedAt,
    outcome: manual ? (opts.outcome as Outcome) : auto,
    manualOutcome: manual && opts.outcome !== auto,
    note: opts.note ?? found.note,
  };
  return upsertTrial(finished);
}

/** Chấm lại / sửa ghi chú một lần thử đã xong. */
export async function editTrial(
  trialId: string,
  patch: { outcome?: Outcome | null; note?: string },
): Promise<Trial> {
  const all = await getTrials();
  const found = all.find((t) => t.id === trialId);
  if (!found) throw new Error("Không tìm thấy lần thử");

  const auto = autoOutcome(found);
  const outcome = patch.outcome === undefined ? found.outcome : patch.outcome;
  return upsertTrial({
    ...found,
    outcome,
    manualOutcome: outcome !== auto,
    note: patch.note ?? found.note,
  });
}
