"use client";

/**
 * Trang "Wi-Fi thiết bị": xem, quét, lưu và đổi mạng Wi-Fi của ESP32 ngay trên dashboard.
 *
 * Mọi lời gọi đi qua route Next.js (/api/wifi/...) rồi mới sang thiết bị vì firmware không
 * có CORS. Vì vậy trang chỉ điều khiển được thiết bị khi máy chủ dashboard với tới nó; mất
 * liên lạc thì trang chuyển sang hướng dẫn dùng Wi-Fi cấu hình (AP) do thiết bị phát.
 *
 * Theo dõi kết quả kết nối: ngay trước khi gửi lệnh, ghi lại attempt.id hiện tại; sau đó
 * hỏi /api/wifi/state mỗi giây tới khi thấy lần thử có id LỚN HƠN, đúng SSID, do người dùng
 * yêu cầu (user=true — lượt nền cùng SSID bị hủy không tính) và đã có kết quả (khác
 * "trying"), tối đa 40 giây.
 *
 * Đổi mật khẩu mạng ĐANG DÙNG cũng đi đường này: thiết bị ngắt mạng vài giây để thử ngay
 * mật khẩu mới, sai thì tự nối lại bằng mật khẩu cũ (attempt.rolledBack=true).
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowRightLeft,
  Check,
  ChevronDown,
  CirclePause,
  Gauge,
  KeyRound,
  Loader2,
  Lock,
  LockOpen,
  Radio,
  RefreshCw,
  Trash2,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useLive } from "@/components/useLive";
import {
  agoText,
  normalizeState,
  phaseLabel,
  signalText,
  usToMsText,
  type WifiAttempt,
  type WifiResult,
  type WifiSavedNet,
  type WifiScanNet,
  type WifiScanResult,
  type WifiState,
} from "@/lib/wifi-types";
import {
  Badge,
  NetForm,
  NoticeView,
  PendingView,
  ResultBadge,
  SignalBars,
  cx,
  type FormResult,
  type Notice,
} from "./parts";
import styles from "./wifi.module.css";

/** HOSTNAME trong include/config.h — cũng là tên Wi-Fi cấu hình mặc định */
const DEFAULT_HOST = "canhbao-tenga";
const AP_URL = "http://192.168.4.1";
/** Chờ kết quả một lệnh kết nối tối đa bấy nhiêu giây */
const WAIT_MAX_S = 40;
/** Kết quả lần thử tự động (không do bấm trên trang) còn hiện trong bấy nhiêu giây */
const AUTO_RESULT_MAX_S = 120;
const SWITCH_WARNING =
  "Nếu mạng mới khác mạng của máy chạy dashboard, dashboard sẽ mất liên lạc với thiết bị; " +
  "khi đó vào Cài đặt đổi địa chỉ ESP32 sang IP mới.";
/** Hỏi lại trước khi đổi mật khẩu mạng ĐANG DÙNG */
const REKEY_CONFIRM =
  "Thiết bị sẽ ngắt mạng vài giây để thử mật khẩu mới; sai thì tự quay về mật khẩu cũ. " +
  "Dashboard có thể tạm mất liên lạc.";
/** Ghi chú trong biểu mẫu đổi mật khẩu mạng ĐANG DÙNG (firmware mới / firmware cũ) */
const REKEY_NOTE = "Thiết bị sẽ ngắt mạng vài giây để thử ngay mật khẩu mới; sai thì tự quay về mật khẩu cũ.";
const REKEY_NOTE_LEGACY = "Firmware bản cũ: thiết bị dùng ngay mật khẩu mới và không tự quay về mật khẩu cũ nếu sai.";
/** Firmware cũ (chưa có /api/wifi/state) không quay về được mật khẩu cũ */
const REKEY_CONFIRM_LEGACY =
  "Firmware trên thiết bị là bản cũ: thiết bị sẽ dùng ngay mật khẩu mới và KHÔNG tự quay về " +
  "mật khẩu cũ nếu sai — khi đó phải cấu hình lại qua Wi-Fi cấu hình. Vẫn đổi?";

// --------------------------------------------------------------- gọi API ---

type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

/** Gọi route của dashboard; status = 0 khi không gọi được chính máy chủ dashboard */
async function callApi<T>(url: string, method: "GET" | "POST" | "DELETE" = "GET", body?: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      method,
      cache: "no-store",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      const error = (json as { error?: unknown } | null)?.error;
      return { ok: false, status: res.status, error: typeof error === "string" && error ? error : `HTTP ${res.status}` };
    }
    return { ok: true, data: json as T };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: `Không gọi được máy chủ dashboard: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ------------------------------------------------------------ thông báo ---

/** Đang chờ kết quả một lệnh kết nối (lưu & kết nối, hoặc chuyển sang mạng đã lưu) */
type Pending = {
  ssid: string;
  /** attempt.id ngay trước khi gửi lệnh; kết quả hợp lệ phải có id lớn hơn */
  baseId: number;
  startedAt: number;
  /** Đổi sang mạng khác trong lúc dashboard đang liên lạc được -> có thể mất liên lạc */
  switching: boolean;
  /** Mạng thiết bị đang dùng lúc gửi lệnh ("" = chưa có mạng): hỏng thì firmware quay về đây */
  from: string;
  /** Đổi mật khẩu mạng ĐANG DÙNG: thiết bị ngắt mạng để thử ngay, sai thì giữ mật khẩu cũ */
  rekey: boolean;
  /** Firmware đã nhận lệnh (hoặc mất liên lạc ngay sau khi gửi) */
  sent: boolean;
};

/**
 * Lần thử `a` có phải KẾT QUẢ của lệnh đang chờ không: id lớn hơn mốc ghi lúc gửi lệnh,
 * đúng SSID, đã xong (khác "trying") và do người dùng yêu cầu (user=true). Lượt nền cùng
 * SSID bị hủy trong lúc nhận lệnh có user=false nên không bị nhận nhầm. rolledBack=true
 * cũng được nhận: chỉ lệnh đổi mật khẩu của người dùng mới sinh ra lượt quay về mật khẩu
 * cũ, kể cả khi firmware ghi cờ này lên lượt nối lại (user=false) sau đó.
 */
function isCommandResult(a: WifiAttempt, p: Pending): boolean {
  if (a.id <= p.baseId || a.ssid !== p.ssid || a.result === "trying") return false;
  return a.user === true || a.rolledBack;
}

const RESULT_TEXT: Record<WifiResult, string> = {
  ok: "Thiết bị đã vào mạng.",
  trying: "Thiết bị đang thử kết nối.",
  wrong_pass: "Bộ phát Wi-Fi từ chối mật khẩu.",
  not_found: "Thiết bị không bắt được sóng của mạng này.",
  timeout: "Bộ phát Wi-Fi không trả lời kịp.",
  fail: "Không kết nối được.",
};

/**
 * Đổi mật khẩu mạng đang dùng mà hỏng, firmware đã quay về mật khẩu cũ: thiết bị vẫn chạy
 * bình thường nên báo vàng (warn), không báo lỗi đỏ.
 */
function rollbackNotice(a: WifiAttempt): Notice {
  // Không bắt được sóng / hết giờ / bị hủy: mật khẩu mới chưa hẳn sai, chỉ là chưa đổi được.
  const wrong = a.result === "wrong_pass";
  return {
    tone: "warn",
    title: wrong
      ? "Mật khẩu mới không đúng — thiết bị vẫn dùng mật khẩu cũ"
      : "Chưa đổi được mật khẩu — thiết bị vẫn dùng mật khẩu cũ",
    text: a.text || `Wi-Fi “${a.ssid}”: thiết bị đã giữ lại mật khẩu cũ.`,
    hint: wrong
      ? "Thiết bị vẫn hoạt động bình thường. Kiểm tra lại mật khẩu mới (phân biệt chữ hoa/thường) rồi thử lại."
      : "Thiết bị vẫn hoạt động bình thường với mật khẩu cũ; có thể thử lại sau.",
  };
}

/** Kết quả của lệnh đang chờ (đã qua isCommandResult) */
function resultNotice(a: WifiAttempt, p: Pending): Notice {
  if (p.rekey && a.result === "ok" && !a.rolledBack) {
    return { tone: "ok", title: `Đã đổi mật khẩu “${a.ssid}”`, text: "Thiết bị đã vào lại mạng bằng mật khẩu mới." };
  }
  const n = noticeFromAttempt(a);
  // Chuyển mạng mà hỏng: firmware tự thử nhanh lại mạng đang dùng lúc gửi lệnh.
  if (a.result !== "ok" && p.from && p.from !== a.ssid) {
    return { ...n, text: [n.text, `Thiết bị đang quay về mạng “${p.from}”.`].filter(Boolean).join(" ") };
  }
  return n;
}

/**
 * Đổi mật khẩu: không đọc kịp lượt thử của người dùng, chỉ thấy firmware đã tự nối lại mạng
 * này sau đó (lượt nền). Mật khẩu mới đúng thì không có lượt nền nào theo sau, nên nhiều khả
 * năng đã lùi về mật khẩu cũ — nhưng chưa chắc, nên báo trung tính.
 */
function rekeyMissNotice(ssid: string): Notice {
  return {
    tone: "info",
    title: `Thiết bị đã nối lại “${ssid}”`,
    text:
      "Không đọc kịp kết quả thử mật khẩu mới vì thiết bị rời mạng suốt lượt thử. Thiết bị đã tự nối lại " +
      "sau đó — nhiều khả năng mật khẩu mới không dùng được nên thiết bị đã quay về mật khẩu cũ.",
    hint: "Muốn đổi mật khẩu thì kiểm tra lại mật khẩu mới (phân biệt chữ hoa/thường) rồi thử lại.",
  };
}

/** Chuyển mạng hỏng, không rõ lý do (firmware đã lùi mật khẩu nên "last" không còn), đã về mạng cũ */
function fellBackNotice(ssid: string, prev: string): Notice {
  return {
    tone: "warn",
    title: `Không chuyển được sang “${ssid}”`,
    text: `Thiết bị đã quay về mạng “${prev}”.`,
    hint:
      "Kiểm tra lại mật khẩu (phân biệt chữ hoa/thường) và sóng của mạng này rồi thử lại. Nếu vừa nhập " +
      "mật khẩu mới, thiết bị đã giữ lại mật khẩu cũ.",
  };
}

/** Đổi mật khẩu: hết giờ chờ trong lúc mất liên lạc — báo trung tính */
function rekeyLostNotice(ssid: string): Notice {
  return {
    tone: "info",
    title: `Chưa liên lạc lại được với thiết bị sau ${WAIT_MAX_S} giây`,
    text:
      `Thiết bị đang thử mật khẩu mới của “${ssid}”; nếu sai, thiết bị tự quay về mật khẩu cũ và nối lại ` +
      "mạng này. Trang sẽ tự cập nhật khi liên lạc lại.",
  };
}

function noticeFromAttempt(a: WifiAttempt, fellBackTo = ""): Notice {
  if (a.rolledBack) return rollbackNotice(a);
  const name = `“${a.ssid}”`;
  const text = [a.text || RESULT_TEXT[a.result], fellBackTo ? `Thiết bị đã quay về mạng “${fellBackTo}”.` : ""]
    .filter(Boolean)
    .join(" ");
  switch (a.result) {
    case "ok":
      return { tone: "ok", title: `Đã kết nối ${name}`, text };
    case "wrong_pass":
      return {
        tone: "bad",
        title: `Sai mật khẩu Wi-Fi ${name}`,
        text,
        hint: "Kiểm tra lại mật khẩu (phân biệt chữ hoa/thường), rồi chọn mạng trong danh sách và bấm “Đổi mật khẩu”.",
      };
    case "not_found":
      return {
        tone: "warn",
        title: `Không thấy mạng ${name}`,
        text,
        hint:
          "ESP32 chỉ bắt được Wi-Fi 2,4 GHz. Nếu bộ phát gộp chung 2,4 GHz với 5 GHz, hãy bật hoặc tách riêng " +
          "băng 2,4 GHz; hoặc đưa thiết bị lại gần bộ phát.",
      };
    case "timeout":
      return {
        tone: "warn",
        title: `Hết thời gian chờ khi kết nối ${name}`,
        text,
        hint: "Sóng có thể quá yếu hoặc bộ phát chưa cấp địa chỉ IP. Thử lại, hoặc đưa thiết bị lại gần bộ phát.",
      };
    case "trying":
      return { tone: "info", title: `Đang thử kết nối ${name}…`, text };
    default:
      return {
        tone: "bad",
        title: `Không kết nối được ${name}`,
        text,
        hint: a.reason ? `Mã lý do của ESP-IDF: ${a.reason}.` : undefined,
      };
  }
}

/** Mất liên lạc khi đang chuyển mạng: báo trung tính, không phải lỗi */
function lostNotice(ssid: string, timedOut: boolean): Notice {
  return {
    tone: "info",
    title: timedOut
      ? `Chưa liên lạc lại được với thiết bị sau ${WAIT_MAX_S} giây`
      : `Thiết bị đang chuyển sang “${ssid}” nên tạm mất liên lạc`,
    text: timedOut
      ? `Có thể thiết bị đã vào “${ssid}” nhưng mạng này khác mạng của máy chạy dashboard — khi đó đây là điều bình thường.`
      : "Trang sẽ tự cập nhật khi liên lạc lại được.",
    hint:
      "Nếu thiết bị đã sang mạng khác: cho máy chạy dashboard vào cùng mạng đó rồi vào Cài đặt đổi địa chỉ ESP32 " +
      "sang IP mới (xem IP trên cổng serial hoặc trang quản lý của bộ phát Wi-Fi).",
    link: { href: "/cai-dat", label: "Mở Cài đặt →" },
  };
}

function mmss(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ================================================================ trang ===

export default function WifiPage() {
  const { data, netError, refresh } = useLive(2000);
  const online = data?.online ?? false;
  const status = data?.status ?? null;

  const [ws, setWs] = useState<WifiState | null>(null);
  const [wsAt, setWsAt] = useState(0);
  /** Firmware cũ chưa có /api/wifi/state (404) */
  const [legacy, setLegacy] = useState(false);
  const [scan, setScan] = useState<WifiScanResult | null>(null);
  const [scanAt, setScanAt] = useState(0);
  const [scanErr, setScanErr] = useState<string | null>(null);
  const [scanLoading, setScanLoading] = useState(false);
  const [saved, setSaved] = useState<WifiSavedNet[] | null>(null);
  const [savedErr, setSavedErr] = useState<string | null>(null);
  /** Dòng đang mở biểu mẫu: "scan:<ssid>" hoặc "saved:<ssid>" */
  const [openRow, setOpenRow] = useState<string | null>(null);
  /** Dòng (mạng đã lưu) đang ở chế độ đổi mật khẩu */
  const [changing, setChanging] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  /** id lần thử tự động người dùng đã ẩn thông báo */
  const [dismissedId, setDismissedId] = useState(-1);
  const [apName, setApName] = useState(DEFAULT_HOST);
  const [now, setNow] = useState(() => Date.now());

  const pendingRef = useRef<Pending | null>(null);
  const onlineRef = useRef(online);
  const scanTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoScanned = useRef(false);
  /** "<attempt.id>|<result>" của lượt mạng khác đã đối chiếu với /api/wifi/list */
  const listCheckedKey = useRef("");
  /** Nút mở biểu mẫu của từng dòng, để trả focus về đó khi đóng biểu mẫu */
  const toggles = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);
  useEffect(() => {
    onlineRef.current = online;
    // Thiết bị khởi động lại (có thể vừa nạp firmware mới) -> kiểm tra lại API.
    if (!online) setLegacy(false);
  }, [online]);
  // Đồng hồ 1 giây: đếm giây đang thử, đếm ngược AP, tuổi kết quả quét.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(
    () => () => {
      if (scanTimer.current) clearTimeout(scanTimer.current);
    },
    [],
  );

  /** Trạng thái hiển thị: ưu tiên /api/wifi/state, thiếu thì dùng khối wifi của /api/status */
  const view = useMemo<WifiState | null>(
    () => ws ?? (status?.wifi ? normalizeState(status.wifi) : null),
    [ws, status],
  );
  useEffect(() => {
    if (view?.ap) setApName(view.ap);
  }, [view?.ap]);

  // ------------------------------------------------------------ tải dữ liệu

  const loadState = useCallback(async (): Promise<WifiState | null> => {
    const r = await callApi<WifiState>("/api/wifi/state");
    if (r.ok) {
      setWs(r.data);
      setWsAt(Date.now());
      setLegacy(false);
      return r.data;
    }
    if (r.status === 404) {
      setLegacy(true);
      setWs(null);
    }
    return null;
  }, []);

  const loadSaved = useCallback(async (): Promise<WifiSavedNet[] | null> => {
    const r = await callApi<WifiSavedNet[]>("/api/wifi/list");
    if (r.ok) {
      setSaved(r.data);
      setSavedErr(null);
      return r.data;
    }
    setSavedErr(r.error);
    return null;
  }, []);

  const loadScan = useCallback(async (fresh: boolean): Promise<WifiScanResult | null> => {
    if (scanTimer.current) {
      clearTimeout(scanTimer.current);
      scanTimer.current = null;
    }
    setScanLoading(true);
    const r = await callApi<WifiScanResult>(`/api/wifi/scan${fresh ? "?fresh=1" : ""}`);
    setScanLoading(false);
    if (!r.ok) {
      setScanErr(r.error);
      return null;
    }
    setScan(r.data);
    setScanAt(Date.now());
    setScanErr(null);
    // Firmware quét không chặn: còn đang quét thì hỏi lại sau ~1,2 s.
    if (r.data.scanning) {
      scanTimer.current = setTimeout(() => {
        if (onlineRef.current) void loadScan(false);
      }, 1200);
    }
    return r.data;
  }, []);

  // Hỏi /api/wifi/state: mỗi 1 s khi đang chờ kết quả / đang nối, 4 s lúc bình thường;
  // dừng khi mất liên lạc (useLive vẫn chạy và sẽ bật lại khi thiết bị online).
  const waiting = pending !== null;
  const fast = waiting || view?.phase === "connecting";
  useEffect(() => {
    if (!online || legacy) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => {
      await loadState();
      if (alive) timer = setTimeout(loop, fast ? 1000 : 4000);
    };
    void loop();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [online, legacy, fast, loadState]);

  // Danh sách đã lưu: tải khi online và mỗi khi lần thử / mạng đang dùng / số mạng thay đổi.
  const savedKey = `${view?.attempt?.id ?? ""}|${view?.attempt?.result ?? ""}|${view?.ssid ?? ""}|${view?.saved ?? ""}`;
  useEffect(() => {
    if (online) void loadSaved();
  }, [online, savedKey, loadSaved]);

  // Tự quét khi vào trang lúc thiết bị online: hiện ngay kết quả gần nhất, cũ quá thì quét lại.
  useEffect(() => {
    if (!online || autoScanned.current) return;
    autoScanned.current = true;
    void (async () => {
      const r = await loadScan(false);
      if (r && !r.scanning && (r.age < 0 || r.age > 20)) await loadScan(true);
    })();
  }, [online, loadScan]);

  // --------------------------------------------------------- chờ kết quả

  const finish = useCallback(
    (n: Notice, attemptId?: number) => {
      setPending(null);
      setNotice(n);
      if (attemptId !== undefined) setDismissedId(attemptId);
      void loadSaved();
      void refresh();
    },
    [loadSaved, refresh],
  );

  useEffect(() => {
    if (!pending?.sent) return;
    const a = ws?.attempt;
    if (a && isCommandResult(a, pending)) {
      finish(resultNotice(a, pending), a.id);
      return;
    }
    if (a && a.id > pending.baseId) {
      // Lượt thử của người dùng thường KHÔNG đọc được: thiết bị rời mạng của dashboard suốt
      // lượt thử, và ngay khi hỏng firmware đã thử nhanh lại (lượt nền, user=false) — mật
      // khẩu cũ cùng mạng (đổi mật khẩu) hoặc mạng vừa dùng (chuyển mạng) — ghi đè kết quả.
      // Chỉ suy từ lượt nền đã NỐI ĐƯỢC và xong ít nhất 2 s sau khi gửi lệnh, để lượt nền
      // cũ bị hủy lúc nhận lệnh không bị tính.
      const lateOk = !a.user && a.result === "ok" && wsAt - a.ago * 1000 - pending.startedAt >= 2000;
      if (pending.rekey) {
        if (a.ssid === pending.ssid && lateOk) finish(rekeyMissNotice(a.ssid), a.id);
        return;
      }
      const key = `${a.id}|${a.result}`;
      if (a.ssid !== pending.ssid && listCheckedKey.current !== key) {
        // Firmware đã sang thử mạng khác (thường là quay về mạng cũ sau khi thất bại):
        // kết quả lần thử mạng mới còn ghi ở /api/wifi/list (last, lastAgo) — trừ khi
        // firmware đã lùi mật khẩu mới (khi đó "last" được trả về kết quả cũ).
        listCheckedKey.current = key;
        const p = pending;
        const backOnPrev = lateOk && p.from !== "" && a.ssid === p.from;
        void loadSaved().then((list) => {
          if (pendingRef.current !== p) return;
          const n = list?.find((x) => x.ssid === p.ssid);
          const elapsed = (Date.now() - p.startedAt) / 1000;
          if (n && n.last && n.last !== "trying" && n.lastAgo >= 0 && n.lastAgo <= elapsed + 3) {
            const fake: WifiAttempt = {
              id: a.id,
              ssid: p.ssid,
              result: n.last,
              reason: 0,
              text: "",
              ago: n.lastAgo,
              user: true,
              rolledBack: false,
            };
            finish(noticeFromAttempt(fake, a.ssid), a.id);
          } else if (backOnPrev) {
            finish(fellBackNotice(p.ssid, a.ssid), a.id);
          }
        });
      }
    }
    // Firmware cũ không có attempt: coi là xong khi thấy đã nối đúng mạng.
    if (legacy && !pending.rekey && status?.wifi.up && status.wifi.ssid === pending.ssid) {
      finish({ tone: "ok", title: `Đã kết nối “${pending.ssid}”` });
    }
  }, [ws, wsAt, status, legacy, pending, finish, loadSaved]);

  useEffect(() => {
    if (!pending?.sent || now - pending.startedAt < WAIT_MAX_S * 1000) return;
    finish(
      onlineRef.current
        ? {
            tone: "warn",
            title: pending.rekey
              ? `Chưa có kết quả kiểm tra mật khẩu mới của “${pending.ssid}” sau ${WAIT_MAX_S} giây`
              : `Chưa có kết quả kết nối “${pending.ssid}” sau ${WAIT_MAX_S} giây`,
            text: "Thiết bị có thể vẫn đang thử. Xem trạng thái phía trên và huy hiệu trong “Mạng đã lưu”.",
          }
        : pending.rekey
          ? rekeyLostNotice(pending.ssid)
          : lostNotice(pending.ssid, true),
    );
  }, [now, pending, finish]);

  // --------------------------------------------------------------- thao tác

  function closePanel() {
    const key = openRow;
    setOpenRow(null);
    setChanging(null);
    if (key) requestAnimationFrame(() => toggles.current.get(key)?.focus());
  }

  function toggleRow(key: string) {
    setChanging(null);
    setOpenRow((cur) => (cur === key ? null : key));
  }

  /**
   * Lệnh có chuyển mạng: cảnh báo -> ghi attempt.id hiện tại -> gửi -> theo dõi kết quả.
   * rekey=true: đổi mật khẩu mạng ĐANG DÙNG (thiết bị ngắt mạng để thử ngay, sai thì quay
   * về mật khẩu cũ). done=true nghĩa là firmware đã nhận lệnh (kết quả hiện ở khung trạng thái).
   */
  async function startConnect(
    ssid: string,
    request: () => Promise<ApiResult<{ connecting?: boolean } | null>>,
    rekey = false,
  ): Promise<FormResult> {
    const switching = !rekey && !(view?.up && view.ssid === ssid);
    if (rekey) {
      const q = `Lưu và kiểm tra mật khẩu mới cho mạng đang dùng “${ssid}”?`;
      if (!confirm(`${q}\n\n${legacy ? REKEY_CONFIRM_LEGACY : REKEY_CONFIRM}`)) return { done: false };
    } else if (switching) {
      const q = view?.up
        ? `Chuyển thiết bị từ “${view.ssid}” sang “${ssid}”?`
        : `Kết nối thiết bị vào mạng “${ssid}”?`;
      if (!confirm(`${q}\n\n${SWITCH_WARNING}`)) return { done: false };
    }
    setBusy(true);
    setNotice(null);
    if (rekey && legacy) {
      // Firmware cũ không báo kết quả từng lượt thử: gửi xong là báo, không theo dõi.
      const r = await request();
      setBusy(false);
      if (!r.ok && r.status !== 502) return { done: false, error: r.error };
      setNotice({
        tone: "info",
        title: `Đã gửi mật khẩu mới của “${ssid}” xuống thiết bị`,
        text: "Firmware bản cũ không báo kết quả thử. Nếu thiết bị mất mạng, cấu hình lại qua Wi-Fi cấu hình.",
      });
      void loadSaved();
      return { done: true };
    }
    const fresh = legacy ? null : await loadState();
    const baseId = (fresh ?? ws)?.attempt?.id ?? -1;
    const from = view?.up ? view.ssid : "";
    const p: Pending = { ssid, baseId, startedAt: Date.now(), switching, from, rekey, sent: false };
    listCheckedKey.current = "";
    setPending(p);
    const r = await request();
    setBusy(false);
    if (r.ok) {
      if (r.data?.connecting === false) {
        setPending(null);
        setNotice(
          rekey
            ? {
                tone: "warn",
                title: `Đã lưu mật khẩu mới của “${ssid}” nhưng thiết bị chưa thử`,
                text: "Thiết bị sẽ dùng mật khẩu này ở lần nối lại tới.",
              }
            : { tone: "ok", title: `Đã lưu “${ssid}”`, text: "Thiết bị chưa chuyển sang mạng này." },
        );
      } else {
        setPending({ ...p, sent: true, startedAt: Date.now() });
      }
      void loadSaved();
      return { done: true };
    }
    if (r.status === 502 && (switching || rekey)) {
      // Firmware có thể đã nhận lệnh rồi rời mạng (chuyển mạng / thử mật khẩu mới) trước khi
      // kịp trả lời: tiếp tục theo dõi và báo trung tính thay vì báo lỗi.
      setPending({ ...p, sent: true });
      return { done: true };
    }
    setPending(null);
    return { done: false, error: r.error };
  }

  /**
   * Gửi từ biểu mẫu: connect=true -> lưu & chuyển / kết nối; false -> chỉ lưu.
   * Mạng ĐANG DÙNG luôn đi đường kiểm tra: firmware thử ngay mật khẩu mới (kể cả connect=0)
   * và quay về mật khẩu cũ nếu sai, nên phải hỏi lại và theo dõi lượt thử như lệnh kết nối.
   */
  async function submitNet(ssid: string, pass: string, connect: boolean, wasSaved: boolean): Promise<FormResult> {
    const rekey = Boolean(view?.up && view.ssid === ssid);
    if (connect || rekey) {
      const r = await startConnect(ssid, () => callApi("/api/wifi", "POST", { ssid, pass, connect: true }), rekey);
      if (r.done) closePanel();
      return r;
    }
    setBusy(true);
    const baseId = ws?.attempt?.id ?? -1;
    const r = await callApi<{ connecting?: boolean }>("/api/wifi", "POST", { ssid, pass, connect: false });
    setBusy(false);
    if (!r.ok) return { done: false, error: r.error };
    if (r.data?.connecting) {
      // Thiết bị đang không có mạng nên firmware vẫn tự thử mạng vừa lưu -> theo dõi như lệnh kết nối.
      listCheckedKey.current = "";
      setPending({ ssid, baseId, startedAt: Date.now(), switching: false, from: "", rekey: false, sent: true });
    } else {
      setNotice({
        tone: "ok",
        title: wasSaved ? `Đã đổi mật khẩu “${ssid}”` : `Đã lưu “${ssid}”`,
        text: view?.up
          ? `Thiết bị vẫn dùng mạng “${view.ssid}”. Bấm “Chuyển sang” trong “Mạng đã lưu” khi cần.`
          : undefined,
      });
    }
    closePanel();
    void loadSaved();
    return { done: true };
  }

  async function connectSaved(ssid: string) {
    const r = await startConnect(ssid, () => callApi("/api/wifi/connect", "POST", { ssid }));
    if (r.done) closePanel();
    else if (r.error) setNotice({ tone: "bad", title: `Không chuyển được sang “${ssid}”`, text: r.error });
  }

  async function removeNet(n: WifiSavedNet) {
    const extra = n.current
      ? "\n\nĐây là mạng thiết bị ĐANG DÙNG: thiết bị có thể rời mạng này rồi tự tìm mạng đã lưu khác " +
        "(hoặc bật Wi-Fi cấu hình), nên dashboard có thể mất liên lạc."
      : "";
    if (!confirm(`Xóa mạng đã lưu “${n.ssid}” khỏi thiết bị?${extra}`)) return;
    setBusy(true);
    const r = await callApi("/api/wifi", "DELETE", { ssid: n.ssid });
    setBusy(false);
    if (r.ok) {
      setNotice({ tone: "ok", title: `Đã xóa “${n.ssid}” khỏi thiết bị` });
      if (openRow === `saved:${n.ssid}`) closePanel();
    } else if (n.current && r.status === 502) {
      setNotice({
        tone: "info",
        title: "Thiết bị tạm mất liên lạc sau khi xóa mạng đang dùng",
        text: "Trang sẽ tự cập nhật khi liên lạc lại được.",
      });
    } else {
      setNotice({ tone: "bad", title: `Không xóa được “${n.ssid}”`, text: r.error });
    }
    void loadSaved();
    if (!legacy) void loadState();
  }

  async function setPortal(on: boolean) {
    if (
      on &&
      !confirm(
        `Bật Wi-Fi cấu hình “${apName}”?\n\nThiết bị phát thêm Wi-Fi riêng để điện thoại nối vào trang cấu hình ` +
          `(${AP_URL}). Thiết bị vẫn giữ mạng hiện tại; Wi-Fi cấu hình tự tắt sau một lúc.`,
      )
    ) {
      return;
    }
    if (
      !on &&
      !view?.up &&
      !confirm(
        "Thiết bị chưa có mạng Wi-Fi nhà. Tắt Wi-Fi cấu hình thì điện thoại không vào trang cấu hình được nữa, " +
          "và dashboard có thể mất liên lạc nếu đang nối qua Wi-Fi này. Vẫn tắt?",
      )
    ) {
      return;
    }
    setBusy(true);
    const r = await callApi<{ portal?: boolean }>("/api/wifi/portal", "POST", { on });
    setBusy(false);
    if (r.ok) {
      const isOn = r.data?.portal ?? on;
      setNotice({ tone: "ok", title: isOn ? `Đã bật Wi-Fi cấu hình “${apName}”` : "Đã tắt Wi-Fi cấu hình" });
    } else if (!on && !view?.up && r.status === 502) {
      // Dashboard đang nối qua chính Wi-Fi cấu hình: tắt xong là mất liên lạc, không phải lỗi.
      setNotice({
        tone: "info",
        title: "Thiết bị tạm mất liên lạc sau khi tắt Wi-Fi cấu hình",
        text: "Nếu máy chạy dashboard đang nối qua Wi-Fi cấu hình thì đây là điều bình thường.",
      });
    } else {
      setNotice({ tone: "bad", title: on ? "Không bật được Wi-Fi cấu hình" : "Không tắt được Wi-Fi cấu hình", text: r.error });
    }
    if (!legacy) void loadState();
  }

  // ------------------------------------------------------------- dẫn xuất

  const locked = busy || waiting || !online;
  const deviceUp = Boolean(view?.up);
  const rekeyNote = legacy ? REKEY_NOTE_LEGACY : REKEY_NOTE;
  const currentSsid = view?.up ? view.ssid : "";
  const savedSet = useMemo(() => (saved ? new Set(saved.map((s) => s.ssid)) : null), [saved]);
  const nets = useMemo<WifiScanNet[]>(() => {
    const list = scan?.nets ?? [];
    // Mạng đang dùng lên đầu, còn lại xếp theo sóng mạnh -> yếu.
    return [...list].sort((a, b) => Number(b.ssid === currentSsid) - Number(a.ssid === currentSsid) || b.rssi - a.rssi);
  }, [scan, currentSsid]);
  const savedSorted = useMemo(
    () => (saved ? [...saved].sort((a, b) => Number(b.current) - Number(a.current)) : null),
    [saved],
  );
  const scanning = Boolean(scan?.scanning) || scanLoading;
  const scanAge = scan && scan.age >= 0 ? scan.age + Math.max(0, Math.floor((now - scanAt) / 1000)) : -1;
  const max = view?.max ?? 0;
  const full = max > 0 && (saved?.length ?? 0) >= max;
  const hostname = view?.hostname || DEFAULT_HOST;
  const closesLeft =
    ws?.portal && ws.closesIn > 0 ? Math.max(0, ws.closesIn - Math.floor((now - wsAt) / 1000)) : 0;

  // ---------------------------------------------------- thẻ trạng thái lớn

  const tryingSsid = view ? view.trying || (view.attempt?.result === "trying" ? view.attempt.ssid : "") : "";
  const connecting = online && view !== null && (view.phase === "connecting" || tryingSsid !== "");
  const connectingTo = tryingSsid || pending?.ssid || "";

  let tone: "ok" | "warn" | "bad" | "idle" = "idle";
  let icon: ReactNode = <Loader2 size={28} className={styles.spin} aria-hidden />;
  let title = "Đang tải trạng thái…";
  let detail: ReactNode = null;
  if (data && !online) {
    tone = "bad";
    icon = <WifiOff size={28} aria-hidden />;
    title = "Không liên lạc được với thiết bị";
    detail = (
      <>
        Máy chủ dashboard không gọi được thiết bị qua mạng: thiết bị có thể đang tắt, đang chuyển mạng, hoặc đã
        sang mạng khác với máy chạy dashboard.
        {data.error && <small>{data.error}</small>}
      </>
    );
  } else if (data && view) {
    if (connecting) {
      tone = "warn";
      const rekeying = Boolean(pending?.rekey && connectingTo === pending.ssid);
      title = rekeying
        ? `Đang thử mật khẩu mới của “${connectingTo}”…`
        : connectingTo
          ? `Đang kết nối “${connectingTo}”…`
          : "Đang kết nối…";
      detail = rekeying
        ? "Thiết bị tạm ngắt mạng vài giây để thử; sai thì tự nối lại bằng mật khẩu cũ."
        : "Thiết bị thường cần 5–20 giây để vào mạng.";
    } else if (view.up) {
      tone = "ok";
      icon = <Wifi size={28} aria-hidden />;
      title = `Đã kết nối “${view.ssid}”`;
      detail = view.portal ? `Đồng thời đang phát Wi-Fi cấu hình “${view.ap || apName}”.` : null;
    } else if (view.portal) {
      tone = "warn";
      icon = <Radio size={28} aria-hidden />;
      title = "Chưa có mạng — đang phát Wi-Fi cấu hình";
      detail = `Nối điện thoại vào Wi-Fi “${view.ap || apName}” rồi mở ${
        view.apIp ? `http://${view.apIp}` : AP_URL
      }, hoặc chọn mạng ngay bên dưới.`;
    } else {
      tone = "bad";
      icon = <WifiOff size={28} aria-hidden />;
      title = "Chưa có mạng Wi-Fi";
      detail = `${phaseLabel(view.phase)}. Không nối được mạng đã lưu nào thì thiết bị tự bật Wi-Fi cấu hình.`;
    }
  } else if (data) {
    title = "Đang đọc trạng thái Wi-Fi…";
  }
  const toneClass = { ok: styles.toneOk, warn: styles.toneWarn, bad: styles.toneBad, idle: "" }[tone];

  const statusCard = (
    <section className={cx("card", styles.status, toneClass)} aria-labelledby="wifi-status-h">
      <div className={styles.statusIcon}>{icon}</div>
      <div className={styles.statusBody}>
        <h2 id="wifi-status-h" className={styles.statusHead}>
          Wi-Fi của thiết bị
        </h2>
        <p className={styles.statusTitle}>{title}</p>
        {detail && <p className={styles.statusDetail}>{detail}</p>}
        {online && view?.up && !connecting && (
          <ul className={styles.chips} aria-label="Thông số kết nối">
            <li className={styles.chip}>
              <SignalBars bars={view.bars} rssi={view.rssi} small decorative />
              {signalText(view.bars)} · {view.rssi} dBm
            </li>
            {view.ip && <li className={styles.chip}>IP {view.ip}</li>}
            {view.channel > 0 && <li className={styles.chip}>Kênh {view.channel}</li>}
            <li className={styles.chip}>
              <a href={`http://${hostname}.local`} target="_blank" rel="noreferrer">
                http://{hostname}.local<span className={styles.srOnly}> (mở thẻ mới)</span>
              </a>
            </li>
            {view.portal && (
              <li className={styles.chip}>
                <Radio size={14} aria-hidden /> Đang phát Wi-Fi cấu hình
              </li>
            )}
          </ul>
        )}
        {online && view?.paused && (
          <p className={styles.pausedNote}>
            <CirclePause size={16} aria-hidden />
            <span>
              {`Thiết bị đang tạm dừng tự nối mạng vì có người đang dùng trang cấu hình qua Wi-Fi “${
                view.ap || apName
              }” (để điện thoại không bị rớt khỏi trang).`}
            </span>
          </p>
        )}
        {online && view && view.loopMaxUs > 0 && (
          <p className={styles.tech}>
            <Gauge size={13} aria-hidden />
            Vòng lặp Wi-Fi tối đa {usToMsText(view.loopMaxUs)} (khoảng 60 giây gần nhất)
          </p>
        )}
      </div>
    </section>
  );

  // --------------------------------------------------------- khung kết quả

  const att = view?.attempt ?? null;
  const attAge = att ? att.ago + (ws ? Math.max(0, Math.floor((now - wsAt) / 1000)) : 0) : 0;
  const autoAttempt =
    !pending &&
    !notice &&
    online &&
    att &&
    att.id !== dismissedId &&
    att.result !== "trying" &&
    att.result !== "ok" &&
    attAge <= AUTO_RESULT_MAX_S
      ? att
      : null;

  let live: ReactNode = null;
  if (pending) {
    const secs = Math.max(0, Math.floor((now - pending.startedAt) / 1000));
    const tryingThis =
      att && att.id > pending.baseId && att.ssid === pending.ssid && att.user && att.result === "trying";
    const text = !pending.sent
      ? "Đang gửi lệnh tới thiết bị…"
      : !online
        ? pending.rekey
          ? "Thiết bị tạm ngắt mạng để thử mật khẩu mới nên dashboard tạm mất liên lạc — bình thường. " +
            "Trang sẽ tự cập nhật khi liên lạc lại."
          : "Thiết bị tạm mất liên lạc — bình thường khi đang chuyển mạng. Trang sẽ tự cập nhật khi liên lạc lại."
        : tryingThis && att.text
          ? att.text
          : pending.rekey
            ? "Thiết bị cần vài giây để thử mật khẩu mới; sai thì tự nối lại bằng mật khẩu cũ."
            : "Thiết bị thường cần 5–20 giây để vào mạng.";
    const pendingTitle = pending.rekey
      ? `Đang kiểm tra mật khẩu mới của “${pending.ssid}”…`
      : `Đang kết nối “${pending.ssid}”…`;
    live = <PendingView title={pendingTitle} detail={text} seconds={secs} />;
  } else if (notice) {
    live = <NoticeView notice={notice} onClose={() => setNotice(null)} />;
  } else if (autoAttempt) {
    const n = noticeFromAttempt(autoAttempt);
    live = (
      <NoticeView
        notice={{ ...n, text: `${autoAttempt.user ? "" : "Lần thử tự động của thiết bị. "}${n.text ?? ""}` }}
        onClose={() => setDismissedId(autoAttempt.id)}
      />
    );
  }

  // ------------------------------------------------------ mạng xung quanh

  function scanPanel(n: WifiScanNet, key: string, isCurrent: boolean, isSaved: boolean) {
    if ((isSaved || isCurrent) && changing !== key) {
      const canSwitch = !isCurrent && !legacy;
      return (
        <>
          <p className={styles.panelText}>
            {isCurrent ? "Thiết bị đang dùng mạng này." : "Mạng này đã lưu trong thiết bị."}
            {!n.enc && " Mạng mở nên không có mật khẩu để đổi."}
          </p>
          {(canSwitch || n.enc) && (
            <div className="btns">
              {canSwitch && (
                <button type="button" className="b-main" onClick={() => void connectSaved(n.ssid)} disabled={locked}>
                  <ArrowRightLeft size={16} aria-hidden />
                  Chuyển sang mạng này
                </button>
              )}
              {n.enc && (
                <button type="button" className="b-gray" onClick={() => setChanging(key)} disabled={locked}>
                  <KeyRound size={16} aria-hidden />
                  Đổi mật khẩu
                </button>
              )}
            </div>
          )}
        </>
      );
    }
    return (
      <NetForm
        ssid={n.ssid}
        askPass={n.enc}
        requirePass={n.enc}
        deviceUp={deviceUp}
        rekey={isCurrent}
        disabled={locked}
        autoFocus
        note={!n.enc ? "Mạng mở — không cần mật khẩu." : isCurrent ? rekeyNote : undefined}
        onSubmit={(ssid, pass, connect) => submitNet(ssid, pass, connect, isSaved || isCurrent)}
        onCancel={closePanel}
      />
    );
  }

  const scanCard = (
    <section className="card" aria-labelledby="wifi-scan-h">
      <div className="card-head">
        <h2 id="wifi-scan-h">Mạng xung quanh</h2>
        <button
          type="button"
          className="b-gray small"
          onClick={() => void loadScan(true)}
          disabled={!online || scanning || waiting}
        >
          <RefreshCw size={14} className={scanning ? styles.spin : undefined} aria-hidden />
          {scanning ? "Đang quét…" : "Quét lại"}
        </button>
      </div>
      <p className={cx("sub", styles.scanMeta)}>
        {scan?.scanning ? (
          <>
            <Loader2 size={14} className={styles.spin} aria-hidden />
            Đang quét{nets.length > 0 ? " — đang hiện kết quả lần trước" : "…"}
          </>
        ) : scanAge >= 0 ? (
          `Cập nhật ${agoText(scanAge)} · ${nets.length} mạng`
        ) : (
          "Chưa có kết quả quét"
        )}
        <span aria-hidden="true">·</span>
        <span>ESP32 chỉ thấy Wi-Fi 2,4 GHz</span>
      </p>
      {scanErr && <div className="badbox">{scanErr}</div>}

      {nets.length > 0 ? (
        <ul className={styles.netList}>
          {nets.map((n, i) => {
            const key = `scan:${n.ssid}`;
            const isOpen = openRow === key;
            const isCurrent = n.ssid === currentSsid;
            const isSaved = savedSet ? savedSet.has(n.ssid) : n.saved;
            const panelId = `wifi-net-panel-${i}`;
            return (
              <li key={n.ssid}>
                <button
                  type="button"
                  className={cx(styles.net, isOpen && styles.netOpen)}
                  aria-expanded={isOpen}
                  aria-controls={panelId}
                  onClick={() => toggleRow(key)}
                  ref={(el) => {
                    if (el) toggles.current.set(key, el);
                    else toggles.current.delete(key);
                  }}
                >
                  <SignalBars bars={n.bars} rssi={n.rssi} />
                  <span className={styles.netMain}>
                    <span className={styles.netTitle}>
                      <span className={styles.netName}>{n.ssid}</span>
                      {isCurrent ? (
                        <Badge tone="ok" icon={<Check size={12} aria-hidden />}>
                          Đang dùng
                        </Badge>
                      ) : isSaved ? (
                        <Badge tone="navy">Đã lưu</Badge>
                      ) : null}
                    </span>
                    <span className={styles.netMeta}>
                      {n.enc ? (
                        <span className={styles.metaItem}>
                          <Lock size={13} aria-hidden /> Có mật khẩu
                        </span>
                      ) : (
                        <span className={styles.metaItem}>
                          <LockOpen size={13} aria-hidden /> Mạng mở
                        </span>
                      )}
                      {n.ch > 0 && <span className={styles.metaItem}>Kênh {n.ch}</span>}
                      <span className={styles.metaItem} aria-hidden="true">
                        {n.rssi} dBm
                      </span>
                    </span>
                  </span>
                  <ChevronDown size={18} className={cx(styles.chev, isOpen && styles.chevOpen)} aria-hidden />
                </button>
                {isOpen && (
                  <div id={panelId} className={styles.panel}>
                    {scanPanel(n, key, isCurrent, isSaved)}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        !scanErr && (
          <p className={styles.empty}>
            {scanning || !scan
              ? "Đang quét các mạng xung quanh…"
              : "Không thấy mạng nào. Bấm “Quét lại” để thử lần nữa."}
          </p>
        )
      )}

      <details className={styles.manual}>
        <summary>
          <ChevronDown size={16} aria-hidden />
          Mạng ẩn / nhập tay
        </summary>
        <NetForm
          ssid={null}
          askPass
          requirePass={false}
          deviceUp={deviceUp}
          disabled={locked}
          note="Dùng cho mạng ẩn (không phát tên) hoặc mạng chưa hiện trong danh sách quét."
          onSubmit={(ssid, pass, connect) => submitNet(ssid, pass, connect, savedSet?.has(ssid) ?? false)}
        />
      </details>
    </section>
  );

  // ---------------------------------------------------------- mạng đã lưu

  const savedCard = (
    <section className="card" aria-labelledby="wifi-saved-h">
      <div className="card-head">
        <h2 id="wifi-saved-h">
          Mạng đã lưu{saved ? ` (${saved.length}${max > 0 ? `/${max}` : ""})` : ""}
        </h2>
      </div>
      {savedErr && <div className="badbox">{savedErr}</div>}
      {full && (
        <div className="warnbox">
          Đã lưu đủ {max} mạng — xóa bớt một mạng trước khi lưu mạng mới.
        </div>
      )}
      {savedSorted === null ? (
        !savedErr && <p className="sub">Đang tải…</p>
      ) : savedSorted.length === 0 ? (
        <p className="sub">Chưa lưu mạng nào. Chọn một mạng ở “Mạng xung quanh” để lưu.</p>
      ) : (
        <ul className={styles.savedList}>
          {savedSorted.map((s, i) => {
            const key = `saved:${s.ssid}`;
            const isOpen = openRow === key;
            const formId = `wifi-saved-form-${i}`;
            return (
              <li key={s.ssid} className={styles.savedItem}>
                <div className={styles.savedTop}>
                  <span className={styles.netName}>{s.ssid}</span>
                  {s.current ? (
                    <Badge tone="ok" icon={<Check size={12} aria-hidden />}>
                      Đang dùng
                    </Badge>
                  ) : (
                    <ResultBadge last={s.last} />
                  )}
                </div>
                <div className={styles.netMeta}>
                  {s.seen ? (
                    <span className={styles.metaItem}>
                      <SignalBars bars={s.bars} rssi={s.rssi} small decorative />
                      Sóng {signalText(s.bars).toLocaleLowerCase("vi-VN")} · {s.rssi} dBm
                    </span>
                  ) : (
                    <span className={styles.metaItem}>Không thấy trong lần quét gần nhất</span>
                  )}
                  <span className={styles.metaItem}>
                    {s.open ? <LockOpen size={13} aria-hidden /> : <Lock size={13} aria-hidden />}
                    {s.open ? "Mạng mở" : "Có mật khẩu"}
                  </span>
                  {s.lastAgo >= 0 && <span className={styles.metaItem}>Thử lần cuối {agoText(s.lastAgo)}</span>}
                </div>
                <div className={styles.savedActions}>
                  {!s.current && !legacy && (
                    <button
                      type="button"
                      className="b-gray small"
                      aria-label={`Chuyển sang mạng ${s.ssid}`}
                      onClick={() => void connectSaved(s.ssid)}
                      disabled={locked}
                    >
                      <ArrowRightLeft size={14} aria-hidden />
                      Chuyển sang
                    </button>
                  )}
                  {s.last === "wrong_pass" && !s.open && (
                    <button
                      type="button"
                      className="b-gray small"
                      aria-label={`Đổi mật khẩu mạng ${s.ssid}`}
                      aria-expanded={isOpen}
                      aria-controls={formId}
                      onClick={() => toggleRow(key)}
                      disabled={locked}
                      ref={(el) => {
                        if (el) toggles.current.set(key, el);
                        else toggles.current.delete(key);
                      }}
                    >
                      <KeyRound size={14} aria-hidden />
                      Đổi mật khẩu
                    </button>
                  )}
                  <button
                    type="button"
                    className="b-gray small"
                    aria-label={`Xóa mạng ${s.ssid}`}
                    onClick={() => void removeNet(s)}
                    disabled={locked}
                  >
                    <Trash2 size={14} aria-hidden />
                    Xóa
                  </button>
                </div>
                {isOpen && (
                  <div id={formId} className={styles.inlineForm}>
                    <NetForm
                      ssid={s.ssid}
                      askPass
                      requirePass
                      deviceUp={deviceUp}
                      rekey={s.current}
                      disabled={locked}
                      autoFocus
                      note={s.current ? rekeyNote : undefined}
                      onSubmit={(ssid, pass, connect) => submitNet(ssid, pass, connect, true)}
                      onCancel={closePanel}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );

  // ------------------------------------------------- Wi-Fi cấu hình (AP)

  const apOn = Boolean(view?.portal);
  const apCard = (
    <section className="card" aria-labelledby="wifi-ap-h">
      <div className="card-head">
        <h2 id="wifi-ap-h">Wi-Fi cấu hình (AP)</h2>
        {apOn ? (
          <Badge tone="warn" icon={<Radio size={12} aria-hidden />}>
            Đang phát
          </Badge>
        ) : (
          <Badge tone="gray">Đang tắt</Badge>
        )}
      </div>
      {apOn ? (
        <>
          <div className="row">
            <span>Tên Wi-Fi</span>
            <b>{view?.ap || apName}</b>
          </div>
          <div className="row">
            <span>Trang cấu hình</span>
            <b>{view?.apIp ? `http://${view.apIp}` : AP_URL}</b>
          </div>
          <div className="row">
            <span>Máy đang nối</span>
            <b>{view?.apClients ?? 0}</b>
          </div>
          {closesLeft > 0 && (
            <div className="row">
              <span>Tự tắt sau</span>
              <b>{mmss(closesLeft)}</b>
            </div>
          )}
          {view?.portalReason && (
            <div className="row">
              <span>Lý do bật</span>
              <b>{view.portalReason === "auto" ? "Tự bật vì không nối được mạng đã lưu" : "Bật bằng tay"}</b>
            </div>
          )}
          <p className={cx("sub", styles.apNote)}>
            Mật khẩu Wi-Fi này là giá trị <code className="cmd">AP_PASSWORD</code> trong{" "}
            <code className="cmd">include/config.h</code>.
          </p>
          {!legacy && (
            <div className="btns">
              <button
                type="button"
                className="b-gray"
                aria-label="Tắt Wi-Fi cấu hình"
                onClick={() => void setPortal(false)}
                disabled={locked}
              >
                <WifiOff size={16} aria-hidden />
                Tắt
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <p className={cx("sub", styles.apNote)}>
            Khi không nối được mạng đã lưu nào, thiết bị tự phát Wi-Fi “{apName}” để cấu hình bằng điện thoại tại{" "}
            {AP_URL}.
          </p>
          {!legacy && (
            <button type="button" className="b-gray" onClick={() => void setPortal(true)} disabled={locked}>
              <Radio size={16} aria-hidden />
              Bật Wi-Fi cấu hình (để trình diễn)
            </button>
          )}
        </>
      )}
    </section>
  );

  // --------------------------------------------- hướng dẫn khi mất liên lạc

  const guideCard = (
    <section className={cx("card", styles.guide)} aria-labelledby="wifi-guide-h">
      <h2 id="wifi-guide-h">Cấu hình Wi-Fi khi thiết bị mất mạng</h2>
      <p style={{ margin: 0 }}>
        Dashboard chỉ nói chuyện được với thiết bị qua mạng chung, nên lúc này hãy cấu hình trực tiếp bằng điện thoại:
      </p>
      <ol className="howto">
        <li>
          Nối điện thoại vào Wi-Fi <b>“{apName}”</b> do thiết bị phát (mật khẩu: giá trị{" "}
          <code className="cmd">AP_PASSWORD</code> trong <code className="cmd">include/config.h</code>).
        </li>
        <li>
          Thường điện thoại sẽ tự bật trang cấu hình; nếu không, mở <b>{AP_URL}</b>.
        </li>
        <li>Chọn mạng nhà, nhập mật khẩu. Khi thiết bị vào lại mạng chung, trang này tự cập nhật.</li>
      </ol>
      <p className="sub" style={{ margin: 0 }}>
        Thiết bị chỉ phát Wi-Fi cấu hình khi không nối được mạng đã lưu nào. Nếu thiết bị đã vào mạng khác với máy
        chạy dashboard, vào <Link href="/cai-dat">Cài đặt</Link> đổi địa chỉ ESP32 sang IP mới.
      </p>
    </section>
  );

  return (
    <div className={styles.page}>
      <div className="page-head">
        <div>
          <h1>Wi-Fi thiết bị</h1>
          <p className="sub">
            Quét, lưu và đổi mạng Wi-Fi của thiết bị. Lệnh đi qua máy chủ dashboard nên chỉ dùng được khi thiết bị
            đang liên lạc được; mất liên lạc thì làm theo hướng dẫn dùng Wi-Fi cấu hình bên dưới.
          </p>
        </div>
      </div>

      {netError && <div className="badbox">Không gọi được máy chủ dashboard: {netError}</div>}

      {statusCard}

      {online && legacy && (
        <div className="warnbox">
          Firmware trên thiết bị là bản cũ (chưa có <code className="cmd">/api/wifi/state</code>): trang vẫn quét,
          lưu và xóa được mạng, nhưng không theo dõi được kết quả kết nối, không chuyển nhanh sang mạng đã lưu và
          không bật/tắt được Wi-Fi cấu hình. Nạp firmware mới để dùng đầy đủ.
        </div>
      )}

      <div role="status" aria-live="polite" aria-atomic="true" className={styles.live}>
        {live}
      </div>

      {data && !online && guideCard}

      {online && (
        <div className="grid2">
          {scanCard}
          <div className="stack">
            {savedCard}
            {apCard}
          </div>
        </div>
      )}
    </div>
  );
}
