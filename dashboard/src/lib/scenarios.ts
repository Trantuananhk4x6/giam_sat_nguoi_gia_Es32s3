import type { Scenario } from "./types";

/**
 * Danh mục kịch bản thí nghiệm, lấy đúng theo bảng ở mục 4 của bản kế hoạch đồ án.
 *
 *  - expectFall:       kịch bản này CÓ phải là một ca té ngã thật hay không.
 *                      Dùng để tự chấm TP / FP / FN / TN.
 *  - countInDetection: có đưa vào công thức độ chính xác phát hiện hay không.
 *                      Riêng kịch bản bấm SOS là kiểm tra quy trình cảnh báo
 *                      chứ không kiểm tra khả năng phát hiện của radar, nên để
 *                      false — nếu tính vào sẽ làm sai lệch chỉ số.
 */
export const SCENARIOS: Scenario[] = [
  {
    id: "khong-nguoi",
    name: "Không có người trong phòng",
    expectFall: false,
    countInDetection: true,
    target: 20,
    group: "Không ngã",
  },
  {
    id: "sinh-hoat",
    name: "Đi lại bình thường, ngồi ghế",
    expectFall: false,
    countInDetection: true,
    target: 20,
    group: "Không ngã",
  },
  {
    id: "nga-truoc",
    name: "Ngã về trước",
    expectFall: true,
    countInDetection: true,
    target: 30,
    group: "Ngã thật",
  },
  {
    id: "nga-ngang",
    name: "Ngã ngang",
    expectFall: true,
    countInDetection: true,
    target: 30,
    group: "Ngã thật",
  },
  {
    id: "nga-ngoi-bet",
    name: "Ngã ngồi bệt",
    expectFall: true,
    countInDetection: true,
    target: 30,
    group: "Ngã thật",
  },
  {
    id: "cui-nhat-do",
    name: "Cúi nhặt đồ (dễ nhầm)",
    expectFall: false,
    countInDetection: true,
    target: 20,
    group: "Dễ nhầm",
  },
  {
    id: "ngoi-xuong-san",
    name: "Ngồi xuống sàn nhanh (dễ nhầm)",
    expectFall: false,
    countInDetection: true,
    target: 20,
    group: "Dễ nhầm",
  },
  {
    id: "nam-xuong-tham",
    name: "Nằm xuống thảm có chủ đích (dễ nhầm)",
    expectFall: false,
    countInDetection: true,
    target: 20,
    group: "Dễ nhầm",
  },
  {
    id: "bam-toi-on",
    name: 'Ngã rồi bấm "Tôi ổn" sau khi loa hỏi thăm',
    expectFall: true,
    countInDetection: true,
    target: 20,
    group: "Quy trình cảnh báo",
  },
  {
    id: "bam-sos",
    name: "Bấm nút SOS",
    expectFall: false,
    countInDetection: false,
    target: 20,
    group: "Quy trình cảnh báo",
  },
  {
    id: "khong-phan-hoi",
    name: "Ngã và không phản hồi (để hết thời gian chờ)",
    expectFall: true,
    countInDetection: true,
    target: 20,
    group: "Quy trình cảnh báo",
  },
];

export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
