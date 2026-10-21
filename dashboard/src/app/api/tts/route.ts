/**
 * GET /api/tts?text=...&voice=...&format=mp3|wav
 *
 * Đọc tiếng Việt bằng giọng Neural của Microsoft Edge (miễn phí, không cần key).
 *   - format=mp3 (mặc định): MP3 24 kHz cho trình duyệt và trợ lý ESP32 (ESP8266Audio)
 *   - format=wav: WAV PCM 16-bit mono 16 kHz, đúng định dạng loa ESP32 phát được
 *     (dùng để tạo lại các file data/*.wav bằng cùng một giọng)
 * Câu chữ được làm sạch trước khi đọc (xem normalizeForSpeech trong lib/tts.ts):
 * đây chính là chỗ làm giọng web hết "gượng".
 *
 * Trả về: 200 audio/mpeg | audio/wav; 400 thiếu/quá dài; 502 lỗi dịch vụ đọc.
 */
import { NextResponse } from "next/server";
import { getSettings } from "@/lib/store";
import { normalizeForSpeech, pickVoice, synthesizeMp3, synthesizeSpeakerWav } from "@/lib/tts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_TEXT_LEN = 1000;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const text = (url.searchParams.get("text") ?? "").trim();
  if (!text) return NextResponse.json({ error: "Thiếu tham số 'text'." }, { status: 400 });
  if (text.length > MAX_TEXT_LEN) {
    return NextResponse.json({ error: `Văn bản quá dài (tối đa ${MAX_TEXT_LEN} ký tự).` }, { status: 400 });
  }
  const settings = await getSettings();
  const voice = pickVoice(url.searchParams.get("voice") ?? settings.ttsVoice);

  try {
    if (url.searchParams.get("format") === "wav") {
      const { wav } = await synthesizeSpeakerWav(text, voice, { chime: url.searchParams.get("chime") === "1" });
      return new NextResponse(new Uint8Array(wav), {
        status: 200,
        headers: { "Content-Type": "audio/wav", "Content-Length": String(wav.length), "Cache-Control": "no-store" },
      });
    }
    const mp3 = await synthesizeMp3(normalizeForSpeech(text), voice);
    return new NextResponse(new Uint8Array(mp3), {
      status: 200,
      headers: { "Content-Type": "audio/mpeg", "Content-Length": String(mp3.length), "Cache-Control": "no-store" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Lỗi TTS: ${msg}` }, { status: 502 });
  }
}
