/**
 * Bộ thu thập dữ liệu chạy ở phía máy chủ.
 *
 * Cứ mỗi `pollMs` lại hỏi ESP32 một lần rồi:
 *   - lưu trạng thái mới nhất vào RAM cho trang giám sát dùng;
 *   - ghi thêm các sự kiện mới vào file (lịch sử dài hạn, không bị giới hạn
 *     40 dòng như bộ nhớ flash của ESP32);
 *   - lưu một chuỗi biên độ chuyển động để vẽ đồ thị.
 *
 * Chạy ở máy chủ nghĩa là lịch sử vẫn được ghi kể cả khi không mở trình duyệt.
 * Nếu tắt laptop thì hệ thống cảnh báo vẫn hoạt động bình thường, vì cảnh báo
 * do chính ESP32 gửi qua Telegram / Zalo, không đi qua dashboard.
 */
import { fetchEvents, fetchFeatures, fetchStatus, eventKey, friendlyError } from "./esp32";
import { decodeRow } from "./features";
import { addEvents, addSamples, getSettings, load } from "./store";
import type { Esp32Status, StoredEvent } from "./types";

const SERIES_MAX = 600; // ~15 phút ở chu kỳ 1,5 giây

type PollerState = {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  /** Đang trong một lượt hỏi: tránh hai lượt chạy chồng lên nhau */
  busy: boolean;
  online: boolean;
  error: string | null;
  status: Esp32Status | null;
  lastOkAt: number;
  series: { t: number; range: number; present: number }[];
  /** Chuỗi lịch sử sinh hiệu (nhịp tim, nhịp thở) để vẽ đồ thị theo thời gian */
  vitalsSeries: { t: number; heartRate: number; breatheValue: number }[];
  ticks: number;
  /** Mốc millis() của mẫu đặc trưng mới nhất đã lấy từ firmware */
  lastFeatureT: number;
  featureTotal: number;
  featureSpec: number;
  /** Lời cảnh báo gần nhất khi không lấy được chuỗi đặc trưng (chỉ in một lần) */
  featureWarn: string | null;
};

const g = globalThis as typeof globalThis & {
  __fallPoller?: PollerState;
  /** Do lib/telegram-bot.ts gán: true khi bot muốn giữ quyền đọc tin Telegram */
  __tgWantsLease?: () => boolean;
  /** Do lib/zalo-bot.ts gán: true khi bot muốn giữ quyền đọc tin Zalo */
  __zaloWantsLease?: () => boolean;
};

function state(): PollerState {
  if (!g.__fallPoller) {
    g.__fallPoller = {
      timer: null,
      running: false,
      busy: false,
      online: false,
      error: null,
      status: null,
      lastOkAt: 0,
      series: [],
      vitalsSeries: [],
      ticks: 0,
      lastFeatureT: 0,
      featureTotal: 0,
      featureSpec: 0,
      featureWarn: null,
    };
  }
  return g.__fallPoller;
}

/**
 * Lấy các mẫu đặc trưng mới từ firmware.
 *
 * Firmware đánh dấu thời gian bằng millis() của chính nó, nên con số này quay về
 * 0 mỗi khi ESP32 khởi động lại. Nếu phát hiện mốc "now" nhỏ hơn mốc đã thấy thì
 * coi như thiết bị vừa khởi động lại và hỏi lại từ đầu.
 *
 * Mỗi lần firmware chỉ trả tối đa 150 mẫu, nên khi tụt hậu (dashboard vừa bật)
 * thì hỏi liên tiếp nhiều lượt cho tới khi lấy hết.
 */
async function collectFeatures(host: string): Promise<void> {
  const s = state();
  for (let round = 0; round < 5; round++) {
    const res = await fetchFeatures(host, s.lastFeatureT);
    if (res.now < s.lastFeatureT) {
      // ESP32 vừa khởi động lại -> mốc thời gian đã về 0
      s.lastFeatureT = 0;
      console.log("[poller] ESP32 vua khoi dong lai, hoi lai chuoi dac trung tu dau");
      continue;
    }
    s.featureSpec = res.spec;
    if (res.samples.length === 0) return;

    const now = Date.now();
    const mapped = res.samples.map((row) => decodeRow(row, now));
    await addSamples(mapped);
    s.lastFeatureT = mapped[mapped.length - 1].t;
    s.featureTotal = res.total;

    if (res.samples.length < 150) return;   // đã lấy hết, không cần hỏi tiếp
  }
}

async function tick(schedule: boolean): Promise<void> {
  const s = state();
  if (s.busy) return; // lượt trước chưa xong thì bỏ qua lượt này
  s.busy = true;
  const settings = await getSettings();

  try {
    // Bot Telegram / Zalo của dashboard đang muốn đọc tin -> xin ESP32 nhường quyền.
    // Thời hạn gấp vài lần chu kỳ hỏi để một lượt hỏi trễ không làm hết hạn.
    const leaseS = Math.max(30, Math.ceil((settings.pollMs * 4) / 1000));
    const status = await fetchStatus(
      settings.esp32Host,
      g.__tgWantsLease?.() ? leaseS : 0,
      g.__zaloWantsLease?.() ? leaseS : 0,
    );
    s.status = status;
    s.online = true;
    s.error = null;
    s.lastOkAt = Date.now();

    s.series.push({
      t: Date.now(),
      range: status.radar.range,
      present: status.radar.present ? 1 : 0,
    });
    if (s.series.length > SERIES_MAX) s.series.splice(0, s.series.length - SERIES_MAX);

    // Tích luỹ chuỗi sinh hiệu (nhịp tim, nhịp thở) khi đang bật chế độ theo dõi
    // giấc ngủ và số đo hợp lệ. Giá trị bằng 0 (chưa đo được) thì bỏ qua để đồ
    // thị không bị kéo xuống đáy.
    if (status.vitals?.valid && (status.vitals.heartRate > 0 || status.vitals.breatheValue > 0)) {
      s.vitalsSeries.push({
        t: Date.now(),
        heartRate: status.vitals.heartRate,
        breatheValue: status.vitals.breatheValue,
      });
      if (s.vitalsSeries.length > SERIES_MAX) {
        s.vitalsSeries.splice(0, s.vitalsSeries.length - SERIES_MAX);
      }
    }

    // Hỏi nhật ký mỗi nhịp, không hỏi thưa. Lý do: mốc thời gian của từng lần
    // thử lấy theo lúc dashboard nhận được sự kiện, nên hỏi thưa sẽ làm sai số
    // lớn lên. Mỗi lần hỏi chỉ khoảng 6 KB JSON, ESP32-S3 thừa sức.
    {
      const raw = await fetchEvents(settings.esp32Host);
      const now = Date.now();
      const mapped: StoredEvent[] = raw.map((e) => ({
        key: eventKey(e),
        id: e.id,
        ts: e.ts,
        uptime: e.uptime,
        type: e.type,
        label: e.label,
        src: e.src,
        state: e.state,
        note: e.note ?? "",
        recvAt: now,
      }));
      // Firmware trả về mới nhất đứng đầu; đảo lại để thứ tự ghi tăng dần.
      await addEvents(mapped.reverse());
    }

    // Thu thập chuỗi đặc trưng để huấn luyện model (xem src/lib/train.ts).
    // Bắt lỗi riêng: firmware cũ chưa có /api/features, và việc thiếu chuỗi đặc
    // trưng KHÔNG được làm cả hệ thống bị coi là mất kết nối.
    try {
      await collectFeatures(settings.esp32Host);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (s.featureWarn !== msg) {
        s.featureWarn = msg;
        console.warn("[poller] Khong lay duoc chuoi dac trung:", msg);
      }
    }
  } catch (err) {
    s.online = false;
    s.error = friendlyError(err, settings.esp32Host);
  } finally {
    s.ticks++; // đếm SAU khi có kết quả: bot Telegram chờ lượt đầu xong mới đọc tin
    s.busy = false;
    // Chỉ lượt do bộ đếm thời gian gọi mới hẹn lượt kế tiếp, nhờ vậy pollNow()
    // không tạo ra một chuỗi hẹn giờ thứ hai chạy song song.
    if (schedule && s.running) {
      s.timer = setTimeout(() => void tick(true), settings.pollMs);
    }
  }
}

/** Bật bộ thu thập (gọi nhiều lần cũng chỉ chạy một bộ duy nhất). */
export async function ensurePoller(): Promise<void> {
  const s = state();
  if (s.running) return;
  await load();
  s.running = true;
  void tick(true);
  console.log("[poller] Da bat bo thu thap du lieu tu ESP32");
}

export function stopPoller(): void {
  const s = state();
  s.running = false;
  if (s.timer) clearTimeout(s.timer);
  s.timer = null;
}

export function pollerSnapshot() {
  const s = state();
  return {
    /** Số lượt đã hỏi ESP32 (0 = chưa biết thiết bị online hay không) */
    ticks: s.ticks,
    online: s.online,
    error: s.error,
    status: s.status,
    lastOkAt: s.lastOkAt,
    series: s.series,
    vitalsSeries: s.vitalsSeries,
    featureTotal: s.featureTotal,
    featureSpec: s.featureSpec,
    featureWarn: s.featureWarn,
  };
}

/** Hỏi ESP32 ngay lập tức, không chờ hết chu kỳ (dùng sau khi bấm một thao tác). */
export async function pollNow(): Promise<void> {
  await tick(false);
}
