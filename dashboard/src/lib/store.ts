/**
 * Lưu trữ dữ liệu của dashboard.
 *
 * CHỌN CÁCH LƯU: dùng file JSON / JSONL trong thư mục dashboard/data/ thay vì
 * một database thật. Lý do:
 *   - không phải cài thêm gì, không có thư viện biên dịch sẵn (native module)
 *     hay bị lỗi trên Windows;
 *   - số liệu của đồ án chỉ vài nghìn dòng, đọc hết vào RAM vẫn nhẹ;
 *   - file mở được bằng Notepad, dễ kiểm tra và dễ sao lưu khi làm báo cáo.
 *
 * Sự kiện dùng định dạng JSONL (mỗi dòng một JSON) để chỉ cần ghi thêm vào
 * cuối file, không phải viết lại toàn bộ.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { FeatureSample } from "./features";
import type { LogisticModel } from "./train";
import type { Contact, Interaction, Session, Settings, StoredEvent, Trial } from "./types";

/** Đổi được qua biến môi trường để chạy thử mà không đụng vào số liệu thật. */
const DATA_DIR = path.resolve(/*turbopackIgnore: true*/ process.cwd(), process.env.DASHBOARD_DATA_DIR || "data");
const F_EVENTS = path.join(DATA_DIR, "events.jsonl");
const F_SESSIONS = path.join(DATA_DIR, "sessions.json");
const F_TRIALS = path.join(DATA_DIR, "trials.json");
const F_SETTINGS = path.join(DATA_DIR, "settings.json");
const F_SAMPLES = path.join(DATA_DIR, "features.jsonl");
const F_MODEL = path.join(DATA_DIR, "model.json");
/** Nhật ký người nhà hỏi thăm / nhắn qua loa (Telegram + web) */
const F_MESSAGES = path.join(DATA_DIR, "messages.jsonl");
/** Vị trí đã đọc tới trong hàng tin Telegram, để tắt máy bật lại không đọc lại */
const F_TELEGRAM = path.join(DATA_DIR, "telegram.json");
/** Danh bạ người nhà: người cao tuổi nói "gửi cho <tên> là …" thì gửi tới đây */
const F_CONTACTS = path.join(DATA_DIR, "contacts.json");
/** Số lượt tương tác giữ trong RAM (cũ hơn vẫn còn trong file) */
const MESSAGE_LIMIT = 2000;

/** Số mẫu đặc trưng giữ trong RAM. 4 mẫu/giây -> 200k mẫu ~ 14 giờ đo liên tục. */
const SAMPLE_LIMIT = 200_000;

export const DEFAULT_SETTINGS: Settings = {
  esp32Host: process.env.ESP32_HOST ?? "canhbao-tenga.local",
  pollMs: 1500,
  elderCall: "",
  ttsVoice: "vi-VN-HoaiMyNeural",
  telegramEnabled: true,
  zaloEnabled: true,
  relayLabel: "Người thân",
};

export type TelegramState = { offset: number; botName: string | null };

/**
 * Giữ dữ liệu trong RAM. Dùng globalThis để khi Next.js nạp lại module lúc đang
 * chạy chế độ dev thì không bị tạo ra hai bản nhớ khác nhau.
 */
type Cache = {
  loaded: boolean;
  events: StoredEvent[];
  eventKeys: Set<string>;
  sessions: Session[];
  trials: Trial[];
  settings: Settings;
  samples: FeatureSample[];
  model: StoredModel | null;
  messages: Interaction[];
  telegram: TelegramState;
  writeQueue: Promise<unknown>;
  /** (bản cũ) cờ đã nâng cấp bộ đệm — nay dùng `version` */
  upgraded?: boolean;
  /** Phiên bản cấu trúc bộ đệm đã nâng cấp tới (xem cache()) */
  version?: number;
  /** Lần nạp nhật ký tương tác + trạng thái Telegram (chạy đúng một lần) */
  extras?: Promise<void>;
  /** Danh bạ người nhà, nạp lười ở lần dùng đầu (xem contactsOf) */
  contacts?: Contact[];
  contactsLoad?: Promise<void>;
};

/**
 * Tăng số này mỗi khi thêm trường mới vào Cache hoặc Settings: bộ đệm do code cũ
 * tạo ra (đang sống qua HMR của `npm run dev`) sẽ được bổ sung trong cache().
 */
const CACHE_VERSION = 3; // 3: thêm Settings.zaloEnabled

/** Model đã huấn luyện, lưu lại để không phải huấn luyện lại mỗi lần mở trang */
export type StoredModel = {
  model: LogisticModel;
  trainedAt: number;
  trainScores: unknown;
  testScores: unknown;
  datasetInfo: { train: number; test: number; trialsUsed: number; trialsSkipped: number };
  warnings: string[];
};

const g = globalThis as typeof globalThis & { __fallStore?: Cache };

function cache(): Cache {
  if (!g.__fallStore) {
    g.__fallStore = {
      loaded: false,
      events: [],
      eventKeys: new Set(),
      sessions: [],
      trials: [],
      settings: { ...DEFAULT_SETTINGS },
      samples: [],
      model: null,
      messages: [],
      telegram: { offset: 0, botName: null },
      writeQueue: Promise.resolve(),
    };
  }
  const c = g.__fallStore;
  // `npm run dev` nạp lại code mới (HMR) nhưng GIỮ bộ nhớ đệm do phiên bản cũ của
  // file này tạo ra: bổ sung các trường mới, nếu không chúng là undefined và mọi
  // API đụng tới lời nhắn / Telegram / danh bạ đều lỗi 500.
  if ((c.version ?? 0) < CACHE_VERSION) {
    c.messages ??= [];
    c.telegram ??= { offset: 0, botName: null };
    c.settings = { ...DEFAULT_SETTINGS, ...c.settings };
    c.upgraded = true;
    c.version = CACHE_VERSION;
  }
  return c;
}

/** Nối các lệnh ghi lại thành một chuỗi để hai lệnh không ghi đè nhau. */
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const c = cache();
  const next = c.writeQueue.then(fn, fn);
  c.writeQueue = next.catch(() => undefined);
  return next;
}

/** Ghi an toàn: ghi ra file tạm rồi đổi tên, tránh mất dữ liệu nếu tắt giữa lúc ghi. */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, file);
}

async function readJsonSafe<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Sự kiện, phiên đo, lần thử, cấu hình, mẫu đặc trưng, model (chỉ chạy một lần). */
async function loadCore(): Promise<void> {
  const c = cache();
  if (c.loaded) return;
  await fs.mkdir(DATA_DIR, { recursive: true });

  c.sessions = await readJsonSafe<Session[]>(F_SESSIONS, []);
  c.trials = await readJsonSafe<Trial[]>(F_TRIALS, []);
  c.settings = { ...DEFAULT_SETTINGS, ...(await readJsonSafe<Partial<Settings>>(F_SETTINGS, {})) };

  try {
    const raw = await fs.readFile(F_EVENTS, "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const ev = JSON.parse(t) as StoredEvent;
        if (ev?.key && !c.eventKeys.has(ev.key)) {
          c.eventKeys.add(ev.key);
          c.events.push(ev);
        }
      } catch {
        /* bỏ qua dòng bị hỏng (vd mất điện giữa lúc ghi) */
      }
    }
  } catch {
    /* chưa có file sự kiện: lần chạy đầu tiên */
  }

  c.events.sort((a, b) => a.recvAt - b.recvAt);

  // Mẫu đặc trưng (có thể rất nhiều dòng nên chỉ giữ phần cuối)
  try {
    const raw = await fs.readFile(F_SAMPLES, "utf8");
    const lines = raw.split("\n");
    const start = Math.max(0, lines.length - SAMPLE_LIMIT);
    for (let i = start; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t) continue;
      try {
        c.samples.push(JSON.parse(t) as FeatureSample);
      } catch {
        /* bỏ qua dòng hỏng */
      }
    }
  } catch {
    /* chưa có file mẫu đặc trưng */
  }

  c.model = await readJsonSafe<StoredModel | null>(F_MODEL, null);
  c.loaded = true;
}

/** Nhật ký tương tác + vị trí đọc Telegram. Tách riêng để bộ đệm cũ (đã loaded) vẫn nạp được. */
async function loadExtras(c: Cache): Promise<void> {
  try {
    const raw = await fs.readFile(F_MESSAGES, "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        c.messages.push(JSON.parse(t) as Interaction);
      } catch {
        /* bỏ dòng hỏng */
      }
    }
    if (c.messages.length > MESSAGE_LIMIT) c.messages.splice(0, c.messages.length - MESSAGE_LIMIT);
  } catch {
    /* chưa có nhật ký tương tác */
  }
  c.telegram = { ...c.telegram, ...(await readJsonSafe<Partial<TelegramState>>(F_TELEGRAM, {})) };
}

/** Nạp toàn bộ dữ liệu từ đĩa (chỉ chạy một lần, kể cả khi nhiều API gọi cùng lúc). */
export async function load(): Promise<void> {
  await loadCore();
  const c = cache();
  c.extras ??= loadExtras(c);
  await c.extras;
}

// ----------------------------------------------------------------- Sự kiện ---

/** Thêm các sự kiện mới, tự bỏ những sự kiện đã có. Trả về số sự kiện thật sự mới. */
export async function addEvents(incoming: StoredEvent[]): Promise<StoredEvent[]> {
  await load();
  const c = cache();
  const fresh = incoming.filter((e) => !c.eventKeys.has(e.key));
  if (fresh.length === 0) return [];

  for (const e of fresh) {
    c.eventKeys.add(e.key);
    c.events.push(e);
  }
  c.events.sort((a, b) => a.recvAt - b.recvAt);

  await enqueue(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.appendFile(F_EVENTS, fresh.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  });
  return fresh;
}

export async function getEvents(): Promise<StoredEvent[]> {
  await load();
  return cache().events;
}

/** Lấy các sự kiện firmware ghi trong một khoảng thời gian (dùng để chấm lần thử). */
export async function getEventsBetween(from: number, to: number): Promise<StoredEvent[]> {
  await load();
  return cache().events.filter((e) => e.recvAt >= from && e.recvAt <= to);
}

export async function clearEvents(): Promise<void> {
  await load();
  const c = cache();
  c.events = [];
  c.eventKeys = new Set();
  await enqueue(async () => {
    await fs.rm(F_EVENTS, { force: true });
  });
}

// ---------------------------------------------------------------- Phiên đo ---

export async function getSessions(): Promise<Session[]> {
  await load();
  return cache().sessions;
}

export async function addSession(s: Session): Promise<Session> {
  await load();
  const c = cache();
  c.sessions.push(s);
  await enqueue(() => writeJsonAtomic(F_SESSIONS, c.sessions));
  return s;
}

export async function deleteSession(id: string): Promise<void> {
  await load();
  const c = cache();
  c.sessions = c.sessions.filter((s) => s.id !== id);
  c.trials = c.trials.filter((t) => t.sessionId !== id);
  await enqueue(() => writeJsonAtomic(F_SESSIONS, c.sessions));
  await enqueue(() => writeJsonAtomic(F_TRIALS, c.trials));
}

// --------------------------------------------------------------- Lần thử -----

export async function getTrials(sessionId?: string): Promise<Trial[]> {
  await load();
  const all = cache().trials;
  return sessionId ? all.filter((t) => t.sessionId === sessionId) : all;
}

export async function getActiveTrial(): Promise<Trial | null> {
  await load();
  return cache().trials.find((t) => t.endedAt === null) ?? null;
}

export async function upsertTrial(trial: Trial): Promise<Trial> {
  await load();
  const c = cache();
  const i = c.trials.findIndex((t) => t.id === trial.id);
  if (i >= 0) c.trials[i] = trial;
  else c.trials.push(trial);
  await enqueue(() => writeJsonAtomic(F_TRIALS, c.trials));
  return trial;
}

export async function deleteTrial(id: string): Promise<void> {
  await load();
  const c = cache();
  c.trials = c.trials.filter((t) => t.id !== id);
  await enqueue(() => writeJsonAtomic(F_TRIALS, c.trials));
}

// ------------------------------------------------- Mẫu đặc trưng (cho model) --

export async function addSamples(incoming: FeatureSample[]): Promise<number> {
  await load();
  const c = cache();
  if (incoming.length === 0) return 0;

  c.samples.push(...incoming);
  if (c.samples.length > SAMPLE_LIMIT) {
    c.samples.splice(0, c.samples.length - SAMPLE_LIMIT);
  }

  await enqueue(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.appendFile(
      F_SAMPLES,
      incoming.map((s) => JSON.stringify(s)).join("\n") + "\n",
      "utf8",
    );
  });
  return incoming.length;
}

export async function getSamples(): Promise<FeatureSample[]> {
  await load();
  return cache().samples;
}

export async function clearSamples(): Promise<void> {
  await load();
  const c = cache();
  c.samples = [];
  await enqueue(async () => {
    await fs.rm(F_SAMPLES, { force: true });
  });
}

// ------------------------------------------------------- Model đã huấn luyện --

export async function getModel(): Promise<StoredModel | null> {
  await load();
  return cache().model;
}

export async function saveModel(m: StoredModel): Promise<void> {
  await load();
  const c = cache();
  c.model = m;
  await enqueue(() => writeJsonAtomic(F_MODEL, m));
}

// ----------------------------------------------------------------- Cấu hình --

export async function getSettings(): Promise<Settings> {
  await load();
  return cache().settings;
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  await load();
  const c = cache();
  c.settings = { ...c.settings, ...patch };
  if (c.settings.pollMs < 500) c.settings.pollMs = 500;
  // Quá 10 giây thì "hợp đồng thuê" quyền đọc Telegram (?tg=) dễ hết hạn giữa chừng
  if (c.settings.pollMs > 10000) c.settings.pollMs = 10000;
  await enqueue(() => writeJsonAtomic(F_SETTINGS, c.settings));
  return c.settings;
}

// ------------------------------------------- Nhật ký tương tác người nhà --

export async function addInteraction(m: Interaction): Promise<Interaction> {
  await load();
  const c = cache();
  c.messages.push(m);
  if (c.messages.length > MESSAGE_LIMIT) c.messages.splice(0, c.messages.length - MESSAGE_LIMIT);
  await enqueue(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.appendFile(F_MESSAGES, JSON.stringify(m) + "\n", "utf8");
  });
  return m;
}

/** Mới nhất đứng đầu */
export async function getInteractions(limit = 200): Promise<Interaction[]> {
  await load();
  return cache().messages.slice(-limit).reverse();
}

export async function getTelegramState(): Promise<TelegramState> {
  await load();
  return cache().telegram;
}

export async function saveTelegramState(patch: Partial<TelegramState>): Promise<void> {
  await load();
  const c = cache();
  c.telegram = { ...c.telegram, ...patch };
  await enqueue(() => writeJsonAtomic(F_TELEGRAM, c.telegram));
}

// ------------------------------------------------------ Danh bạ người nhà --

export type ContactInput = Pick<Contact, "name" | "aliases" | "telegramChatId" | "email"> & {
  id?: string;
  /** Không gửi thì giữ nguyên mã Zalo đang lưu (sửa người cũ) / để trống (thêm mới) */
  zaloChatId?: string;
};

/** Bỏ bản ghi hỏng / thiếu trường (file có thể bị sửa tay bằng Notepad). */
function cleanContact(x: unknown): Contact | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v.normalize("NFC").trim() : typeof v === "number" ? String(v) : "");
  const name = text(r.name);
  if (!name) return null;
  const now = Date.now();
  return {
    id: text(r.id) || newId("nn"),
    name,
    aliases: Array.isArray(r.aliases) ? r.aliases.map(text).filter(Boolean) : [],
    telegramChatId: text(r.telegramChatId),
    zaloChatId: text(r.zaloChatId),
    email: text(r.email),
    createdAt: Number(r.createdAt) || now,
    updatedAt: Number(r.updatedAt) || now,
  };
}

/** Nạp danh bạ một lần (lười, nên bộ đệm cũ sống qua HMR cũng nạp được). */
async function contactsOf(c: Cache): Promise<Contact[]> {
  c.contactsLoad ??= readJsonSafe<unknown>(F_CONTACTS, []).then((raw) => {
    c.contacts = (Array.isArray(raw) ? raw : []).map(cleanContact).filter((x): x is Contact => x !== null);
  });
  await c.contactsLoad;
  return (c.contacts ??= []);
}

export async function getContacts(): Promise<Contact[]> {
  return contactsOf(cache());
}

/** Thêm mới (không có id) hoặc cập nhật một người trong danh bạ. Kiểm tra dữ liệu ở route API. */
export async function saveContact(input: ContactInput): Promise<Contact> {
  const list = await contactsOf(cache());
  const now = Date.now();
  const i = input.id ? list.findIndex((x) => x.id === input.id) : -1;
  const saved: Contact = {
    id: i >= 0 ? list[i].id : newId("nn"),
    name: input.name,
    aliases: input.aliases,
    telegramChatId: input.telegramChatId,
    zaloChatId: input.zaloChatId ?? (i >= 0 ? list[i].zaloChatId : ""),
    email: input.email,
    createdAt: i >= 0 ? list[i].createdAt : now,
    updatedAt: now,
  };
  if (i >= 0) list[i] = saved;
  else list.push(saved);
  await enqueue(() => writeJsonAtomic(F_CONTACTS, list));
  return saved;
}

export async function deleteContact(id: string): Promise<boolean> {
  const list = await contactsOf(cache());
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return false;
  list.splice(i, 1);
  await enqueue(() => writeJsonAtomic(F_CONTACTS, list));
  return true;
}

/** Sinh mã định danh ngắn, đủ dùng cho dữ liệu đồ án. */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
