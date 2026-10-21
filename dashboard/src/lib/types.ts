/**
 * Các kiểu dữ liệu dùng chung cho dashboard.
 */

/** Trạng thái tức thời đọc từ ESP32 (khớp với JSON của /api/status trên firmware) */
export type Esp32Status = {
  state: string;
  stateVi: string;
  countdown: number;
  cooldown: number;
  stateAge: number;
  latencyMs: number;
  simulate: boolean;
  confirmWin: number;
  voice: boolean;
  radar: {
    online: boolean;
    present: boolean;
    movement: number;
    range: number;
    distance: number;
    fall: boolean;
    static: boolean;
    falls: number;
    errors: number;
    health: string;
    ageMs: number;
  };
  /** Cấu hình đang nạp trong firmware (firmware tự báo lên) */
  config?: {
    installHeightCm: number;
    sensitivity: number;
    fallTimeS: number;
    unmannedTimeS: number;
    confirmWindowS: number;
    cooldownS: number;
    queryIntervalMs: number;
    sleepModeOn?: boolean;
    sleepFromHour?: number;
    sleepToHour?: number;
    hrAlertMin?: number;
    hrAlertMax?: number;
  };
  /**
   * Chế độ làm việc của radar. Mô-đun chỉ chạy MỘT chế độ tại một thời điểm:
   * phát hiện té ngã HOẶC theo dõi giấc ngủ (nhịp tim, nhịp thở).
   */
  mode?: {
    code: "TE_NGA" | "GIAC_NGU" | "DANG_DOI_CHE_DO" | string;
    vi: string;
    sinceS: number;
    switches: number;
    /** Tổng thời gian không phát hiện được té ngã vì đang đổi chế độ (ms) */
    blindMs: number;
    enabled: boolean;
  };
  /** Sinh hiệu — ƯỚC LƯỢNG bằng sóng radar, KHÔNG phải thiết bị y tế */
  vitals?: {
    valid: boolean;
    heartRate: number;
    breatheValue: number;
    breatheState: number;
    inBed: number;
    sleepState: number;
    sleepScore: number;
    struggle: number;
    ageMs: number;
  };
  /** Nút SOS đeo tay qua sóng 433 MHz */
  remote?: {
    enabled: boolean;
    presses: number;
    rejected: number;
    lastCode: number;
  };
  /**
   * Trạng thái Wi-Fi của thiết bị.
   *  - up: đang nối được một mạng Wi-Fi nhà (chế độ station).
   *  - saved: số mạng đã lưu trong firmware.
   *  - portal: đang mở cổng cấu hình (captive portal) để nhập Wi-Fi.
   *  - ap: đang phát Wi-Fi riêng (access point) cho điện thoại nối vào cấu hình.
   * saved/portal/ap do firmware mới bổ sung nên để optional cho tương thích ngược.
   */
  wifi: {
    up: boolean;
    ssid: string;
    rssi: number;
    ip: string;
    saved?: number;
    portal?: boolean;
    ap?: boolean;
  };
  telegram: {
    pending: number;
    sent: number;
    last: string;
    channels?: string;
    /** Ai đang đọc tin Telegram: off | device | dashboard (firmware mới) */
    poller?: string;
  };
  /** Lời nhắn đang chờ phát ra loa (firmware mới) */
  say?: { pending: boolean };
  stats: { suspects: number; cancelled: number; emergency: number; sos: number };
  device: {
    name: string;
    place: string;
    uptimeS: number;
    heap: number;
    psram: number;
    clients: number;
    epoch: number;
    clock: string;
  };
};

/** Một sự kiện do firmware ghi, đã được dashboard lưu lại kèm mốc thời gian nhận */
export type StoredEvent = {
  /** Khóa chống trùng khi hỏi lại nhiều lần: id + uptime + loại sự kiện */
  key: string;
  id: number;
  /** Giờ của thiết bị (epoch giây); 0 nếu ESP32 chưa đồng bộ NTP */
  ts: number;
  uptime: number;
  type: string;
  label: string;
  src: string;
  state: string;
  note: string;
  /** Mốc thời gian dashboard nhận được (epoch ms) – luôn đáng tin */
  recvAt: number;
};

/** Một phiên đo: cố định chiều cao lắp và độ nhạy để so sánh được với nhau */
export type Session = {
  id: string;
  name: string;
  installHeightCm: number;
  sensitivity: number;
  note: string;
  createdAt: number;
};

export type Outcome = "TP" | "FP" | "FN" | "TN";

/** Một lần thử trong phiên đo */
export type Trial = {
  id: string;
  sessionId: string;
  scenarioId: string;
  scenarioName: string;
  expectFall: boolean;
  countInDetection: boolean;
  startedAt: number;
  endedAt: number | null;
  /** Mốc firmware báo nghi ngờ té ngã (ms) */
  detectedAt: number | null;
  /** Mốc firmware phát cảnh báo khẩn cấp (ms) */
  alertedAt: number | null;
  /** Mốc Telegram gửi xong (ms) */
  telegramAt: number | null;
  /** Mốc người dùng bấm "Tôi ổn" (ms) */
  cancelledAt: number | null;
  /** Mốc bấm SOS (ms) */
  sosAt: number | null;
  /**
   * Trễ cảnh báo do CHÍNH FIRMWARE đo (ms): từ lúc radar báo ngã tới lúc gửi
   * xong Telegram. Chính xác hơn hiệu hai mốc thời gian dashboard nhận được,
   * vì không chịu sai số của chu kỳ hỏi dữ liệu.
   */
  deviceAlertMs: number | null;
  /** Thời gian người dùng bấm "Tôi ổn", cũng do firmware tự đo (ms) */
  deviceResponseMs: number | null;
  outcome: Outcome | null;
  /** true nếu người đo tự chấm lại, khác với kết quả tự động */
  manualOutcome: boolean;
  /**
   * Radar có báo ngã nhưng firmware bỏ qua vì đang trong thời gian nghỉ 60 giây.
   * Lần thử như vậy không phản ánh đúng năng lực hệ thống -> nên bỏ và đo lại.
   */
  cooldownIgnored: boolean;
  note: string;
};

/** Kịch bản thí nghiệm (theo bảng ở mục 4 của bản kế hoạch đồ án) */
export type Scenario = {
  id: string;
  name: string;
  /** Kịch bản này có phải là té ngã thật hay không */
  expectFall: boolean;
  /** Có tính vào số liệu độ chính xác phát hiện hay không */
  countInDetection: boolean;
  /** Số lần thử bản kế hoạch đề xuất */
  target: number;
  group: "Không ngã" | "Ngã thật" | "Dễ nhầm" | "Quy trình cảnh báo";
};

export type Settings = {
  /** Địa chỉ ESP32, ví dụ "192.168.1.50" hoặc "canhbao-tenga.local" */
  esp32Host: string;
  /** Chu kỳ dashboard hỏi ESP32 (ms) */
  pollMs: number;
  /**
   * Cách gọi người được chăm sóc trên giao diện và trong câu trả lời, ví dụ
   * "mẹ", "bà", "ông". Để trống thì tự đoán từ tên khai trong firmware.
   */
  elderCall: string;
  /** Giọng đọc cho loa và cho web (xem lib/tts.ts) */
  ttsVoice: string;
  /** Cho dashboard nhận quyền đọc tin Telegram khi đang chạy */
  telegramEnabled: boolean;
};

/** Kết quả gửi lời nhắn xuống loa ESP32 */
export type SpeakStatus =
  | "da-gui" // ESP32 đã nhận file, sẽ phát ngay khi loa rảnh
  | "loa-ban" // loa đang phát thứ khác, đã thử lại mà vẫn bận
  | "dang-canh-bao" // thiết bị đang xử lý nghi ngã / khẩn cấp
  | "mat-ket-noi" // không liên lạc được ESP32
  | "qua-cu" // tin Telegram tới quá muộn, không đọc nữa
  | "loi";

/** Một lượt người nhà tương tác với trợ lý (Telegram hoặc trang web) */
export type Interaction = {
  id: string;
  at: number;
  channel: "telegram" | "web";
  /** hoitham = nhắn qua loa; hoi = hỏi tình hình; lenh = lệnh nhanh; tu-choi = người lạ */
  kind: "hoitham" | "hoi" | "lenh" | "tu-choi";
  from: string;
  chatId: string | null;
  text: string;
  reply: string;
  /** Câu loa đã đọc (chỉ có với hoitham) */
  spokenText: string | null;
  speak: SpeakStatus | null;
  /** Câu trả lời có dùng AI hay chỉ là tóm tắt tự động */
  ai: boolean;
};

/** Trạng thái bot Telegram phía dashboard (hiện ở trang Cài đặt) */
export type TelegramBotInfo = {
  configured: boolean;
  enabled: boolean;
  /** off | cho-thiet-bi | dang-doc | xung-dot | loi-token | loi-mang | firmware-cu */
  state: string;
  detail: string;
  botName: string | null;
  allowedChats: string[];
  lastUpdateAt: number;
  handled: number;
};

/** Gói dữ liệu trả về cho trang giám sát, chỉ cần 1 lần gọi mỗi chu kỳ */
export type LivePayload = {
  online: boolean;
  error: string | null;
  status: Esp32Status | null;
  events: StoredEvent[];
  activeTrial: Trial | null;
  session: Session | null;
  settings: Settings;
  /** Chuỗi biên độ chuyển động gần nhất để vẽ đồ thị nhỏ */
  movementSeries: { t: number; range: number; present: number }[];
  /** Chuỗi sinh hiệu gần nhất (nhịp tim, nhịp thở) để vẽ đồ thị theo thời gian */
  vitalsSeries: { t: number; heartRate: number; breatheValue: number }[];
  storedEventCount: number;
};
