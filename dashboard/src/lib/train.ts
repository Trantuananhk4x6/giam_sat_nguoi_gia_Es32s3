/**
 * Huấn luyện model phát hiện té ngã (hồi quy logistic) ngay trong dashboard.
 *
 * VÌ SAO HỒI QUY LOGISTIC, KHÔNG PHẢI MẠNG NƠ-RON SÂU
 *   Dữ liệu đồ án chỉ vài trăm cửa sổ. Mạng sâu sẽ học vẹt (overfit) và con số
 *   đẹp trên giấy sẽ không đúng khi demo. Hồi quy logistic có 11 tham số, chạy
 *   được trên ESP32 trong vài micro-giây, và GIẢI THÍCH ĐƯỢC: mỗi trọng số cho
 *   biết đặc trưng nào đẩy quyết định theo hướng nào — rất quan trọng khi bảo vệ.
 *
 * HAI ĐIỂM VỀ PHƯƠNG PHÁP (nên viết vào báo cáo)
 *   1. Chia train/test THEO LẦN THỬ, không theo cửa sổ. Các cửa sổ trong cùng
 *      một lần thử gần như giống nhau; nếu chia theo cửa sổ thì cửa sổ "anh em"
 *      rơi vào cả hai tập và điểm số bị thổi phồng (rò rỉ dữ liệu - data leakage).
 *   2. Cân trọng số theo lớp. Số cửa sổ "không ngã" luôn nhiều hơn hẳn số cửa sổ
 *      "ngã"; nếu không cân thì model chỉ cần đoán "không ngã" mọi lúc là đã
 *      đạt độ chính xác cao mà hoàn toàn vô dụng.
 */
import {
  extractFeatures,
  slidingWindows,
  FEATURE_COUNT,
  FEATURE_SPEC_VERSION,
  WINDOW_SIZE,
  type FeatureSample,
} from "./features";
import type { Trial } from "./types";

/** Số cửa sổ liên tiếp phải vượt ngưỡng mới kết luận là té ngã (khớp với firmware C++) */
export const CONFIRM_WINDOWS = 2;
/** Trần số lần báo nhầm mỗi giờ mặc định khi chọn ngưỡng */
export const DEFAULT_FA_BUDGET_PER_HOUR = 6.0;

export type LabeledWindow = {
  x: number[];
  y: 0 | 1;
  trialId: string;
  scenarioId: string;
  endRecvAt: number;
};

export type Dataset = {
  train: LabeledWindow[];
  test: LabeledWindow[];
  /** Số lần thử dùng được / bị bỏ vì thiếu dữ liệu đặc trưng */
  trialsUsed: number;
  trialsSkipped: number;
  warnings: string[];
};

export type LogisticModel = {
  weights: number[];
  bias: number;
  threshold: number;
  specVersion: number;
  window: number;
};

export type Scores = {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  accuracy: number | null;
  count: number;
};

export type EventEval = {
  threshold: number;
  fallTrials: number;
  caughtTrials: number;
  eventRecall: number;
  falseAlarmEvents: number;
  negWindows: number;
  negHours: number;
  faPerHour: number;
  f1: number;
};

/** Nới thêm về hai phía của khoảng "có ngã" (ms) */
const POSITIVE_MARGIN_MS = 1500;
/** Độ trễ xác nhận mặc định của radar nếu không đọc được từ firmware (giây) */
const DEFAULT_FALL_CONFIRM_S = 5;
/** Khi radar bỏ sót (không có mốc detectedAt), coi ngã xảy ra trong khoảng này
 *  tính từ lúc bấm "bắt đầu lần thử" — người đo thường ngã sau 1–6 giây. */
const FALLBACK_POSITIVE_FROM_MS = 1000;
const FALLBACK_POSITIVE_TO_MS = 6000;

/**
 * Ghép mẫu đặc trưng với từng lần thử rồi gán nhãn cho các cửa sổ trượt.
 *
 * Quy tắc gán nhãn:
 *   - Lần thử KHÔNG phải té ngã -> mọi cửa sổ là nhãn 0.
 *   - Lần thử LÀ té ngã         -> nhãn 1 cho các cửa sổ phủ khoảng từ lúc ngã
 *                                  thật tới lúc radar báo, các cửa sổ còn lại bị
 *                                  BỎ QUA (không gán 0, vì chúng nằm lẫn giữa
 *                                  trước và sau lúc ngã, gán 0 sẽ gây nhiễu).
 *
 *     Lúc ngã thật được suy ra bằng: detectedAt trừ đi độ trễ xác nhận của radar
 *     (RADAR_FALL_TIME_S, firmware tự báo lên trong /api/status).
 */
export function buildDataset(
  trials: Trial[],
  samples: FeatureSample[],
  testRatio = 0.3,
  fallConfirmS = DEFAULT_FALL_CONFIRM_S,
): Dataset {
  const warnings: string[] = [];
  const done = trials
    .filter((t) => t.endedAt !== null)
    .slice()
    .sort((a, b) => a.startedAt - b.startedAt);

  // Chia theo LẦN THỬ, xen kẽ để hai tập cân về kịch bản
  const trainTrials = new Set<string>();
  const testTrials = new Set<string>();
  const everyN = testRatio > 0 ? Math.max(2, Math.round(1 / testRatio)) : 0;
  done.forEach((t, i) => {
    if (everyN > 0 && i % everyN === everyN - 1) testTrials.add(t.id);
    else trainTrials.add(t.id);
  });

  const train: LabeledWindow[] = [];
  const test: LabeledWindow[] = [];
  let used = 0;
  let skipped = 0;

  for (const t of done) {
    const from = t.startedAt;
    const to = (t.endedAt ?? t.startedAt) + 2000;
    const mine = samples
      .filter((s) => s.recvAt >= from && s.recvAt <= to)
      .sort((a, b) => a.recvAt - b.recvAt);

    if (mine.length < WINDOW_SIZE) {
      skipped++;
      continue;
    }
    used++;

    const windows = slidingWindows(mine, 1);
    const bucket = testTrials.has(t.id) ? test : train;

    for (const { window, endRecvAt } of windows) {
      const x = extractFeatures(window);
      if (!x) continue;

      if (!t.expectFall) {
        bucket.push({ x, y: 0, trialId: t.id, scenarioId: t.scenarioId, endRecvAt });
        continue;
      }

      // Lần thử là té ngã thật: chỉ lấy những cửa sổ CHỨA cú ngã.
      //
      // Điểm then chốt: radar chỉ báo ngã SAU KHI xác nhận liên tục
      // RADAR_FALL_TIME_S giây (mặc định 5 giây). Nên mốc detectedAt muộn hơn
      // lúc ngã thật đúng khoảng đó. Nếu lấy cửa sổ quanh detectedAt thì nó rơi
      // vào đoạn người đã nằm im, bỏ mất chính cú va đập — model sẽ không học
      // được gì. Vì vậy khoảng "có ngã" được dịch lùi lại cho đúng.
      let isPositive: boolean;
      if (t.detectedAt !== null) {
        const impactAt = t.detectedAt - fallConfirmS * 1000;
        isPositive =
          endRecvAt >= impactAt - POSITIVE_MARGIN_MS &&
          endRecvAt <= t.detectedAt + POSITIVE_MARGIN_MS;
      } else {
        const rel = endRecvAt - t.startedAt;
        isPositive = rel >= FALLBACK_POSITIVE_FROM_MS && rel <= FALLBACK_POSITIVE_TO_MS;
      }
      if (isPositive) {
        bucket.push({ x, y: 1, trialId: t.id, scenarioId: t.scenarioId, endRecvAt });
      }
      // cửa sổ còn lại của lần thử ngã: bỏ qua, không gán nhãn
    }
  }

  if (skipped > 0) {
    warnings.push(
      `${skipped} lần thử bị bỏ vì không thu được đủ ${WINDOW_SIZE} mẫu đặc trưng ` +
        `(thường do dashboard chưa chạy lúc đo, hoặc ESP32 vừa khởi động lại).`,
    );
  }
  const pos = [...train, ...test].filter((w) => w.y === 1).length;
  const neg = [...train, ...test].filter((w) => w.y === 0).length;
  if (pos < 20) {
    warnings.push(
      `Chỉ có ${pos} cửa sổ "có ngã" — quá ít để huấn luyện đáng tin. ` +
        `Nên đo thêm các kịch bản té ngã (mỗi kịch bản 20–30 lần như bản kế hoạch).`,
    );
  }
  if (pos > 0 && neg / pos > 12) {
    warnings.push(
      `Dữ liệu lệch lớp mạnh (${neg} không ngã / ${pos} có ngã). Model đã được cân ` +
        `trọng số theo lớp, nhưng nên đo thêm kịch bản té ngã cho cân.`,
    );
  }

  return { train, test, trialsUsed: used, trialsSkipped: skipped, warnings };
}

function sigmoid(z: number): number {
  if (z > 30) return 1;
  if (z < -30) return 0;
  return 1 / (1 + Math.exp(-z));
}

export type TrainOptions = {
  epochs?: number;
  learningRate?: number;
  l2?: number;
  threshold?: number;
};

/**
 * Huấn luyện bằng gradient descent trên hàm mất mát logistic, có cân trọng số
 * theo lớp và chuẩn hóa L2 để tránh trọng số phình to.
 */
export function trainLogistic(
  data: LabeledWindow[],
  opts: TrainOptions = {},
): { model: LogisticModel; loss: number[] } {
  const epochs = opts.epochs ?? 600;
  const lr = opts.learningRate ?? 0.5;
  const l2 = opts.l2 ?? 0.01;
  const threshold = opts.threshold ?? 0.5;

  const weights = new Array<number>(FEATURE_COUNT).fill(0);
  let bias = 0;
  const loss: number[] = [];

  const nPos = data.filter((d) => d.y === 1).length;
  const nNeg = data.length - nPos;
  // Cân lớp: lớp ít mẫu được nhân trọng số lớn hơn
  const wPos = nPos > 0 ? data.length / (2 * nPos) : 1;
  const wNeg = nNeg > 0 ? data.length / (2 * nNeg) : 1;

  if (data.length === 0) {
    return { model: { weights, bias, threshold, specVersion: FEATURE_SPEC_VERSION, window: WINDOW_SIZE }, loss };
  }

  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradW = new Array<number>(FEATURE_COUNT).fill(0);
    let gradB = 0;
    let epochLoss = 0;
    let weightSum = 0;

    for (const d of data) {
      const w = d.y === 1 ? wPos : wNeg;
      let z = bias;
      for (let i = 0; i < FEATURE_COUNT; i++) z += weights[i] * d.x[i];
      const p = sigmoid(z);
      const err = p - d.y;

      for (let i = 0; i < FEATURE_COUNT; i++) gradW[i] += w * err * d.x[i];
      gradB += w * err;

      const eps = 1e-9;
      epochLoss += w * -(d.y * Math.log(p + eps) + (1 - d.y) * Math.log(1 - p + eps));
      weightSum += w;
    }

    for (let i = 0; i < FEATURE_COUNT; i++) {
      weights[i] -= lr * (gradW[i] / weightSum + l2 * weights[i]);
    }
    bias -= lr * (gradB / weightSum);

    if (epoch % 20 === 0 || epoch === epochs - 1) loss.push(epochLoss / weightSum);
  }

  return {
    model: { weights, bias, threshold, specVersion: FEATURE_SPEC_VERSION, window: WINDOW_SIZE },
    loss,
  };
}

export function predict(model: LogisticModel, x: number[]): number {
  let z = model.bias;
  for (let i = 0; i < FEATURE_COUNT; i++) z += model.weights[i] * x[i];
  return sigmoid(z);
}

export function evaluate(model: LogisticModel, data: LabeledWindow[]): Scores {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const d of data) {
    const hit = predict(model, d.x) >= model.threshold;
    if (d.y === 1 && hit) tp++;
    else if (d.y === 1 && !hit) fn++;
    else if (d.y === 0 && hit) fp++;
    else tn++;
  }
  const r = (a: number, b: number) => (b > 0 ? a / b : null);
  const precision = r(tp, tp + fp);
  const recall = r(tp, tp + fn);
  return {
    tp,
    fp,
    fn,
    tn,
    precision,
    recall,
    f1:
      precision !== null && recall !== null && precision + recall > 0
        ? (2 * precision * recall) / (precision + recall)
        : null,
    accuracy: r(tp + tn, data.length),
    count: data.length,
  };
}

/**
 * Đánh giá theo SỰ KIỆN (Event-level) với đúng luật xác nhận của firmware C++:
 * phải có `CONFIRM_WINDOWS = 2` cửa sổ liên tiếp vượt ngưỡng mới kích hoạt báo động.
 */
export function evaluateEvents(
  model: LogisticModel,
  data: LabeledWindow[],
  threshold = model.threshold,
): EventEval {
  const byTrial = new Map<string, LabeledWindow[]>();
  for (const w of data) {
    let arr = byTrial.get(w.trialId);
    if (!arr) {
      arr = [];
      byTrial.set(w.trialId, arr);
    }
    arr.push(w);
  }

  let fallTrials = 0;
  let caughtTrials = 0;
  let falseAlarmEvents = 0;
  let negWindows = 0;

  for (const windows of byTrial.values()) {
    const sorted = windows.slice().sort((a, b) => a.endRecvAt - b.endRecvAt);
    const isFallTrial = sorted.some((w) => w.y === 1);
    const needed = Math.min(CONFIRM_WINDOWS, sorted.length);
    let consecutive = 0;
    let trialFired = false;

    for (const w of sorted) {
      if (w.y === 0) negWindows++;
      const above = predict(model, w.x) >= threshold;
      if (above) {
        consecutive++;
        if (consecutive >= needed) {
          trialFired = true;
          if (!isFallTrial && consecutive === needed) {
            falseAlarmEvents++;
          }
        }
      } else {
        consecutive = 0;
      }
    }

    if (isFallTrial) {
      fallTrials++;
      if (trialFired) caughtTrials++;
    }
  }

  // Mỗi cửa sổ trượt bước 1 mẫu = 250 ms = 0.25 giây
  const negHours = (negWindows * 0.25) / 3600;
  const faPerHour = negHours > 0 ? falseAlarmEvents / negHours : 0;
  const eventRecall = fallTrials > 0 ? caughtTrials / fallTrials : 0;
  const winScores = evaluate({ ...model, threshold }, data);

  return {
    threshold,
    fallTrials,
    caughtTrials,
    eventRecall,
    falseAlarmEvents,
    negWindows,
    negHours,
    faPerHour,
    f1: winScores.f1 ?? 0,
  };
}

/**
 * Chọn ngưỡng tối ưu trên tập huấn luyện:
 * Ưu tiên kiểm soát báo động giả theo sự kiện (2 cửa sổ liên tiếp vượt ngưỡng,
 * khống chế số lần báo nhầm/giờ <= maxFaPerHour) bên cạnh F1 theo cửa sổ.
 */
export function tuneThreshold(
  model: LogisticModel,
  data: LabeledWindow[],
  maxFaPerHour = DEFAULT_FA_BUDGET_PER_HOUR,
): number {
  if (data.length === 0) return 0.5;

  const candidates: number[] = [];
  for (let th = 0.1; th <= 0.9001; th += 0.02) {
    candidates.push(Math.round(th * 100) / 100);
  }
  for (const highTh of [0.92, 0.94, 0.96, 0.98, 0.99]) {
    candidates.push(highTh);
  }

  let bestSafeTh: number | null = null;
  let bestSafeScore = -1;

  let bestFallbackTh = 0.5;
  let bestFallbackScore = -Infinity;

  for (const th of candidates) {
    const ev = evaluateEvents(model, data, th);
    const withinBudget = ev.faPerHour <= maxFaPerHour || ev.falseAlarmEvents === 0;

    // Điểm kết hợp giữa tỷ lệ bắt ngã theo sự kiện (2 cửa sổ liên tiếp) và F1 cửa sổ
    const combinedScore = ev.fallTrials > 0 ? 0.6 * ev.eventRecall + 0.4 * ev.f1 : ev.f1;

    if (withinBudget && (ev.eventRecall > 0 || ev.f1 > 0)) {
      if (combinedScore > bestSafeScore) {
        bestSafeScore = combinedScore;
        bestSafeTh = th;
      }
    }

    // Điểm dự phòng nếu dữ liệu quá ngắn khiến 1 lần FP cũng vượt trần FA/giờ
    const fallbackScore = ev.f1 - 0.04 * ev.falseAlarmEvents;
    if (fallbackScore > bestFallbackScore) {
      bestFallbackScore = fallbackScore;
      bestFallbackTh = th;
    }
  }

  return bestSafeTh ?? bestFallbackTh;
}

/** Sinh nội dung file include/model_weights.h để nạp vào firmware */
export function generateHeader(
  model: LogisticModel,
  meta: { trainScores: Scores; testScores: Scores; dataset: Dataset },
): string {
  const now = new Date().toLocaleString("vi-VN");
  const f = (v: number) => `${v.toFixed(6)}f`;
  const info =
    `huan luyen ${now} | ${meta.dataset.train.length} cua so train, ` +
    `${meta.dataset.test.length} test | F1 test ` +
    `${meta.testScores.f1 === null ? "-" : (meta.testScores.f1 * 100).toFixed(1) + "%"}`;

  return `/**
 * @file  model_weights.h
 * @brief Trong so model phat hien te nga. FILE NAY DUOC SINH TU DONG.
 *
 * Sinh luc: ${now}
 * Sinh boi: dashboard -> trang "Huan luyen model" -> Tai model_weights.h
 *
 * DUNG SUA TAY. Muon doi thi huan luyen lai roi tai file moi.
 *
 * ----------------------------- SO LIEU -----------------------------------
 * So lan thu dung duoc        : ${meta.dataset.trialsUsed}
 * So lan thu bi bo (thieu mau): ${meta.dataset.trialsSkipped}
 * Cua so huan luyen (train)   : ${meta.dataset.train.length}
 * Cua so kiem tra  (test)     : ${meta.dataset.test.length}
 *
 * Tren tap TRAIN: TP=${meta.trainScores.tp} FP=${meta.trainScores.fp} FN=${meta.trainScores.fn} TN=${meta.trainScores.tn}
 * Tren tap TEST : TP=${meta.testScores.tp} FP=${meta.testScores.fp} FN=${meta.testScores.fn} TN=${meta.testScores.tn}
 *   Precision test = ${meta.testScores.precision === null ? "-" : (meta.testScores.precision * 100).toFixed(1) + "%"}
 *   Recall    test = ${meta.testScores.recall === null ? "-" : (meta.testScores.recall * 100).toFixed(1) + "%"}
 *   F1        test = ${meta.testScores.f1 === null ? "-" : (meta.testScores.f1 * 100).toFixed(1) + "%"}
 *
 * Luu y: so lieu TEST moi la so lieu duoc bao cao. So lieu TRAIN luon dep hon.
 * -------------------------------------------------------------------------
 */
#pragma once
#include <Arduino.h>

#define FALL_MODEL_TRAINED 1
#define FALL_MODEL_SPEC_VERSION ${model.specVersion}
#define FALL_MODEL_INFO "${info}"
// So cua so LIEN TIEP phai vuot nguong moi ket luan la nga.
#define FALL_MODEL_CONFIRM_WINDOWS ${CONFIRM_WINDOWS}

constexpr float FALL_MODEL_THRESHOLD = ${f(model.threshold)};
constexpr float FALL_MODEL_BIAS      = ${f(model.bias)};

// Thu tu dac trung xem src/core/fall_model.h
constexpr float FALL_MODEL_WEIGHTS[${FEATURE_COUNT}] = {
${model.weights.map((w, i) => `    ${f(w)},  // f${i}`).join("\n")}
};
`;
}
