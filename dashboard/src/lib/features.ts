/**
 * HỢP ĐỒNG ĐẶC TRƯNG — bản TypeScript, phải khớp từng con số với bản C++.
 *
 *      C++        : src/fall_model.cpp        -> extractFeatures()
 *      TypeScript : file này                  -> extractFeatures()
 *
 * Sửa một bên thì PHẢI sửa bên kia và tăng FEATURE_SPEC_VERSION ở cả hai nơi,
 * nếu không firmware sẽ chạy model bằng đặc trưng khác lúc huấn luyện — sai mà
 * không báo lỗi gì. Firmware có kiểm tra số phiên bản và từ chối model nếu lệch.
 *
 * Vì sao KHÔNG đưa cờ té ngã của radar vào đặc trưng: nếu đưa vào, model chỉ
 * việc sao chép kết quả của chip, con số "chính xác 99%" trở nên vô nghĩa. Đây
 * là điểm dễ bị hội đồng bắt lỗi nhất.
 */

export const FEATURE_SPEC_VERSION = 1;
export const FEATURE_COUNT = 10;
export const WINDOW_SIZE = 12; // 12 mẫu x 250 ms = 3 giây

/** Một mẫu đặc trưng thô lấy từ /api/features của firmware */
export type FeatureSample = {
  /** millis() của thiết bị lúc lấy mẫu */
  t: number;
  present: number;
  movement: number;
  range: number;
  staticStay: number;
  distanceCm: number;
  trackX: number;
  trackY: number;
  /** Thời điểm dashboard nhận được (epoch ms) — dùng để ghép với lần thử */
  recvAt: number;
};

/** Tên từng đặc trưng, dùng để hiện bảng trọng số cho dễ hiểu */
export const FEATURE_NAMES = [
  "Trung bình biên độ chuyển động",
  "Biên độ chuyển động lớn nhất",
  "Độ lệch chuẩn biên độ",
  "Biên độ cuối trừ biên độ đầu",
  "Trung bình khoảng cách",
  "Khoảng cách cuối trừ đầu",
  "Khoảng cách nhỏ nhất",
  "Tỉ lệ mẫu có người",
  "Tỉ lệ mẫu đang hoạt động",
  "Tỉ lệ mẫu nằm im một chỗ",
];

/**
 * Giải mã một dòng từ /api/features (firmware gửi dạng mảng để JSON gọn hơn).
 * Thứ tự cột: t, present, movement, range, staticStay, distanceCm, trackX, trackY
 */
export function decodeRow(row: number[], recvAt: number): FeatureSample {
  return {
    t: row[0] ?? 0,
    present: row[1] ?? 0,
    movement: row[2] ?? 0,
    range: row[3] ?? 0,
    staticStay: row[4] ?? 0,
    distanceCm: row[5] ?? 0,
    trackX: row[6] ?? 0,
    trackY: row[7] ?? 0,
    recvAt,
  };
}

/**
 * Tính 10 đặc trưng từ một cửa sổ WINDOW_SIZE mẫu (cũ trước, mới sau).
 * Trả về null nếu không đủ mẫu.
 *
 * Các số chia (100, 50, 400, 200) là hằng số cố định, cố ý KHÔNG dùng bộ chuẩn
 * hóa tính từ dữ liệu — như vậy firmware không cần biết gì về tập huấn luyện,
 * chỉ cần 11 con số trọng số là chạy được.
 */
export function extractFeatures(window: FeatureSample[]): number[] | null {
  if (window.length !== WINDOW_SIZE) return null;

  let sumRange = 0;
  let maxRange = 0;
  let sumDist = 0;
  let minDist = Number.POSITIVE_INFINITY;
  let nPresent = 0;
  let nActive = 0;
  let nStatic = 0;

  for (const s of window) {
    sumRange += s.range;
    if (s.range > maxRange) maxRange = s.range;
    sumDist += s.distanceCm;
    if (s.distanceCm < minDist) minDist = s.distanceCm;
    if (s.present) nPresent++;
    if (s.movement === 2) nActive++;
    if (s.staticStay) nStatic++;
  }

  const n = WINDOW_SIZE;
  const meanRange = sumRange / n;
  let varRange = 0;
  for (const s of window) varRange += (s.range - meanRange) ** 2;
  const stdRange = Math.sqrt(varRange / n);

  const first = window[0];
  const last = window[n - 1];

  return [
    meanRange / 100,
    maxRange / 100,
    stdRange / 50,
    (last.range - first.range) / 100,
    sumDist / n / 400,
    (last.distanceCm - first.distanceCm) / 200,
    minDist / 400,
    nPresent / n,
    nActive / n,
    nStatic / n,
  ];
}

/**
 * Cắt một dãy mẫu liên tục thành các cửa sổ trượt.
 * @param step số mẫu dịch đi giữa hai cửa sổ (1 = dày nhất)
 */
export function slidingWindows(
  samples: FeatureSample[],
  step = 2,
): { window: FeatureSample[]; endRecvAt: number }[] {
  const out: { window: FeatureSample[]; endRecvAt: number }[] = [];
  for (let i = 0; i + WINDOW_SIZE <= samples.length; i += step) {
    const w = samples.slice(i, i + WINDOW_SIZE);
    out.push({ window: w, endRecvAt: w[WINDOW_SIZE - 1].recvAt });
  }
  return out;
}
