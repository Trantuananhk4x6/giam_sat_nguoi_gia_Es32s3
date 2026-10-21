/* ==========================================================================
   Icon tap trung - thay cho emoji trong giao dien.
   Dung bo icon SVG lucide-react (net manh, hien dai, dong deu).

   - <Ic name="speaker" />  : icon theo ten khoa (dung cho ca icon dong tu
                              health.ts: moi loai su kien tra ve mot "khoa")
   - Kich thuoc / mau ke thua tu CSS (color, font-size) nho stroke=currentColor
     va size dieu chinh qua prop.
   ========================================================================== */
import {
  AlertTriangle,
  ArrowRight,
  BellOff,
  CircleCheck,
  CloudSun,
  CornerDownRight,
  Dot,
  DoorOpen,
  HeartPulse,
  Settings,
  House,
  LifeBuoy,
  LogOut,
  MessageCircle,
  Mic,
  Moon,
  Pause,
  Play,
  Radar,
  RefreshCw,
  Send,
  Siren,
  Sparkles,
  Square,
  Volume2,
  VolumeX,
  WifiOff,
  type LucideIcon,
} from "lucide-react";

/** Ten khoa -> icon. Them khoa moi o day la dung duoc khap noi. */
const ICONS = {
  home: House,
  warning: AlertTriangle,
  emergency: Siren,
  radar: Radar,
  speaker: Volume2,
  "speaker-off": VolumeX,
  chat: MessageCircle,
  door: DoorOpen,
  leave: LogOut,
  ok: CircleCheck,
  sos: LifeBuoy,
  "msg-sent": Send,
  "msg-fail": BellOff,
  vitals: HeartPulse,
  wifi: WifiOff,
  reboot: RefreshCw,
  moon: Moon,
  sparkle: Sparkles,
  calm: CloudSun,
  mic: Mic,
  stop: Square,
  pause: Pause,
  play: Play,
  "arrow-right": ArrowRight,
  reply: CornerDownRight,
  gear: Settings,
  dot: Dot,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export function Ic({
  name,
  size = 18,
  className,
  strokeWidth = 2,
}: {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
}) {
  const C = ICONS[name];
  return <C size={size} strokeWidth={strokeWidth} className={className} aria-hidden />;
}

/**
 * Render icon tu mot khoa dang string tu do (vi du e.icon tu health.ts, kieu
 * la string chu khong phai IconName). Khoa la khong biet thi dung cham tron.
 */
export function IcKey({ name, size = 18, className }: { name: string; size?: number; className?: string }) {
  const C = (ICONS as Record<string, LucideIcon>)[name] ?? Dot;
  return <C size={size} strokeWidth={2} className={className} aria-hidden />;
}
