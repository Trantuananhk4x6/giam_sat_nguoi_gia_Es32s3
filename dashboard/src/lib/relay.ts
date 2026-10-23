/**
 * NGƯỜI CAO TUỔI NHẮN CHO NGƯỜI NHÀ BẰNG GIỌNG NÓI
 *
 *   Ông/bà giữ nút xanh, nói: "gửi cho Tuấn là tối nay gọi cho mẹ lúc 8h nhé"
 *   -> ESP32 ghi âm -> POST /api/assistant -> Whisper ra chữ -> file này:
 *        1. nhận ra đây là lệnh gửi tin: người nhận "Tuấn", lời nhắn "tối nay … nhé"
 *        2. tra DANH BẠ NGƯỜI NHÀ (trang Cài đặt) lấy Telegram + Zalo + email của Tuấn
 *        3. gửi đúng một dòng:   Người thân: "tối nay gọi cho mẹ lúc 8h nhé"
 *        4. trả câu cho loa đọc lại: Dạ, con đã gửi cho Tuấn qua Telegram và email: "…"
 *
 * NGUYÊN TẮC
 *   - Lời nhắn là lời của người cao tuổi nên giữ NGUYÊN VĂN những gì nghe được:
 *     tách bằng luật, không nhờ AI viết lại.
 *   - Chỉ khi câu nói lạ mà luật không tách được (nhưng có tên trong danh bạ và có
 *     từ "gửi/nhắn/báo…") mới hỏi AI; đoạn AI tách ra phải nằm nguyên trong câu
 *     nghe được, nếu không thì bỏ.
 *   - Không hỏi xác nhận (trợ lý trên ESP32 chỉ nghe - trả lời một lượt); bù lại
 *     loa đọc lại đúng lời đã gửi để ông/bà biết.
 *   - Tên so khớp KHÔNG phân biệt dấu (máy hay nghe "Tuấn" thành "Tuần"); trùng
 *     nhiều người thì hỏi lại chứ không đoán.
 */
import { elderCallOf } from "./health";
import { chat, hasLlm } from "./llm";
import { escapeHtml, sendEmail, sendTelegramText, sendZaloText } from "./notify";
import { pollerSnapshot } from "./poller";
import { DEFAULT_SETTINGS, addInteraction, getContacts, getInteractions, getSettings, newId } from "./store";
import type { Contact, Delivery, RelayInfo, RelayStatus } from "./types";

// ---------------------------------------------------------------- tách từ ---

type Tok = { start: number; end: number; low: string; bare: string };

/** "Tuấn" -> "tuan": bỏ dấu để vẫn nhận ra khi máy nghe nhầm dấu (Tuấn / Tuần / Tuân). */
export function bareOf(s: string): string {
  return s.normalize("NFD").replace(/\p{M}+/gu, "").replace(/[đĐ]/g, "d").toLowerCase();
}

/** Chuẩn hóa chữ STT: dựng sẵn dấu (NFC) và gom khoảng trắng. */
export function normalizeHeard(s: string): string {
  return s.normalize("NFC").replace(/\s+/g, " ").trim();
}

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  for (const m of s.matchAll(/[\p{L}\p{M}\p{N}]+/gu)) {
    const low = m[0].toLocaleLowerCase("vi");
    out.push({ start: m.index, end: m.index + m[0].length, low, bare: bareOf(low) });
  }
  return out;
}

const words = (s: string) => new Set(s.split(" "));

/** Lời gọi / nhờ hay đứng trước lệnh: "con ơi", "trợ lý ơi", "nhờ cháu", "làm ơn"… */
const LEAD = words("con cháu em trợ lý ơi này nè à ừ ờ ừm ờm ê dạ vâng alo nhờ giúp giùm hộ làm ơn hãy cho với oalpha alpha thì bây giờ muốn cần định");
/** Người nói tự xưng: "bà muốn gửi…" */
const SUBJECT = words("bà ông mẹ bố ba má tôi mình tui tao cụ u bầm");
const MODAL = words("muốn cần nhờ định");
/** Chen giữa động từ và người nhận: "nhắn GIÙM BÀ cho Tuấn", "gửi MỘT TIN NHẮN tới Tuấn" */
const MID = words("giúp giùm hộ bà ông mẹ bố ba má tôi mình tui con cháu em một cái tin nhắn lời ngay luôn");
const PREP = words("cho tới đến với sang qua");
/** Từ chỉ vai vế đứng trước tên: "con Tuấn", "anh Tuấn", "thằng Tuấn" */
const KIN = words("con cháu anh chị em thằng cái bé cô chú bác dì cậu mợ ông bà bố mẹ ba má dượng thím");
/** Từ đệm sau tên, trước từ nối: "gửi cho Tuấn GIÚP BÀ là…" */
const AFTER_NAME = words("một câu tin nhắn lời cái giúp giùm hộ bà ông mẹ bố ba má tôi mình ngay luôn với nhé nha");
/** Lời nhắn chỉ có mấy từ này ("gửi cho Tuấn nhé") thì coi như chưa nói nội dung */
const FILLER_ONLY = words("nhé nha nhá đi với ạ giùm giúp hộ ngay luôn nhanh cái");

/**
 * Động từ ra lệnh. strong = gần như luôn là lệnh gửi; weak (báo, bảo, nói với,
 * dặn) dễ là KỂ CHUYỆN ("bà bảo Tuấn là…") nên cần thêm "muốn/nhờ".
 */
const VERBS: { w: string[]; strong: boolean }[] = [
  { w: ["gửi", "tin", "nhắn"], strong: true },
  { w: ["gởi", "tin", "nhắn"], strong: true },
  { w: ["gửi", "lời", "nhắn"], strong: true },
  { w: ["gửi", "tin"], strong: true },
  { w: ["gửi", "lời"], strong: true },
  { w: ["gửi"], strong: true },
  { w: ["gởi"], strong: true },
  { w: ["nhắn", "tin"], strong: true },
  { w: ["nhắn", "lời"], strong: true },
  { w: ["nhắn"], strong: true },
  { w: ["chuyển", "lời"], strong: true },
  { w: ["chuyển", "tin"], strong: true },
  { w: ["báo", "tin"], strong: false },
  { w: ["báo"], strong: false },
  { w: ["bảo"], strong: false },
  { w: ["nói", "với"], strong: false },
  { w: ["nói", "cho"], strong: false },
  { w: ["dặn"], strong: false },
].sort((a, b) => b.w.length - a.w.length);
const VERB_WORDS = new Set(VERBS.flatMap((v) => v.w).filter((w) => !PREP.has(w) && w !== "tin" && w !== "lời"));

/** Từ nối giữa tên và lời nhắn: "là", "rằng", "biết là", "nội dung là"… */
const SEPS: string[][] = [
  ["nội", "dung", "là"], ["nội", "dung"], ["biết", "là"], ["biết", "rằng"], ["rằng", "là"],
  ["nói", "là"], ["bảo", "là"], ["nhắn", "là"], ["là"], ["rằng"], ["biết"],
].sort((a, b) => b.length - a.length);

/** Từ gợi ý câu có thể là lệnh gửi (để quyết định có hỏi AI không) */
const RELAY_HINT = words("gửi gởi nhắn báo bảo nói dặn chuyển tin");

function seqAt(toks: Tok[], p: number, seq: string[]): boolean {
  if (p < 0 || p + seq.length > toks.length) return false;
  return seq.every((w, k) => toks[p + k].low === w);
}

function sepAt(toks: Tok[], j: number): number {
  for (const s of SEPS) if (seqAt(toks, j, s)) return s.length;
  return 0;
}

/** Bỏ ngoặc kép, dấu chấm cuối câu Whisper hay thêm; giữ "?" và "!" vì mang nghĩa. */
function cleanMessage(s: string): string {
  return s
    .replace(/^[\s"“”'‘’«»:,.\-–]+/u, "")
    .replace(/[\s"“”'‘’«».,;:…\-–]+$/u, "")
    .trim();
}

// --------------------------------------------------------------- tách lệnh ---

type NameForm = { contact: Contact; low: string[]; bare: string[] };

function nameForms(contacts: Contact[]): NameForm[] {
  const out: NameForm[] = [];
  for (const c of contacts) {
    for (const n of [c.name, ...c.aliases]) {
      const t = tokenize(normalizeHeard(n));
      if (t.length) out.push({ contact: c, low: t.map((x) => x.low), bare: t.map((x) => x.bare) });
    }
  }
  return out;
}

type Found = { contacts: Contact[]; end: number };

/** Tên trong danh bạ bắt đầu đúng tại từ thứ p? Ưu tiên tên dài hơn, rồi tới tên đúng cả dấu. */
function matchAt(toks: Tok[], p: number, forms: NameForm[]): Found | null {
  let best: { len: number; exact: boolean; end: number; ids: Map<string, Contact> } | null = null;
  for (const f of forms) {
    const n = f.low.length;
    if (p < 0 || p + n > toks.length) continue;
    let ok = true;
    let exact = true;
    for (let k = 0; k < n; k++) {
      if (toks[p + k].bare !== f.bare[k]) { ok = false; break; }
      if (toks[p + k].low !== f.low[k]) exact = false;
    }
    if (!ok) continue;
    const better = !best || n > best.len || (n === best.len && exact && !best.exact);
    if (better) best = { len: n, exact, end: p + n, ids: new Map([[f.contact.id, f.contact]]) };
    else if (best && n === best.len && exact === best.exact) best.ids.set(f.contact.id, f.contact);
  }
  return best ? { contacts: [...best.ids.values()], end: best.end } : null;
}

type Command = { end: number; prepInVerb: boolean };

/** Lệnh phải đứng ĐẦU câu (sau vài lời gọi như "con ơi"), để không bắt nhầm câu kể chuyện. */
function findCommand(toks: Tok[]): Command | null {
  let subject = false;
  let modal = false;
  for (let i = 0; i < toks.length && i <= 6; i++) {
    for (const v of VERBS) {
      if (!seqAt(toks, i, v.w)) continue;
      // "bà bảo Tuấn là…" thường là kể lại; chỉ coi là lệnh khi có "muốn / nhờ / cần"
      if (!v.strong && subject && !modal) return null;
      return { end: i + v.w.length, prepInVerb: PREP.has(v.w[v.w.length - 1]) };
    }
    const w = toks[i].low;
    if (MODAL.has(w)) modal = true;
    if (SUBJECT.has(w)) subject = true;
    else if (!LEAD.has(w)) return null;
  }
  return null;
}

type Recipient = ({ kind: "found" } & Found) | { kind: "none"; at: number; sawPrep: boolean };

function findRecipient(toks: Tok[], p0: number, forms: NameForm[]): Recipient {
  let sawPrep = false;
  let p = p0;
  for (; p < toks.length && p <= p0 + 5; p++) {
    const direct = matchAt(toks, p, forms);
    if (direct) return { kind: "found", ...direct };
    if (KIN.has(toks[p].low)) {
      const viaKin = matchAt(toks, p + 1, forms);
      if (viaKin) return { kind: "found", ...viaKin };
    }
    const w = toks[p].low;
    if (PREP.has(w)) sawPrep = true;
    else if (!MID.has(w)) break;
  }
  return { kind: "none", at: p, sawPrep };
}

/** Lời nhắn sau tên người nhận: "Tuấn [giúp bà] là <lời nhắn>" hoặc "Tuấn: <lời nhắn>". */
function messageAfter(text: string, toks: Tok[], e: number): string {
  let j = e;
  for (let k = 0; k <= 3 && e + k < toks.length; k++) {
    const s = sepAt(toks, e + k);
    if (s) { j = e + k + s; break; }
    if (!AFTER_NAME.has(toks[e + k].low)) break;
  }
  if (j >= toks.length) return "";
  const msg = cleanMessage(text.slice(toks[j].start));
  return tokenize(msg).every((t) => FILLER_ONLY.has(t.low)) ? "" : msg;
}

/** Tên KHÔNG có trong danh bạ: chỉ nhận dạng rõ ràng "gửi cho <tên> là <lời nhắn>". */
function unknownRecipient(text: string, toks: Tok[], at: number): RelayParse | null {
  if (sepAt(toks, at)) return null; // "gửi cho là …": không nói tên
  for (let j = at + 1; j < toks.length && j <= at + 4; j++) {
    const prev = toks[j - 1].low;
    if (PREP.has(prev) || VERB_WORDS.has(prev)) return null; // "gửi tiền cho Tuấn…" không phải gửi lời nhắn
    const sep = sepAt(toks, j);
    const gap = text.slice(toks[j - 1].end, toks[j].start);
    if (!sep && !/[:,\-–]/.test(gap)) continue;
    const start = j + sep;
    if (start >= toks.length) return null;
    const message = cleanMessage(text.slice(toks[start].start));
    if (!message) return null;
    return { kind: "unknown", name: text.slice(toks[at].start, toks[j - 1].end), message };
  }
  return null;
}

export type RelayParse =
  | { kind: "ok"; contact: Contact; message: string }
  | { kind: "no-message"; contact: Contact }
  | { kind: "ambiguous"; names: string[]; message: string }
  | { kind: "unknown"; name: string; message: string };

/**
 * Tách lệnh "gửi cho <tên> là <lời nhắn>" bằng luật. Trả null nếu câu không
 * phải lệnh gửi tin (khi đó thiết bị trò chuyện bình thường).
 */
export function parseRelayCommand(input: string, contacts: Contact[]): RelayParse | null {
  const text = normalizeHeard(input);
  const toks = tokenize(text);
  const cmd = findCommand(toks);
  if (!cmd) return null;
  const r = findRecipient(toks, cmd.end, nameForms(contacts));
  if (r.kind === "found") {
    const message = messageAfter(text, toks, r.end);
    if (r.contacts.length > 1) return { kind: "ambiguous", names: r.contacts.map((c) => c.name), message };
    if (!message) return { kind: "no-message", contact: r.contacts[0] };
    return { kind: "ok", contact: r.contacts[0], message };
  }
  if (!r.sawPrep && !cmd.prepInVerb) return null;
  return r.at < toks.length ? unknownRecipient(text, toks, r.at) : null;
}

// ------------------------------------------------------- AI cho câu nói lạ ---

/** Chỉ hỏi AI khi câu có tên trong danh bạ VÀ có từ gợi ý gửi tin (tiết kiệm thời gian, hạn mức). */
function worthAskingAi(text: string, contacts: Contact[]): boolean {
  if (!contacts.length || !hasLlm()) return false;
  const toks = tokenize(text);
  if (!toks.some((t) => RELAY_HINT.has(t.low))) return false;
  const forms = nameForms(contacts);
  return toks.some((_, p) => matchAt(toks, p, forms) !== null);
}

function contactByName(contacts: Contact[], name: string): Contact | null {
  const low = normalizeHeard(name).toLocaleLowerCase("vi");
  if (!low) return null;
  const forms = (c: Contact) => [c.name, ...c.aliases].map((n) => normalizeHeard(n).toLocaleLowerCase("vi"));
  const exact = contacts.filter((c) => forms(c).includes(low));
  if (exact.length === 1) return exact[0];
  const loose = contacts.filter((c) => forms(c).some((f) => bareOf(f) === bareOf(low)));
  return loose.length === 1 ? loose[0] : null;
}

/** Đoạn AI đưa ra phải nằm NGUYÊN trong câu nghe được; lấy lại đúng chữ gốc từ câu đó. */
function locate(text: string, piece: string): string | null {
  const p = cleanMessage(normalizeHeard(piece));
  if (p.length < 2) return null;
  const low = text.toLocaleLowerCase("vi");
  if (low.length !== text.length) return text.includes(p) ? p : null;
  const i = low.indexOf(p.toLocaleLowerCase("vi"));
  return i < 0 ? null : cleanMessage(text.slice(i, i + p.length));
}

const AI_PROMPT = (list: string) =>
  `Bạn là bộ phân tích lệnh của thiết bị trợ lý đặt trong phòng người cao tuổi. Đầu vào là câu người cao tuổi vừa nói, đã được máy chuyển thành chữ (có thể sai dấu, sai chính tả).
Danh bạ người nhà: ${list}.
Xác định người nói có đang NHỜ GỬI một lời nhắn tới một người trong danh bạ NGAY BÂY GIỜ hay không.
Chỉ trả về DUY NHẤT một đối tượng JSON, không giải thích:
{"relay": true hoặc false, "contact": "tên đúng như trong danh bạ, hoặc chuỗi rỗng", "message": "lời nhắn cần chuyển"}
Quy tắc:
- relay = false nếu người nói chỉ kể chuyện (ví dụ "hôm qua bà nói với Tuấn là..."), hỏi han, hoặc trò chuyện bình thường.
- message phải CHÉP NGUYÊN VĂN một đoạn liền mạch trong câu đầu vào: không sửa chữ, không thêm hay bớt từ, không đổi xưng hô, không thêm dấu ngoặc.
- message không gồm phần ra lệnh như "gửi cho Tuấn là", "nhắn giúp bà".`;

async function aiParse(text: string, contacts: Contact[]): Promise<RelayParse | null> {
  const list = contacts
    .map((c) => (c.aliases.length ? `${c.name} (còn gọi: ${c.aliases.join(", ")})` : c.name))
    .join("; ");
  const raw = await chat(
    [
      { role: "system", content: AI_PROMPT(list) },
      { role: "user", content: text },
    ],
    { temperature: 0, maxTokens: 700 },
  );
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) return null;
  let j: { relay?: unknown; contact?: unknown; message?: unknown };
  try {
    j = JSON.parse(m[0]) as typeof j;
  } catch {
    return null;
  }
  if (j.relay !== true || typeof j.contact !== "string" || typeof j.message !== "string") return null;
  const contact = contactByName(contacts, j.contact);
  const message = locate(text, j.message);
  // Cả câu bị coi là lời nhắn = AI không bỏ được phần ra lệnh -> không tin
  if (!contact || !message || message.length >= text.length - 3) return null;
  return { kind: "ok", contact, message };
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p.catch(() => fallback), new Promise<T>((res) => setTimeout(() => res(fallback), ms))]);
}

// ------------------------------------------------------------ gửi đi + trả lời ---

const cap = (s: string) => (s ? s[0].toLocaleUpperCase("vi") + s.slice(1) : s);
const joinVi = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} và ${xs[xs.length - 1]}`);
const CHANNEL_VI: Record<Delivery["channel"], string> = { telegram: "Telegram", zalo: "Zalo", email: "email" };
/** Cách trợ lý gọi người cao tuổi khi nói ra loa (không rõ thì "ông bà", như trợ lý trò chuyện). */
const ELDER_ADDR = words("ông bà mẹ bố ba má cụ u bầm");
/** Lời nhắn dài hơn mức này thì loa không đọc lại nguyên văn (đỡ dài dòng) */
const READBACK_MAX = 160;
/** Chống gửi dồn dập (lỗi lặp, nghịch nút): tối đa 10 lần gửi trong 10 phút */
const WINDOW_MS = 10 * 60_000;
const MAX_IN_WINDOW = 10;

function dateTimeVN(ms: number): string {
  const d = new Date(ms + 7 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} ngày ${d.getUTCDate()}/${d.getUTCMonth() + 1}/${d.getUTCFullYear()}`;
}

/** Email: dòng chính giống hệt tin Telegram, kèm một dòng chú thích nhỏ. */
function relayEmail(o: { sent: string; label: string; message: string; how: string }) {
  const short = o.message.length > 70 ? `${o.message.slice(0, 67)}…` : o.message;
  const subject = `${o.label} nhắn: ${short}`;
  const html = `<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f5fb;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5fb;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 6px 24px rgba(16,33,72,.08);font-family:'Segoe UI',Arial,sans-serif;">
<tr><td style="background:#16306e;padding:16px 24px;border-bottom:3px solid #e3a21a;">
<div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#f6cf5a;font-weight:700;">OALPHA · Lời nhắn</div></td></tr>
<tr><td style="padding:22px 24px 10px;font-size:18px;line-height:1.55;color:#16213c;font-weight:600;">${escapeHtml(o.sent)}</td></tr>
<tr><td style="padding:4px 24px 20px;font-size:13px;line-height:1.5;color:#5a6681;">${escapeHtml(o.how)}</td></tr>
<tr><td style="background:#f8fafc;padding:12px 24px;border-top:1px solid #e2e7f1;font-size:12px;color:#95a0b8;">Email tự động từ hệ thống OALPHA, vui lòng không trả lời thư này.</td></tr>
</table></td></tr></table></body></html>`;
  const text = `${o.sent}\n\n${o.how}\nEmail tự động từ hệ thống OALPHA.`;
  return { subject, html, text };
}

/** Gửi tới mọi kênh người nhận có (song song). */
async function deliver(contact: Contact, sent: string, email: ReturnType<typeof relayEmail>): Promise<Delivery[]> {
  const jobs: Promise<Delivery>[] = [];
  if (contact.telegramChatId) jobs.push(sendTelegramText(contact.telegramChatId, sent));
  if (contact.zaloChatId) jobs.push(sendZaloText(contact.zaloChatId, sent));
  if (contact.email) jobs.push(sendEmail(contact.email, email.subject, email.html, email.text));
  return Promise.all(jobs);
}

export type RelayOutcome = {
  /** Câu loa đọc lại cho người cao tuổi */
  reply: string;
  relay: RelayInfo;
  /** Câu nói lạ, phải nhờ AI tách */
  ai: boolean;
};

/** Kết quả tách lệnh, chưa gửi gì (dùng cho "Xem trước" trên trang Cài đặt). */
export type RelayPlan = { text: string; parsed: RelayParse; ai: boolean };

/** Tên người gửi in trước lời nhắn (Cài đặt), mặc định "Người thân". */
export function relayLabelOf(s: { relayLabel?: string }): string {
  return s.relayLabel?.trim() || DEFAULT_SETTINGS.relayLabel;
}

/** Câu có phải lệnh gửi tin không, gửi cho ai, lời nhắn gì. Không phải -> null. */
export async function planRelay(heard: string): Promise<RelayPlan | null> {
  const text = normalizeHeard(heard).slice(0, 600);
  if (!text) return null;
  const contacts = await getContacts();
  let parsed = parseRelayCommand(text, contacts);
  let ai = false;
  if (!parsed && worthAskingAi(text, contacts)) {
    // Có giới hạn thời gian: ESP32 chỉ chờ câu trả lời khoảng 15 giây
    parsed = await withTimeout(aiParse(text, contacts), 9000, null);
    ai = parsed !== null;
  }
  return parsed ? { text, parsed, ai } : null;
}

/**
 * Xử lý câu người cao tuổi nói với thiết bị. Không phải lệnh gửi tin -> null
 * (route gọi tiếp trợ lý trò chuyện). Là lệnh gửi tin -> gửi đi, ghi nhật ký,
 * trả câu để loa đọc (kể cả khi không gửi được, để ông/bà biết).
 *
 * @param channel "thiet-bi" = nói qua mic ESP32; "web" = gõ thử trên trang Cài đặt
 */
export async function relayFromElder(heard: string, channel: "thiet-bi" | "web"): Promise<RelayOutcome | null> {
  const plan = await planRelay(heard);
  return plan ? executeRelay(plan, channel) : null;
}

async function executeRelay(plan: RelayPlan, channel: "thiet-bi" | "web"): Promise<RelayOutcome> {
  const { text, parsed, ai } = plan;
  const [contacts, settings] = await Promise.all([getContacts(), getSettings()]);
  const label = relayLabelOf(settings);
  const st = pollerSnapshot().status;
  const call = elderCallOf(settings, st?.device.name);
  const addr = ELDER_ADDR.has(call) ? call : "ông bà";
  const now = Date.now();

  let status: RelayStatus;
  let reply: string;
  let to = "";
  let contactId: string | null = null;
  let message = "";
  let sent = "";
  let delivery: Delivery[] = [];

  if (parsed.kind === "unknown") {
    status = "khong-co-ten";
    to = parsed.name;
    message = parsed.message;
    reply = contacts.length
      ? `Dạ, trong danh bạ chưa có tên ${parsed.name}. Con gửi được cho ${joinVi(contacts.slice(0, 5).map((c) => c.name))} ạ.`
      : "Dạ, danh bạ người nhà đang trống nên con chưa gửi được. Nhờ con cháu thêm tên và Telegram hoặc Zalo vào phần Cài đặt của OALPHA giúp con nhé.";
  } else if (parsed.kind === "ambiguous") {
    status = "trung-ten";
    to = parsed.names.join(", ");
    message = parsed.message;
    reply = `Dạ, trong danh bạ có ${joinVi(parsed.names)} tên gần giống nhau. ${cap(addr)} nói rõ tên giúp con nhé.`;
  } else if (parsed.kind === "no-message") {
    status = "thieu-loi-nhan";
    to = parsed.contact.name;
    contactId = parsed.contact.id;
    reply = `Dạ, ${addr} muốn nhắn gì cho ${to} ạ? ${cap(addr)} giữ nút rồi nói cả câu giúp con, ví dụ: gửi cho ${to} là tối nay nhớ gọi điện nhé.`;
  } else {
    const c = parsed.contact;
    to = c.name;
    contactId = c.id;
    message = parsed.message;
    sent = `${label}: "${message}"`;
    const recent = (await getInteractions(300)).filter(
      (m) => m.kind === "gui-di" && m.at > now - WINDOW_MS && (m.relay?.delivery.length ?? 0) > 0,
    );
    if (!c.telegramChatId && !c.zaloChatId && !c.email) {
      status = "chua-co-kenh";
      reply = `Dạ, ${to} chưa có Telegram, Zalo hay email trong danh bạ nên con chưa gửi được ạ.`;
    } else if (recent.length >= MAX_IN_WINDOW) {
      status = "qua-nhieu";
      reply = `Dạ, mấy phút nay con đã gửi nhiều tin quá rồi. Lát nữa ${addr} nhắn lại giúp con nhé.`;
    } else {
      const how =
        channel === "thiet-bi"
          ? `${cap(call)} nói với thiết bị OALPHA${st?.device.place ? ` (${st.device.place})` : ""} lúc ${dateTimeVN(now)}. Lời nhắn do máy nghe và chép lại nên có thể sai vài chữ.`
          : `Gửi thử từ trang web OALPHA lúc ${dateTimeVN(now)}.`;
      delivery = await deliver(c, sent, relayEmail({ sent, label, message, how }));
      const okCh = delivery.filter((d) => d.ok).map((d) => CHANNEL_VI[d.channel]);
      const badCh = delivery.filter((d) => !d.ok).map((d) => CHANNEL_VI[d.channel]);
      const quote = message.length <= READBACK_MAX ? `: "${message}"` : "";
      if (!badCh.length) {
        status = "da-gui";
        reply = `Dạ, con đã gửi cho ${to} qua ${joinVi(okCh)}${quote}.`;
      } else if (okCh.length) {
        status = "gui-mot-phan";
        reply = `Dạ, con đã gửi cho ${to} qua ${joinVi(okCh)}${quote}. Riêng ${joinVi(badCh)} chưa gửi được.`;
      } else {
        status = "loi";
        reply = `Dạ, con chưa gửi được lời nhắn cho ${to}. ${cap(addr)} thử lại sau, hoặc gọi điện cho ${to} nhé.`;
      }
      for (const d of delivery) if (!d.ok) console.warn(`[gui-di] ${d.channel} toi ${to} loi: ${d.error}`);
    }
  }

  const relay: RelayInfo = { to, contactId, message, sent, status, delivery };
  await addInteraction({
    id: newId("tt"),
    at: now,
    channel,
    kind: "gui-di",
    from: label,
    chatId: null,
    text: text.slice(0, 1000),
    reply,
    spokenText: null,
    speak: null,
    ai,
    relay,
  });
  return { reply, relay, ai };
}

/** Tin thử khi bấm "Gửi thử" trong danh bạ: để người nhận biết tin từ thiết bị sẽ trông thế nào. */
export async function sendTestToContact(contact: Contact): Promise<Delivery[]> {
  const settings = await getSettings();
  const label = relayLabelOf(settings);
  const call = elderCallOf(settings, pollerSnapshot().status?.device.name);
  const sent = `OALPHA: tin nhắn thử. Từ nay khi ${call} nói với thiết bị "gửi cho ${contact.name} là …", lời nhắn sẽ tới đây dạng:\n${label}: "…"`;
  const how = `Gửi thử từ trang Cài đặt của OALPHA lúc ${dateTimeVN(Date.now())}.`;
  const mail = relayEmail({ sent, label, message: "tin nhắn thử", how });
  return deliver(contact, sent, { ...mail, subject: "OALPHA: tin nhắn thử" });
}
