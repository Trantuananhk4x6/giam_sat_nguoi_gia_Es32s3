/**
 * "Bộ não" chung khi NGƯỜI NHÀ tương tác — Telegram, Zalo và trang web dùng cùng
 * một đường xử lý nên trả lời giống nhau và đều được ghi vào nhật ký tương tác.
 *
 *   /hoitham <lời nhắn>  AI biên tập thành câu thông báo -> đọc giọng -> loa ESP32
 *   /tinhhinh            tình hình ngay lúc này (không cần AI, luôn trả lời được)
 *   /homnay              AI tóm tắt cả ngày
 *   /hoi <câu hỏi>       hỏi trợ lý (trong nhóm Telegram phải dùng lệnh)
 *   /chatid              báo mã chat (để khai vào danh sách được phép)
 *   tin nhắn thường      hỏi trợ lý, ví dụ "hôm nay mẹ thế nào?"
 */
import { sendSay } from "./esp32";
import { getOverview, overviewBrief, ruleSummary, timeVN, type Overview } from "./health";
import { chat, hasLlm, plainText, type LlmMessage } from "./llm";
import { pollNow } from "./poller";
import { addInteraction, getSettings, newId } from "./store";
import { normalizeForSpeech, pickVoice, synthesizeSpeakerWav } from "./tts";
import type { Interaction, SpeakStatus } from "./types";

export type Channel = "telegram" | "zalo" | "web";
export type ChatTurn = { role: "user" | "assistant"; content: string };

export type BotInput = {
  channel: Channel;
  from: string;
  chatId: string | null;
  text: string;
  /** Lịch sử ngắn của khung chat trên web (Telegram / Zalo không gửi lịch sử) */
  history?: ChatTurn[];
};

export type BotOutput = {
  reply: string;
  kind: Interaction["kind"];
  ai: boolean;
  spoken: { text: string; status: SpeakStatus; seconds: number | null } | null;
};

type Command = "hoitham" | "tinhhinh" | "homnay" | "hoi" | "help" | "chatid";
const ALIASES: Record<string, Command> = {
  hoitham: "hoitham", loinhan: "hoitham", nhan: "hoitham",
  tinhhinh: "tinhhinh", status: "tinhhinh",
  homnay: "homnay", today: "homnay",
  hoi: "hoi", ask: "hoi",
  start: "help", help: "help", huongdan: "help",
  chatid: "chatid", id: "chatid",
};

/** Tách "/lenh@TenBot nội dung" -> { cmd, arg }. Không phải lệnh thì cmd = null. */
export function parseCommand(text: string): { cmd: Command | null; arg: string } {
  const m = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return { cmd: null, arg: text.trim() };
  const cmd = ALIASES[m[1].toLowerCase()] ?? null;
  return cmd ? { cmd, arg: (m[2] ?? "").trim() } : { cmd: null, arg: text.trim() };
}

const cap = (s: string) => (s ? s[0].toLocaleUpperCase("vi") + s.slice(1) : s);

export function helpText(call: string): string {
  return [
    `👋 Em là trợ lý OALPHA, theo dõi ${call} qua radar trong phòng.`,
    "",
    `• Hỏi tự nhiên: “Hôm nay ${call} thế nào?”`,
    `• /hoitham <lời nhắn> — loa trong phòng đọc lời nhắn cho ${call} nghe`,
    `   ví dụ: /hoitham ${call} ơi, 10h con gọi về nha`,
    "• /tinhhinh — tình hình ngay lúc này",
    "• /homnay — tóm tắt cả ngày",
    "• /hoi <câu hỏi> — hỏi trợ lý (dùng khi chat trong nhóm)",
    "",
    "Cảnh báo té ngã vẫn do thiết bị tự gửi, kể cả khi máy tính tắt.",
  ].join("\n");
}

// ------------------------------------------------------ hỏi đáp có dữ liệu ---

function qaSystemPrompt(call: string, channel: Channel): string {
  return `Bạn là trợ lý chăm sóc của hệ thống OALPHA (radar 60 GHz đặt trong phòng). Bạn trả lời NGƯỜI NHÀ (con cháu) hỏi thăm về người cao tuổi mà họ gọi là "${call}". Xưng "em", gọi người hỏi là "anh/chị"; nếu người hỏi gọi người cao tuổi bằng từ khác (mẹ, bà, bố...) thì dùng đúng từ đó.

QUY TẮC BẮT BUỘC:
- Chỉ dựa vào DỮ LIỆU HỆ THỐNG được cung cấp. Không bịa. Radar chỉ biết: có người trong phòng hay không, đi lại hay nằm/ngồi yên, nghi ngã, nút bấm "Tôi ổn"/SOS; nhịp tim/nhịp thở chỉ có khi bật chế độ giấc ngủ. Hỏi điều radar không biết (ăn uống, uống thuốc, tâm trạng...) thì nói thật là hệ thống không đo được và gợi ý gọi điện hỏi thăm.
- "Mức độ do hệ thống xác định" là sự thật: nếu KHẨN CẤP hoặc CẦN CHÚ Ý vì nghi ngã thì câu đầu tiên phải nói rõ và khuyên gọi/tới kiểm tra ngay; lúc đó giọng nghiêm túc, KHÔNG dùng emoji vui, không đùa.
- Luôn xưng "em" (không xưng "mình", "tôi").
- "Nghi ngã" là radar NGHI NGỜ, không được nói thành "đã ngã"; nếu sau đó có bấm "Tôi ổn" thì nói rõ là đã xác nhận ổn.
- Không chẩn đoán bệnh, không khuyên dùng thuốc. Sinh hiệu là ước lượng bằng radar, không phải thiết bị y tế.
- Trả lời 2-5 câu, văn xuôi tiếng Việt có dấu, ấm áp, rõ ràng. Không markdown, không gạch đầu dòng. Được dùng tối đa 1 emoji ở đầu câu.
- Diễn đạt bằng lời thường cho người không rành kỹ thuật: nói "đi lại khá nhiều", "nằm nghỉ yên" thay vì đọc con số kiểu 42/100; không nhắc chi tiết kỹ thuật (khởi động lại, Wi-Fi...) trừ khi nó làm mất theo dõi.
- Muốn nhắn gì cho ${call} nghe qua loa thì hướng dẫn: ${channel === "web" ? "gõ /hoitham <lời nhắn> hoặc dùng trang Gửi lời nhắn" : "gõ /hoitham <lời nhắn>"}.`;
}

async function answerQuestion(input: BotInput, question: string, o: Overview): Promise<{ text: string; ai: boolean }> {
  const fallback = () => `📋 ${ruleSummary(o)}`;
  if (!hasLlm()) return { text: fallback(), ai: false };
  const messages: LlmMessage[] = [
    { role: "system", content: qaSystemPrompt(o.call, input.channel) },
    { role: "system", content: `DỮ LIỆU HỆ THỐNG (cập nhật ${timeVN(Date.now())}):\n${overviewBrief(o)}` },
  ];
  for (const h of (input.history ?? []).slice(-10)) messages.push({ role: h.role, content: h.content });
  messages.push({ role: "user", content: question });
  try {
    const text = plainText(await chat(messages, { temperature: 0.4 }));
    // Nghi ngã / khẩn cấp: luôn đặt câu cảnh báo do code sinh lên đầu, phòng AI viết lệch.
    const guard = o.level === "khan-cap" || o.level === "chu-y" ? `⚠️ ${o.headline}. ${o.detail}\n\n` : "";
    return { text: guard + text, ai: true };
  } catch (err) {
    console.warn("[tro-ly] AI loi, dung tom tat tu dong:", err instanceof Error ? err.message : err);
    return { text: fallback(), ai: false };
  }
}

const SUMMARY_PROMPT = (call: string) =>
  `Bạn là trợ lý chăm sóc của hệ thống OALPHA. Viết NHẬN XÉT ngắn (3-5 câu) gửi người nhà về tình hình của "${call}" hôm nay, chỉ dựa vào dữ liệu được cung cấp, không bịa. Xưng "em", gọi người đọc là "anh/chị". Câu đầu nêu tình trạng chung đúng với "Mức độ do hệ thống xác định". Sau đó nêu điều đáng chú ý trong ngày (nghi ngã, bấm nút, ra vào phòng, sinh hiệu nếu có) và gợi ý MỘT việc cụ thể người nhà nên làm (ví dụ gọi điện hỏi thăm). "Nghi ngã" là radar nghi ngờ, không được viết thành "đã ngã"; có bấm "Tôi ổn" sau đó thì nói là đã xác nhận ổn. Dùng lời thường, không đọc con số kỹ thuật kiểu 42/100, không nhắc chuyện thiết bị khởi động lại hay Wi-Fi trừ khi làm mất theo dõi. Không chẩn đoán bệnh, không khuyên thuốc. Văn xuôi tiếng Việt, không markdown.`;

let summaryCache: { at: number; key: string; text: string; ai: boolean } | null = null;

/** Nhận xét cho trang Tổng quan; lưu đệm 5 phút để không tốn hạn mức Groq. */
export async function overviewComment(force = false): Promise<{ text: string; ai: boolean; at: number; level: string }> {
  const o = await getOverview();
  const key = `${o.level}|${o.state}|${o.timeline[0]?.key ?? ""}|${o.online}`;
  if (!force && summaryCache && summaryCache.key === key && Date.now() - summaryCache.at < 5 * 60_000) {
    return { text: summaryCache.text, ai: summaryCache.ai, at: summaryCache.at, level: o.level };
  }
  let text = ruleSummary(o);
  let ai = false;
  if (hasLlm()) {
    try {
      text = plainText(
        await chat(
          [
            { role: "system", content: SUMMARY_PROMPT(o.call) },
            { role: "user", content: overviewBrief(o) },
          ],
          { temperature: 0.4 },
        ),
      );
      ai = true;
    } catch (err) {
      console.warn("[tong-quan] AI loi:", err instanceof Error ? err.message : err);
    }
  }
  summaryCache = { at: Date.now(), key, text, ai };
  return { text, ai, at: summaryCache.at, level: o.level };
}

// -------------------------------------------------- lời nhắn đọc ra loa ---

const SPEAKER_PROMPT = (call: string, from: string) =>
  `Bạn biên tập lời nhắn của người nhà thành MỘT câu thông báo để loa trong phòng đọc cho người cao tuổi nghe.
- Người nhắn tên "${from}". Người nghe thường được gọi là "${call}".
- Giữ nguyên mọi thông tin: giờ, ngày, tên, việc sẽ làm. TUYỆT ĐỐI không thêm thông tin, lời khuyên hay lời chúc mới.
- Mở đầu bằng lời gọi và tên người nhắn, ví dụ "Mẹ ơi, con Tuấn nhắn: ...". Tin gọi "mẹ/bố/ba/má" thì người nhắn là "con"; gọi "bà/ông" thì là "cháu"; không rõ thì dùng "${call}" và "${from} nhắn".
- Thuật lại ở ngôi thứ ba cho rõ ai làm gì, ví dụ "10h con gọi về nha" thành "10 giờ con Tuấn sẽ gọi điện về cho mẹ nhé".
- Viết giờ dễ đọc ("10h" -> "10 giờ", "10h30" -> "10 giờ 30"); bỏ emoji, ký hiệu, viết tắt.
- Giọng ấm áp, lễ phép, tối đa 40 từ. Chỉ trả về đúng câu thông báo, không ngoặc kép, không giải thích.`;

/** Từ mà thiếu đi là đổi nghĩa lời nhắn (giờ giấc, ngày, phủ định). */
const FACT_WORDS = [
  "sáng", "trưa", "chiều", "tối", "đêm", "nay", "mai", "mốt", "qua", "tuần", "tháng",
  "thứ", "chủ nhật", "không", "chưa", "đừng", "nhớ", "uống", "ăn", "khám",
];

/** Các "dữ kiện" phải còn nguyên trong câu loa đọc: mọi con số + từ khóa ở trên. */
export function missingFacts(original: string, rewritten: string): string[] {
  const a = normalizeForSpeech(original).toLocaleLowerCase("vi");
  const b = normalizeForSpeech(rewritten).toLocaleLowerCase("vi");
  const has = (s: string, w: string) => new RegExp(`(?<![\\p{L}\\d])${w}(?![\\p{L}\\d])`, "u").test(s);
  const facts = new Set<string>(a.match(/\d+/g) ?? []);
  for (const w of FACT_WORDS) if (has(a, w)) facts.add(w);
  return [...facts].filter((f) => !has(b, f));
}

/** Câu loa sẽ đọc. Không có AI (hoặc AI làm rơi dữ kiện) thì dùng câu mẫu, vẫn đủ ý. */
export async function speakerSentence(from: string, message: string, call: string): Promise<{ text: string; ai: boolean }> {
  const who = from.trim() || "người nhà";
  const template = `${cap(call)} ơi, có lời nhắn từ ${who}: ${normalizeForSpeech(message)}`;
  if (!hasLlm()) return { text: template, ai: false };
  for (const temperature of [0.2, 0]) {
    try {
      const t = plainText(
        await chat(
          [
            { role: "system", content: SPEAKER_PROMPT(call, who) },
            { role: "user", content: message.slice(0, 500) },
          ],
          { temperature, maxTokens: 800 },
        ),
      ).replace(/^["“”']+|["“”']+$/g, "");
      const lost = t ? missingFacts(message, t) : ["(rỗng)"];
      if (t && t.length <= 320 && lost.length === 0) return { text: t, ai: true };
      console.warn("[loi-nhan] AI lam roi du kien", lost, "->", t);
    } catch {
      break;
    }
  }
  return { text: template, ai: false };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Đọc câu thành WAV rồi đẩy xuống ESP32; loa bận thì thử lại vài lần. */
export async function deliverToSpeaker(
  sentence: string,
  from: string,
  o: Overview,
): Promise<{ status: SpeakStatus; seconds: number | null; detail: string }> {
  if (!o.online) return { status: "mat-ket-noi", seconds: null, detail: o.error ?? "" };
  if (o.level === "khan-cap" || o.state === "NGHI_NGO_TE_NGA") {
    return { status: "dang-canh-bao", seconds: null, detail: "" };
  }
  const settings = await getSettings();
  let wav: Buffer;
  let seconds: number;
  try {
    const out = await synthesizeSpeakerWav(sentence, pickVoice(settings.ttsVoice), { chime: true });
    wav = out.wav;
    seconds = Math.round(out.seconds * 10) / 10;
  } catch (err) {
    return { status: "loi", seconds: null, detail: `không tạo được giọng đọc: ${err instanceof Error ? err.message : err}` };
  }
  let last = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await sendSay(settings.esp32Host, wav, from);
    if (r.ok) {
      void pollNow().catch(() => undefined);
      return { status: "da-gui", seconds, detail: "" };
    }
    last = r.err;
    if (r.status === 423) return { status: "dang-canh-bao", seconds, detail: "" };
    if (r.status === 404) return { status: "loi", seconds, detail: "firmware chưa có /api/say, hãy nạp firmware mới" };
    if (r.status !== 409) return { status: r.status === 0 ? "mat-ket-noi" : "loi", seconds, detail: r.err };
    await sleep(4000); // loa đang đọc dở thứ khác
  }
  return { status: "loa-ban", seconds, detail: last };
}

const SPEAK_REPLY: Record<SpeakStatus, string> = {
  "da-gui": "✅ Loa trong phòng đang đọc lời nhắn",
  "loa-ban": "⏳ Loa đang bận đọc thứ khác, lời nhắn chưa phát được. Anh/chị gửi lại sau ít phút nhé",
  "dang-canh-bao": "⚠️ Thiết bị đang xử lý cảnh báo té ngã nên chưa đọc lời nhắn",
  "mat-ket-noi": "📵 Không liên lạc được thiết bị trong phòng nên lời nhắn chưa phát",
  "qua-cu": "⌛ Tin nhắn tới quá muộn nên không đọc nữa",
  loi: "❌ Không gửi được lời nhắn xuống loa",
};

/** Xử lý một tin của người nhà, ghi nhật ký rồi trả câu trả lời. */
export async function handleFamilyMessage(input: BotInput): Promise<BotOutput> {
  const { cmd, arg } = parseCommand(input.text);
  const o = await getOverview();
  let out: BotOutput;

  if (cmd === "help") {
    out = { reply: helpText(o.call), kind: "lenh", ai: false, spoken: null };
  } else if (cmd === "chatid") {
    out = { reply: `Mã chat này là: ${input.chatId ?? "(trang web)"}`, kind: "lenh", ai: false, spoken: null };
  } else if (cmd === "tinhhinh") {
    out = { reply: `📋 ${timeVN(Date.now())} · ${ruleSummary(o)}`, kind: "lenh", ai: false, spoken: null };
  } else if (cmd === "hoitham") {
    if (!arg) {
      out = {
        reply: `Anh/chị gõ lời nhắn ngay sau lệnh, ví dụ:\n/hoitham ${o.call} ơi, 10h con gọi về nha`,
        kind: "lenh", ai: false, spoken: null,
      };
    } else {
      const s = await speakerSentence(input.from, arg, o.call);
      const d = await deliverToSpeaker(s.text, input.from, o);
      const tail = d.detail && d.status !== "da-gui" ? ` (${d.detail})` : "";
      out = {
        reply: `${SPEAK_REPLY[d.status]}${tail}.\n🔊 “${s.text}”`,
        kind: "hoitham", ai: s.ai,
        spoken: { text: s.text, status: d.status, seconds: d.seconds },
      };
    }
  } else {
    const question = cmd === "homnay" ? `Tóm tắt tình hình hôm nay của ${o.call}.` : arg;
    if (!question) {
      out = { reply: helpText(o.call), kind: "lenh", ai: false, spoken: null };
    } else {
      const a = await answerQuestion(input, question, o);
      out = { reply: a.text, kind: "hoi", ai: a.ai, spoken: null };
    }
  }

  await addInteraction({
    id: newId("tt"),
    at: Date.now(),
    channel: input.channel,
    kind: out.kind,
    from: input.from || "Người nhà",
    chatId: input.chatId,
    text: input.text.slice(0, 1000),
    reply: out.reply.slice(0, 2000),
    spokenText: out.spoken?.text ?? null,
    speak: out.spoken?.status ?? null,
    ai: out.ai,
  });
  return out;
}

/** Ghi lại tin của người lạ / tin quá cũ mà không xử lý. */
export async function logSkipped(i: Omit<Interaction, "id" | "at">): Promise<void> {
  await addInteraction({ ...i, id: newId("tt"), at: Date.now() });
}
