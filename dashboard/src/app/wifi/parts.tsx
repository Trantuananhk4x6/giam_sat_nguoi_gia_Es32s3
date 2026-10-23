/**
 * Các mảnh giao diện nhỏ của trang /wifi: cột sóng, huy hiệu, khung thông báo,
 * biểu mẫu nhập mật khẩu. Chỉ hiển thị — việc gọi API nằm ở page.tsx.
 */
import Link from "next/link";
import { useId, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRightLeft,
  Check,
  CircleCheck,
  CircleX,
  Eye,
  EyeOff,
  Info,
  Loader2,
  Save,
  ShieldCheck,
  Wifi,
  X,
} from "lucide-react";
import {
  passError,
  resultLabel,
  signalLabel,
  ssidError,
  utf8Bytes,
  SSID_MAX_BYTES,
  type WifiBars,
  type WifiResult,
} from "@/lib/wifi-types";
import styles from "./wifi.module.css";

/** Ghép tên lớp, bỏ giá trị rỗng */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

// ------------------------------------------------------------- cột sóng ---

/**
 * Cột sóng 4 vạch. Mặc định có nhãn cho trình đọc màn hình ("Sóng mạnh, -54 dBm");
 * `decorative` khi ngay bên cạnh đã có chữ mô tả mức sóng.
 */
export function SignalBars({
  bars,
  rssi,
  small = false,
  decorative = false,
}: {
  bars: WifiBars;
  rssi: number;
  small?: boolean;
  decorative?: boolean;
}) {
  const tone = bars >= 3 ? styles.barsGood : bars === 2 ? styles.barsMid : styles.barsLow;
  const a11y = decorative
    ? ({ "aria-hidden": true } as const)
    : ({ role: "img", "aria-label": signalLabel(bars, rssi) } as const);
  return (
    <span className={cx(styles.bars, tone, small && styles.barsSm)} {...a11y}>
      {[1, 2, 3, 4].map((i) => (
        <span key={i} className={i <= bars ? styles.on : undefined} />
      ))}
    </span>
  );
}

// ------------------------------------------------------------- huy hiệu ---

export type BadgeTone = "ok" | "bad" | "warn" | "navy" | "gray";

const BADGE: Record<BadgeTone, string> = {
  ok: styles.badgeOk,
  bad: styles.badgeBad,
  warn: styles.badgeWarn,
  navy: styles.badgeNavy,
  gray: styles.badgeGray,
};

export function Badge({ tone, icon, children }: { tone: BadgeTone; icon?: ReactNode; children: ReactNode }) {
  return (
    <span className={cx(styles.badge, BADGE[tone])}>
      {icon}
      {children}
    </span>
  );
}

/** Huy hiệu kết quả lần thử gần nhất — luôn có chữ + icon, không chỉ dựa vào màu */
export function ResultBadge({ last }: { last: WifiResult | "" }) {
  const label = resultLabel(last);
  switch (last) {
    case "ok":
      return <Badge tone="ok" icon={<Check size={12} aria-hidden />}>{label}</Badge>;
    case "wrong_pass":
      return <Badge tone="bad" icon={<X size={12} aria-hidden />}>{label}</Badge>;
    case "not_found":
    case "timeout":
      return <Badge tone="warn" icon={<AlertTriangle size={12} aria-hidden />}>{label}</Badge>;
    case "fail":
      return <Badge tone="bad" icon={<AlertTriangle size={12} aria-hidden />}>{label}</Badge>;
    case "trying":
      return <Badge tone="navy" icon={<Loader2 size={12} className={styles.spin} aria-hidden />}>{label}</Badge>;
    default:
      return <Badge tone="gray">{label}</Badge>;
  }
}

// ------------------------------------------------------ khung thông báo ---

export type Tone = "ok" | "bad" | "warn" | "info";

export type Notice = {
  tone: Tone;
  title: string;
  text?: string;
  hint?: string;
  link?: { href: string; label: string };
};

const BOX: Record<Tone, string> = { ok: "okbox", bad: "badbox", warn: "warnbox", info: styles.infoBox };
const BOX_ICON = { ok: CircleCheck, bad: CircleX, warn: AlertTriangle, info: Info } as const;

export function NoticeView({ notice, onClose }: { notice: Notice; onClose?: () => void }) {
  const Icon = BOX_ICON[notice.tone];
  return (
    <div className={cx(BOX[notice.tone], styles.notice)}>
      <Icon size={20} className={styles.noticeIcon} aria-hidden />
      <div className={styles.noticeBody}>
        <b className={styles.noticeTitle}>{notice.title}</b>
        {notice.text && <p>{notice.text}</p>}
        {notice.hint && <p className={styles.hint}>{notice.hint}</p>}
        {notice.link && (
          <p>
            <Link href={notice.link.href}>{notice.link.label}</Link>
          </p>
        )}
      </div>
      {onClose && (
        <button type="button" className={styles.close} onClick={onClose} aria-label="Ẩn thông báo">
          <X size={16} aria-hidden />
        </button>
      )}
    </div>
  );
}

/** Đang chờ kết quả: spinner + đếm giây (số giây ẩn với trình đọc màn hình để khỏi đọc mỗi giây) */
export function PendingView({ title, detail, seconds }: { title: string; detail: string; seconds: number }) {
  return (
    <div className={cx(styles.infoBox, styles.notice)}>
      <Loader2 size={20} className={cx(styles.noticeIcon, styles.spin)} aria-hidden />
      <div className={styles.noticeBody}>
        <b className={styles.noticeTitle}>
          {title}
          <span className={styles.elapsed} aria-hidden="true">
            {seconds} giây
          </span>
        </b>
        <p>{detail}</p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- biểu mẫu ---

/** done = lệnh đã được nhận (đóng biểu mẫu); error = câu lỗi hiện ngay trong biểu mẫu */
export type FormResult = { done: boolean; error?: string };

type NetFormProps = {
  /** null = nhập tay (hiện ô tên mạng, dùng cho mạng ẩn) */
  ssid: string | null;
  /** Hiện ô mật khẩu (mạng mở thì không cần) */
  askPass: boolean;
  /** Mạng có khóa: bắt buộc nhập mật khẩu */
  requirePass: boolean;
  /** Thiết bị đang có mạng -> cho chọn "Lưu" hoặc "Lưu & chuyển sang mạng này" */
  deviceUp: boolean;
  /**
   * Đổi mật khẩu mạng ĐANG DÙNG: chỉ một nút "Lưu & kiểm tra mật khẩu mới" (connect=true).
   * Thiết bị ngắt mạng vài giây để thử ngay, sai thì tự quay về mật khẩu cũ.
   */
  rekey?: boolean;
  disabled: boolean;
  autoFocus?: boolean;
  note?: string;
  onSubmit: (ssid: string, pass: string, connect: boolean) => Promise<FormResult>;
  onCancel?: () => void;
};

export function NetForm({
  ssid,
  askPass,
  requirePass,
  deviceUp,
  rekey = false,
  disabled,
  autoFocus = false,
  note,
  onSubmit,
  onCancel,
}: NetFormProps) {
  const uid = useId();
  const ssidId = `${uid}-ssid`;
  const ssidHintId = `${uid}-ssid-hint`;
  const passId = `${uid}-pass`;
  const passHintId = `${uid}-pass-hint`;
  const errId = `${uid}-err`;

  const [name, setName] = useState("");
  const [pass, setPass] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const manual = ssid === null;
  const off = disabled || sending;
  const focusButton = autoFocus && !askPass && !manual;

  async function submit(connect: boolean) {
    const target = ssid ?? name.trim();
    const problem =
      ssidError(target) ??
      (askPass && requirePass && pass === "" ? "Mạng này có mật khẩu — hãy nhập mật khẩu." : null) ??
      (askPass ? passError(pass) : null);
    if (problem) {
      setErr(problem);
      return;
    }
    setErr(null);
    setSending(true);
    const r = await onSubmit(target, askPass ? pass : "", connect);
    setSending(false);
    if (r.error) {
      setErr(r.error);
    } else if (r.done) {
      setPass("");
      setShow(false);
      if (manual) setName("");
    }
  }

  return (
    <form
      className={styles.form}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        // Enter = nút chính, ở mọi chế độ đều là gửi kèm connect=true.
        void submit(true);
      }}
    >
      {note && <p className={styles.formNote}>{note}</p>}

      {manual && (
        <div className={styles.field}>
          <label htmlFor={ssidId}>Tên mạng (SSID)</label>
          <input
            id={ssidId}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ví dụ: Wifi-Nha"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            readOnly={sending}
            aria-describedby={ssidHintId}
          />
          <span id={ssidHintId} className={styles.fieldHint}>
            Phân biệt chữ hoa/thường · {utf8Bytes(name.trim())}/{SSID_MAX_BYTES} byte
          </span>
        </div>
      )}

      {askPass && (
        <div className={styles.field}>
          <label htmlFor={passId}>{manual ? "Mật khẩu" : `Mật khẩu Wi-Fi “${ssid}”`}</label>
          <div className={styles.passRow}>
            <input
              id={passId}
              type={show ? "text" : "password"}
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoFocus={autoFocus}
              readOnly={sending}
              aria-invalid={err ? true : undefined}
              aria-describedby={err ? `${errId} ${passHintId}` : passHintId}
            />
            <button type="button" className={styles.eye} onClick={() => setShow((v) => !v)} aria-controls={passId}>
              {show ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
              {show ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
            </button>
          </div>
          <span id={passHintId} className={styles.fieldHint}>
            {requirePass ? "8–63 ký tự, phân biệt chữ hoa/thường." : "8–63 ký tự; để trống nếu là mạng mở."} Mật
            khẩu chỉ được gửi xuống thiết bị, dashboard không lưu lại.
          </span>
        </div>
      )}

      {err && (
        <p id={errId} className={styles.fieldErr} role="alert">
          <AlertTriangle size={15} aria-hidden />
          {err}
        </p>
      )}

      <div className="btns">
        {rekey ? (
          <button type="submit" className="b-main" disabled={off} autoFocus={focusButton}>
            <ShieldCheck size={16} aria-hidden />
            {sending ? "Đang gửi…" : "Lưu & kiểm tra mật khẩu mới"}
          </button>
        ) : deviceUp ? (
          <>
            <button type="submit" className="b-main" disabled={off} autoFocus={focusButton}>
              <ArrowRightLeft size={16} aria-hidden />
              Lưu &amp; chuyển sang mạng này
            </button>
            <button type="button" className="b-gray" disabled={off} onClick={() => void submit(false)}>
              <Save size={16} aria-hidden />
              Lưu
            </button>
          </>
        ) : (
          <button type="submit" className="b-main" disabled={off} autoFocus={focusButton}>
            <Wifi size={16} aria-hidden />
            {sending ? "Đang gửi…" : "Kết nối"}
          </button>
        )}
        {onCancel && (
          <button type="button" className="b-gray" onClick={onCancel} disabled={sending}>
            Hủy
          </button>
        )}
      </div>
    </form>
  );
}
