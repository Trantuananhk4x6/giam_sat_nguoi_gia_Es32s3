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
   * Trạng thái Wi-Fi của thiết bị (chi tiết đầy đủ ở GET /api/wifi/state, xem lib/wifi-types.ts).
   *  - up: đang nối được một mạng Wi-Fi nhà (chế độ station).
   *  - ssid / ip: "-" khi chưa nối.
   *  - saved: số mạng đã lưu trong firmware.
   *  - portal: đang mở Wi-Fi cấu hình (AP + captive portal) để nhập Wi-Fi.
   *  - ap: TÊN (SSID) Wi-Fi cấu hình thiết bị đang phát; "" nếu không phát.
   * Các trường optional do firmware mới bổ sung, để optional cho tương thích ngược.
   */
  wifi: {
    up: boolean;
    ssid: string;
    rssi: number;
    ip: string;
    saved?: number;
    portal?: boolean;
    ap?: string;
    phase?: import("./wifi-types").WifiPhase;
    /** SSID đang thử nối ("" nếu không thử) */
    trying?: string;
    bars?: import("./wifi-types").WifiBars;
    channel?: number;
    apIp?: string;
    apClients?: number;
    attempt?: import("./wifi-types").WifiAttempt | null;
  };
  telegram: {
    pending: number;
    sent: number;
    last: string;
    channels?: string;
    /** Ai đang đọc tin Telegram: off | device | dashboard (firmware mới) */
    poller?: string;
  };
  /** Bot Zalo của firmware (firmware có Zalo Bot mới có trường này) */
  zalo?: {
    /** Ai đang đọc tin Zalo: off | device | dashboard */
    poller?: string;
    /** Số người nhận cảnh báo Zalo khai trong ZALO_CHAT_ID */
    chats?: number;
    /** Kết quả lượt hỏi tin Zalo gần nhất (dò lỗi token) */
    last?: string;
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
  /** Cho dashboard nhận quyền đọc tin Zalo khi đang chạy */
  zaloEnabled: boolean;
  /**
   * Tên người gửi in trước lời nhắn khi người cao tuổi nói với thiết bị
   * "gửi cho Tuấn là …": người nhận thấy  Người thân: "…"
   */
  relayLabel: string;
};

/**
 * Một người trong DANH BẠ NGƯỜI NHÀ. Người cao tuổi nói với thiết bị
 * "gửi cho <tên> là <lời nhắn>" thì lời nhắn tới Telegram + Zalo + email của người này.
 */
export type Contact = {
  id: string;
  /** Tên gọi khi nói, ví dụ "Tuấn" */
  name: string;
  /** Cách gọi khác cũng nhận ra, ví dụ "con trai", "anh Hai" */
  aliases: string[];
  /** Mã chat Telegram (số; nhóm là số âm). Rỗng = không gửi Telegram */
  telegramChatId: string;
  /** Mã chat Zalo Bot (chuỗi chữ số hex, bot báo khi người đó nhắn). Rỗng = không gửi Zalo */
  zaloChatId: string;
  /** Rỗng = không gửi email */
  email: string;
  createdAt: number;
  updatedAt: number;
};

/** Kết quả gửi lời nhắn qua MỘT kênh */
export type Delivery = {
  channel: "telegram" | "zalo" | "email";
  /** Mã chat / địa chỉ email đã gửi tới */
  target: string;
  ok: boolean;
  /** Lý do lỗi dễ hiểu (null khi gửi được) */
  error: string | null;
  /** message_id Telegram (số) / Zalo (chuỗi) trả về, để nhận ra tin trả lời của người nhà */
  messageId?: number | string | null;
};

export type RelayStatus =
  | "da-gui" // mọi kênh đều gửi được
  | "gui-mot-phan" // gửi được ít nhất một kênh, có kênh lỗi
  | "loi" // không kênh nào gửi được
  | "khong-co-ten" // tên không có trong danh bạ
  | "trung-ten" // nhiều người trong danh bạ có tên giống nhau
  | "thieu-loi-nhan" // nói tên nhưng không nói nội dung
  | "chua-co-kenh" // người nhận chưa khai Telegram / Zalo / email
  | "qua-nhieu"; // gửi dồn dập quá giới hạn chống spam

/** Lời nhắn người cao tuổi gửi đi (kèm trong Interaction có kind = "gui-di") */
export type RelayInfo = {
  /** Tên người nhận (theo danh bạ, hoặc tên nghe được nếu không có trong danh bạ) */
  to: string;
  contactId: string | null;
  /** Lời nhắn đúng nguyên văn đã nghe được */
  message: string;
  /** Nguyên văn tin đã gửi, ví dụ  Người thân: "tối nay gọi cho mẹ lúc 8h nhé" */
  sent: string;
  status: RelayStatus;
  delivery: Delivery[];
};

/** Kết quả gửi lời nhắn xuống loa ESP32 */
export type SpeakStatus =
  | "da-gui" // ESP32 đã nhận file, sẽ phát ngay khi loa rảnh
  | "loa-ban" // loa đang phát thứ khác, đã thử lại mà vẫn bận
  | "dang-canh-bao" // thiết bị đang xử lý nghi ngã / khẩn cấp
  | "mat-ket-noi" // không liên lạc được ESP32
  | "qua-cu" // tin Telegram / Zalo tới quá muộn, không đọc nữa
  | "loi";

/**
 * Một lượt tương tác được ghi nhật ký: người nhà nhắn/hỏi (Telegram, Zalo, web)
 * hoặc người cao tuổi nói với thiết bị để gửi lời nhắn cho người nhà.
 */
export type Interaction = {
  id: string;
  at: number;
  /** thiet-bi = người cao tuổi nói với ESP32 (mic) */
  channel: "telegram" | "zalo" | "web" | "thiet-bi";
  /**
   * hoitham = nhắn qua loa; hoi = hỏi tình hình; lenh = lệnh nhanh; tu-choi = người lạ;
   * gui-di = người cao tuổi nhờ thiết bị gửi lời nhắn cho người nhà
   */
  kind: "hoitham" | "hoi" | "lenh" | "tu-choi" | "gui-di";
  from: string;
  chatId: string | null;
  text: string;
  reply: string;
  /** Câu loa đã đọc (chỉ có với hoitham) */
  spokenText: string | null;
  speak: SpeakStatus | null;
  /** Câu trả lời có dùng AI hay chỉ là tóm tắt tự động */
  ai: boolean;
  /** Chỉ có với kind = "gui-di" */
  relay?: RelayInfo | null;
};

/** Trạng thái một bot chat hai chiều phía dashboard (Telegram / Zalo, hiện ở trang Cài đặt) */
export type ChatBotInfo = {
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

/** Giữ tên cũ cho các chỗ đang dùng */
export type TelegramBotInfo = ChatBotInfo;
export type ZaloBotInfo = ChatBotInfo;

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
