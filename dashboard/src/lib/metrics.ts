/**
 * Chấm điểm từng lần thử và tính các chỉ số cho chương thực nghiệm của báo cáo.
 *
 * QUY ƯỚC CHẤM (đúng như tài liệu kế hoạch yêu cầu)
 *   TP – ngã thật và hệ thống phát hiện được
 *   FN – ngã thật nhưng hệ thống bỏ sót
 *   FP – không hề ngã nhưng hệ thống báo
 *   TN – không ngã và hệ thống cũng không báo
 */
import { findScenario } from "./scenarios";
import type { Outcome, StoredEvent, Trial } from "./types";

/** Các mốc thời gian rút ra từ nhật ký firmware trong khoảng của một lần thử */
export type TrialMarks = {
  detectedAt: number | null;
  alertedAt: number | null;
  telegramAt: number | null;
  cancelledAt: number | null;
  sosAt: number | null;
  deviceAlertMs: number | null;
  deviceResponseMs: number | null;
  /** Radar có báo ngã nhưng bị bỏ qua vì đang trong thời gian nghỉ 60 giây */
  cooldownIgnored: boolean;
};

/**
 * Đọc số giây mà firmware tự đo được trong cột ghi chú.
 *
 * Firmware ghi sẵn hai con số đã đo bằng đồng hồ của chính nó:
 *     TELEGRAM_OK   ->  "tong 33.4s tu luc nga"
 *     CANCELLED     ->  "phan hoi sau 7.2s"
 * Dùng lại hai con số này chính xác hơn nhiều so với lấy hiệu hai mốc thời gian
 * mà dashboard nhận được, vì mốc nhận còn cộng thêm sai số của chu kỳ hỏi dữ
 * liệu (±1,5 giây). Định dạng ghi chú do chính firmware trong repo này sinh ra
 * nên hai bên luôn khớp — nếu sửa chuỗi ghi chú trong main.cpp thì sửa cả đây.
 */
function parseSecondsFromNote(note: string, prefix: RegExp): number | null {
  const m = prefix.exec(note);
  if (!m) return null;
  const value = Number.parseFloat(m[1]);
  return Number.isFinite(value) ? Math.round(value * 1000) : null;
}

/**
 * Rút các mốc thời gian từ danh sách sự kiện nằm trong khoảng của lần thử.
 *
 * Mẹo đọc dữ liệu: firmware ghi sự kiện FALL_SUSPECT trong HAI tình huống khác
 * nhau — một là chuyển thật sang trạng thái nghi ngờ (cột state = NGHI_NGO_TE_NGA),
 * hai là radar báo ngã nhưng bị bỏ qua vì đang trong thời gian nghỉ (state vẫn là
 * CO_NGUOI). Chỉ tình huống thứ nhất mới được tính là "phát hiện được".
 */
export function markTrialFromEvents(events: StoredEvent[]): TrialMarks {
  const marks: TrialMarks = {
    detectedAt: null,
    alertedAt: null,
    telegramAt: null,
    cancelledAt: null,
    sosAt: null,
    deviceAlertMs: null,
    deviceResponseMs: null,
    cooldownIgnored: false,
  };

  for (const e of events) {
    switch (e.type) {
      case "FALL_SUSPECT":
        if (e.state === "NGHI_NGO_TE_NGA") {
          marks.detectedAt ??= e.recvAt;
        } else {
          marks.cooldownIgnored = true;
        }
        break;
      case "EMERGENCY":
        marks.alertedAt ??= e.recvAt;
        break;
      case "TELEGRAM_OK":
        marks.telegramAt ??= e.recvAt;
        marks.deviceAlertMs ??= parseSecondsFromNote(e.note, /tong\s+([\d.]+)s/i);
        break;
      case "CANCELLED":
        marks.cancelledAt ??= e.recvAt;
        marks.deviceResponseMs ??= parseSecondsFromNote(e.note, /phan hoi sau\s+([\d.]+)s/i);
        break;
      case "SOS":
        marks.sosAt ??= e.recvAt;
        break;
      default:
        break;
    }
  }
  return marks;
}

/** Tự chấm kết quả một lần thử. Trả về null nếu lần thử không tính vào độ chính xác. */
export function autoOutcome(trial: Pick<Trial,
  "expectFall" | "countInDetection" | "detectedAt">): Outcome | null {
  if (!trial.countInDetection) return null;
  const detected = trial.detectedAt !== null;
  if (trial.expectFall) return detected ? "TP" : "FN";
  return detected ? "FP" : "TN";
}

function ratio(num: number, den: number): number | null {
  return den > 0 ? num / den : null;
}

export type LatencyStats = {
  count: number;
  meanMs: number | null;
  maxMs: number | null;
  minMs: number | null;
};

function latency(values: number[]): LatencyStats {
  const v = values.filter((x) => Number.isFinite(x) && x >= 0);
  if (v.length === 0) return { count: 0, meanMs: null, maxMs: null, minMs: null };
  const sum = v.reduce((a, b) => a + b, 0);
  return {
    count: v.length,
    meanMs: Math.round(sum / v.length),
    maxMs: Math.max(...v),
    minMs: Math.min(...v),
  };
}

export type ScenarioRow = {
  scenarioId: string;
  scenarioName: string;
  group: string;
  target: number;
  done: number;
  correct: number;
  wrong: number;
  accuracy: number | null;
  outcomes: Record<Outcome, number>;
};

export type Metrics = {
  totalTrials: number;
  scored: number;
  confusion: Record<Outcome, number>;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  accuracy: number | null;
  /** Từ lúc bấm "bắt đầu lần thử" tới khi radar báo ngã (có kèm độ trễ con người) */
  detectLatency: LatencyStats;
  /** Từ lúc radar báo ngã tới khi Telegram gửi xong (số đo chính xác nhất) */
  alertLatency: LatencyStats;
  /** Thời gian người dùng bấm "Tôi ổn" sau khi loa hỏi thăm */
  responseLatency: LatencyStats;
  scenarios: ScenarioRow[];
  /** Số lần thử bị bỏ qua vì rơi vào thời gian nghỉ 60 giây -> nên đo lại */
  cooldownIgnored: number;
};

export function computeMetrics(trials: Trial[]): Metrics {
  const done = trials.filter((t) => t.endedAt !== null);
  const confusion: Record<Outcome, number> = { TP: 0, FP: 0, FN: 0, TN: 0 };

  for (const t of done) {
    if (t.outcome) confusion[t.outcome]++;
  }

  const { TP, FP, FN, TN } = confusion;
  const scored = TP + FP + FN + TN;

  const detectLatency = latency(
    done.filter((t) => t.detectedAt !== null).map((t) => t.detectedAt! - t.startedAt),
  );
  // Ưu tiên con số firmware tự đo; chỉ khi thiếu mới lấy hiệu hai mốc nhận được.
  const alertLatency = latency(
    done
      .map((t) =>
        t.deviceAlertMs ??
        (t.detectedAt !== null && t.telegramAt !== null ? t.telegramAt - t.detectedAt : NaN),
      )
      .filter((v) => Number.isFinite(v)),
  );
  const responseLatency = latency(
    done
      .map((t) =>
        t.deviceResponseMs ??
        (t.detectedAt !== null && t.cancelledAt !== null ? t.cancelledAt - t.detectedAt : NaN),
      )
      .filter((v) => Number.isFinite(v)),
  );

  // Gom theo kịch bản
  const byScenario = new Map<string, Trial[]>();
  for (const t of done) {
    const arr = byScenario.get(t.scenarioId) ?? [];
    arr.push(t);
    byScenario.set(t.scenarioId, arr);
  }

  const scenarios: ScenarioRow[] = [...byScenario.entries()].map(([id, list]) => {
    const sc = findScenario(id);
    const outcomes: Record<Outcome, number> = { TP: 0, FP: 0, FN: 0, TN: 0 };
    for (const t of list) if (t.outcome) outcomes[t.outcome]++;
    const correct = outcomes.TP + outcomes.TN;
    const wrong = outcomes.FP + outcomes.FN;
    return {
      scenarioId: id,
      scenarioName: sc?.name ?? list[0]?.scenarioName ?? id,
      group: sc?.group ?? "—",
      target: sc?.target ?? 0,
      done: list.length,
      correct,
      wrong,
      accuracy: ratio(correct, correct + wrong),
      outcomes,
    };
  });
  scenarios.sort((a, b) => a.scenarioName.localeCompare(b.scenarioName, "vi"));

  const precision = ratio(TP, TP + FP);
  const recall = ratio(TP, TP + FN);
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null;

  return {
    totalTrials: done.length,
    scored,
    confusion,
    precision,
    recall,
    f1,
    accuracy: ratio(TP + TN, scored),
    detectLatency,
    alertLatency,
    responseLatency,
    scenarios,
    cooldownIgnored: done.filter((t) => t.cooldownIgnored).length,
  };
}

/** Định dạng phần trăm cho giao diện và cho bảng dán vào báo cáo */
export function pct(v: number | null, digits = 1): string {
  return v === null ? "—" : `${(v * 100).toFixed(digits)}%`;
}

export function secs(ms: number | null, digits = 1): string {
  return ms === null ? "—" : `${(ms / 1000).toFixed(digits)} s`;
}
