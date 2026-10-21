/**
 * Tổng hợp giọng nói tiếng Việt — dùng CHUNG cho web (MP3) và loa ESP32 (WAV).
 *
 * ENGINE: Microsoft Edge Neural TTS (miễn phí, không cần key) qua gói msedge-tts.
 * Dịch vụ miễn phí này chỉ trả MP3/WebM, còn loa ESP32 cần WAV PCM 16-bit mono
 * 16 kHz, nên phía máy chủ tự giải mã MP3 (mpg123-decoder, WebAssembly) rồi đổi
 * tần số lấy mẫu. ESP32 chỉ việc phát file WAV như các câu hỏi thăm sẵn có.
 *
 * VÌ SAO TRƯỚC ĐÂY NGHE "GƯỢNG": giọng và tốc độ đọc đã giống hệt file mẫu
 * nghe_thu_nu.mp3 (HoaiMy, -8%: cùng câu chữ thì dài 12,98 s, file mẫu 13,01 s).
 * Chỗ khác là CÂU CHỮ đưa vào: câu trả lời của AI có "ông/bà", dấu * của
 * markdown, emoji, "10h"... nên máy đọc vấp như người nước ngoài.
 * normalizeForSpeech() làm sạch câu trước khi đọc.
 */
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { MPEGDecoder } from "mpg123-decoder";

export const VOICES = {
  "vi-VN-HoaiMyNeural": "Hoài My (nữ)",
  "vi-VN-NamMinhNeural": "Nam Minh (nam)",
} as const;
export type VoiceId = keyof typeof VOICES;
export const DEFAULT_VOICE: VoiceId = "vi-VN-HoaiMyNeural";

/** Giống file mẫu người dùng đã duyệt: chậm hơn mặc định một chút cho người già. */
const RATE = "-8%";
/** Tần số lấy mẫu của file WAV gửi xuống loa (khớp config.h của firmware). */
export const SPEAKER_RATE = 16000;

export function pickVoice(v: string | null | undefined): VoiceId {
  return v && v in VOICES ? (v as VoiceId) : DEFAULT_VOICE;
}

// ------------------------------------------------------- làm sạch câu chữ ---

/** Từ viết tắt hay gặp khi người nhà nhắn tin (chỉ thay khi đứng riêng một từ). */
const SHORTHAND: Record<string, string> = {
  k: "không", ko: "không", kg: "không", hok: "không",
  dc: "được", đc: "được", j: "gì", mn: "mọi người", ok: "ô kê",
};
const KIN = "ông|bà|anh|chị|cô|chú|bác|cậu|mợ|dì|con|cháu|em|bố|mẹ|ba|má";

/** Biến câu bất kỳ (câu AI, tin nhắn) thành câu máy đọc trôi chảy. */
export function normalizeForSpeech(input: string): string {
  let s = ` ${input} `;
  s = s.replace(/https?:\/\/\S+/g, " ");
  s = s.replace(/\p{Extended_Pictographic}/gu, " ").replace(/[\u{FE0F}\u{200D}]/gu, "");
  s = s.replace(/[*_#`~>|\[\]{}]/g, " ");
  // "ông/bà" -> "ông bà" (máy đọc dấu / thành "trên" hoặc ngập ngừng)
  s = s.replace(new RegExp(`(?<!\\p{L})(${KIN})\\s*\\/\\s*(${KIN})(?!\\p{L})`, "giu"), "$1 $2");
  // Ngày tháng, giờ phút
  s = s.replace(/(?<!\d)(\d{1,2})\/(\d{1,2})\/(\d{4})(?!\d)/g, "$1 tháng $2 năm $3");
  s = s.replace(/(?<!\d)(\d{1,2})\/(\d{1,2})(?![\d/])/g, "$1 tháng $2");
  s = s.replace(/(?<![\d:])(\d{1,2}):(\d{2})(?![\d:])/g, (_m, h, mi) =>
    mi === "00" ? `${h} giờ` : `${h} giờ ${mi}`);
  s = s.replace(/(?<![\p{L}\d])(\d{1,2})\s*(?:h|g)\s*(\d{2})?(?!\p{L})/giu, (_m, h, mi) =>
    mi ? `${h} giờ ${mi}` : `${h} giờ`);
  // Đơn vị
  s = s.replace(/(\p{L}+)\s*\/\s*(phút|giây|giờ|ngày|tuần|tháng)(?!\p{L})/gu, "$1 mỗi $2");
  s = s.replace(/(?<!\p{L})bpm(?!\p{L})/giu, "nhịp mỗi phút");
  s = s.replace(/(\d)\s*%/g, "$1 phần trăm");
  s = s.replace(/(?<!\p{L})wi-?fi(?!\p{L})/giu, "wai phai");
  s = s.replace(/(?<!\p{L})esp32(-s3)?(?!\p{L})/giu, "thiết bị");
  s = s.replace(/&/g, " và ").replace(/\//g, ", ");
  // Viết tắt khi nhắn tin
  s = s.replace(/(?<![\p{L}\d])(\p{L}{1,3})(?![\p{L}\d])/gu, (w: string) =>
    SHORTHAND[w.toLowerCase()] ?? w);
  // Dấu câu: gom dấu lặp, bỏ dấu thừa đầu câu
  s = s.replace(/…/g, ".").replace(/([!?.,])\1+/g, "$1").replace(/\s+([,.!?])/g, "$1");
  s = s.replace(/[\r\n]+/g, ". ").replace(/\s{2,}/g, " ").trim();
  s = s.replace(/^[,.;:\-–\s]+/, "").replace(/(\.\s*){2,}/g, ". ");
  if (s && !/[.!?]$/.test(s)) s += ".";
  return s;
}

// ------------------------------------------------------------ MP3 (web) ---

/** Đọc câu thành MP3 24 kHz (dùng cho trình duyệt). */
export async function synthesizeMp3(text: string, voice: VoiceId = DEFAULT_VOICE): Promise<Buffer> {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioStream } = tts.toStream(text, { rate: RATE });
  const parts: Buffer[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      audioStream.on("data", (chunk: Buffer) => parts.push(Buffer.from(chunk)));
      audioStream.on("end", () => resolve());
      audioStream.on("error", (e: unknown) => reject(e instanceof Error ? e : new Error(String(e))));
    });
  } finally {
    tts.close();
  }
  const mp3 = Buffer.concat(parts);
  if (mp3.length === 0) throw new Error("dịch vụ đọc giọng không trả về âm thanh");
  return mp3;
}

// ----------------------------------------------------- WAV cho loa ESP32 ---

/** Giải mã MP3 thành mẫu số thực mono. */
async function decodeMp3(mp3: Buffer): Promise<{ pcm: Float32Array; rate: number }> {
  const decoder = new MPEGDecoder();
  await decoder.ready;
  try {
    const { channelData, samplesDecoded, sampleRate } = decoder.decode(new Uint8Array(mp3));
    if (!samplesDecoded || channelData.length === 0) throw new Error("không giải mã được MP3");
    const pcm = new Float32Array(samplesDecoded);
    for (const ch of channelData) {
      for (let i = 0; i < samplesDecoded; i++) pcm[i] += ch[i] / channelData.length;
    }
    return { pcm, rate: sampleRate };
  } finally {
    decoder.free();
  }
}

/**
 * Đổi tần số lấy mẫu bằng nội suy sinc có cửa sổ (chống răng cưa). Hạ 24 kHz
 * xuống 16 kHz mà chỉ lấy mẫu cách quãng thì âm cao sẽ "dội" xuống thành tiếng
 * rè; bộ lọc thông thấp ở đây cắt bớt phần trên 8 kHz trước.
 */
function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  const cutoff = Math.min(1, to / from) * 0.92;
  const HALF = 16;
  for (let n = 0; n < outLen; n++) {
    const t = n * ratio;
    const centre = Math.floor(t);
    let acc = 0;
    let norm = 0;
    for (let k = centre - HALF + 1; k <= centre + HALF; k++) {
      if (k < 0 || k >= input.length) continue;
      const x = t - k;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * cutoff * x) / (Math.PI * cutoff * x);
      const win = 0.5 + 0.5 * Math.cos((Math.PI * x) / HALF);
      const w = sinc * win;
      acc += input[k] * w;
      norm += w;
    }
    out[n] = norm ? acc / norm : 0;
  }
  return out;
}

/** Cắt khoảng lặng hai đầu (giữ lại 80 ms) để file nhỏ, ghi flash nhanh hơn. */
function trimSilence(x: Float32Array, rate: number): Float32Array {
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  if (peak === 0) return x;
  const th = peak * 0.02;
  let a = 0;
  let b = x.length - 1;
  while (a < b && Math.abs(x[a]) < th) a++;
  while (b > a && Math.abs(x[b]) < th) b--;
  const pad = Math.round(rate * 0.08);
  return x.subarray(Math.max(0, a - pad), Math.min(x.length, b + pad + 1));
}

/** Hai nốt "ting-tong" nhẹ báo có lời nhắn, khác hẳn âm báo động. */
function chime(rate: number): Float32Array {
  const notes = [
    { f: 784, ms: 170 },
    { f: 1047, ms: 260 },
  ];
  const parts: number[] = [];
  for (const { f, ms } of notes) {
    const n = Math.round((rate * ms) / 1000);
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, i / (rate * 0.01)) * Math.exp((-3 * i) / n);
      parts.push(0.32 * env * Math.sin((2 * Math.PI * f * i) / rate));
    }
  }
  for (let i = 0; i < rate * 0.25; i++) parts.push(0);
  return Float32Array.from(parts);
}

/** Đóng gói mẫu số thực thành file WAV PCM 16-bit mono. */
export function encodeWav(x: Float32Array, rate: number): Buffer {
  const data = Buffer.alloc(x.length * 2);
  for (let i = 0; i < x.length; i++) {
    const v = Math.max(-1, Math.min(1, x[i]));
    data.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

export type SpeakerWav = { wav: Buffer; seconds: number; text: string };

/**
 * Đọc câu thành file WAV cho loa ESP32: chuẩn hóa âm lượng về -1 dBFS (loa nhỏ
 * cần tín hiệu đủ lớn, firmware còn nhân thêm AUDIO_VOLUME_PERCENT), cắt lặng,
 * có thể chèn tiếng "ting-tong" ở đầu để người già chú ý trước khi nghe lời nhắn.
 */
export async function synthesizeSpeakerWav(
  text: string,
  voice: VoiceId = DEFAULT_VOICE,
  opts: { chime?: boolean } = {},
): Promise<SpeakerWav> {
  const clean = normalizeForSpeech(text);
  if (!clean) throw new Error("câu cần đọc đang rỗng");
  const mp3 = await synthesizeMp3(clean, voice);
  const { pcm, rate } = await decodeMp3(mp3);
  let x = trimSilence(resample(pcm, rate, SPEAKER_RATE), SPEAKER_RATE);
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) {
    const gain = 0.89 / peak;
    x = x.map((v) => v * gain);
  }
  if (opts.chime) {
    const c = chime(SPEAKER_RATE);
    const joined = new Float32Array(c.length + x.length);
    joined.set(c, 0);
    joined.set(x, c.length);
    x = joined;
  }
  return { wav: encodeWav(x, SPEAKER_RATE), seconds: x.length / SPEAKER_RATE, text: clean };
}
