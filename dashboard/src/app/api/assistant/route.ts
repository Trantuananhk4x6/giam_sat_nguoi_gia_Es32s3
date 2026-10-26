/**
 * POST /api/assistant  (HỢP ĐỒNG API CỐ ĐỊNH cho FIRMWARE ESP32)
 *
 * Luồng: ESP32 ghi âm từ mic -> gửi file WAV lên đây -> server chuyển giọng nói
 * thành văn bản (Groq STT Whisper) -> kiểm tra lệnh nhắn người nhà (relayFromElder)
 * -> nếu không phải lệnh nhắn thì đưa văn bản vào trợ lý trò chuyện -> trả
 * câu trả lời dạng TEXT cho ESP32.
 *
 * ESP32 sau đó gọi GET /api/tts?text=<reply> để lấy audio phát ra loa.
 *
 * ---- HỢP ĐỒNG (firmware phải khớp đúng) ----
 * Request:  multipart/form-data
 *   - field "audio": file WAV PCM 16-bit mono 16kHz (bắt buộc)
 * Response: application/json
 *   200 { "heard": string, "reply": string, "relay"?: RelayInfo }
 *       heard = văn bản STT nghe được (có thể rỗng nếu không nghe rõ)
 *       reply = câu trả lời của trợ lý (luôn khác rỗng)
 *       relay = thông tin gửi lời nhắn cho người nhà (nếu là câu lệnh gửi tin)
 *   400  { "error": string }  (thiếu GROQ_API_KEY / thiếu field "audio" / file quá lớn)
 *   502  { "error": string }  (Groq STT hoặc chat lỗi)
 */
import { NextResponse } from "next/server";
import { askAssistant } from "@/lib/assistant";
import { relayFromElder } from "@/lib/relay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/** Model STT trên Groq (Whisper). */
const GROQ_STT_MODEL = "whisper-large-v3";

/** Giới hạn kích thước file audio upload (8 MB ~ đủ cho vài chục giây WAV 16kHz). */
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

/** Câu hỏi lại nhẹ nhàng khi STT không nghe được gì. */
const REPLY_WHEN_SILENT =
  "Dạ con chưa nghe rõ, ông/bà nói lại giúp con nhé.";

/** Cấu trúc tối thiểu của phản hồi STT từ Groq. */
type GroqSttResponse = { text?: string };

/**
 * Gửi file audio lên Groq STT (Whisper, tiếng Việt) và trả về văn bản nghe được.
 */
async function transcribe(audio: File): Promise<string> {
  const key = process.env.GROQ_API_KEY!;
  const form = new FormData();
  form.append("file", audio, audio.name || "audio.wav");
  form.append("model", GROQ_STT_MODEL);
  form.append("language", "vi");
  // response_format mặc định là json { text }.
  form.append("response_format", "json");

  const res = await fetch(
    "https://api.groq.com/openai/v1/audio/transcriptions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(45_000),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Groq STT trả về HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as GroqSttResponse;
  return (json.text ?? "").trim();
}

export async function POST(req: Request) {
  if (!process.env.GROQ_API_KEY) {
    return NextResponse.json(
      {
        error:
          "Chưa khai GROQ_API_KEY trong dashboard/.env.local. " +
          "Lấy key miễn phí ở https://console.groq.com/keys",
      },
      { status: 400 },
    );
  }

  // Đọc multipart/form-data, lấy field "audio".
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Yêu cầu phải là multipart/form-data." },
      { status: 400 },
    );
  }

  const audio = form.get("audio");
  if (!(audio instanceof File)) {
    return NextResponse.json(
      { error: "Thiếu field 'audio' (file WAV) trong form-data." },
      { status: 400 },
    );
  }
  if (audio.size === 0) {
    return NextResponse.json(
      { error: "File 'audio' rỗng." },
      { status: 400 },
    );
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    return NextResponse.json(
      { error: `File 'audio' quá lớn (tối đa ${MAX_AUDIO_BYTES} byte).` },
      { status: 400 },
    );
  }

  try {
    // Bước 1: STT — chuyển giọng nói thành văn bản.
    const heard = await transcribe(audio);

    // Bước 2: nếu không nghe rõ thì hỏi lại.
    if (!heard) {
      return NextResponse.json({ heard, reply: REPLY_WHEN_SILENT });
    }

    // Bước 3: Kiểm tra xem ông/bà có đang nhờ nhắn tin cho người nhà không ("gửi cho Tuấn là...").
    const relayOut = await relayFromElder(heard, "thiet-bi");
    if (relayOut !== null) {
      return NextResponse.json({
        heard,
        reply: relayOut.reply,
        relay: relayOut.relay,
      });
    }

    // Bước 4: Không phải lệnh gửi tin -> trò chuyện với trợ lý AI như bình thường.
    const reply = await askAssistant([{ role: "user", content: heard }]);
    return NextResponse.json({ heard, reply });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
