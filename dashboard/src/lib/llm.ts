/**
 * Gọi mô hình ngôn ngữ trên Groq (miễn phí, rất nhanh) — dùng chung cho trợ lý
 * người nhà, nhận xét tổng quan và biên tập lời nhắn đọc ra loa.
 *
 * gpt-oss là model có "suy nghĩ" (reasoning). Token suy nghĩ cũng bị tính vào
 * giới hạn độ dài, nên đặt reasoning_effort = "low" và để dư max_completion_tokens,
 * nếu không câu trả lời có thể bị cắt cụt thành rỗng.
 * Hết hạn mức model lớn (HTTP 429) thì tự chuyển sang model nhỏ hơn.
 */
/** Model chat trên Groq — dùng chung cho mọi tính năng AI của dashboard. */
export const GROQ_CHAT_MODEL = "openai/gpt-oss-120b";
const FALLBACK_MODEL = "openai/gpt-oss-20b";

export type LlmMessage = { role: "system" | "user" | "assistant"; content: string };

export function hasLlm(): boolean {
  return Boolean(process.env.GROQ_API_KEY);
}

type GroqResponse = { choices?: { message?: { content?: string } }[] };

async function callModel(
  model: string,
  messages: LlmMessage[],
  opts: { temperature: number; maxTokens: number },
): Promise<{ status: number; text: string; body: string }> {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature,
      max_completion_tokens: opts.maxTokens,
      reasoning_effort: "low",
      include_reasoning: false,
    }),
    signal: AbortSignal.timeout(40_000),
  });
  const body = await res.text();
  if (!res.ok) return { status: res.status, text: "", body };
  const json = JSON.parse(body) as GroqResponse;
  return { status: 200, text: json.choices?.[0]?.message?.content?.trim() ?? "", body };
}

/** Hỏi Groq; ném lỗi nếu thiếu key hoặc cả hai model đều không trả lời được. */
export async function chat(
  messages: LlmMessage[],
  opts: { temperature?: number; maxTokens?: number } = {},
): Promise<string> {
  if (!hasLlm()) throw new Error("Chưa khai GROQ_API_KEY trong dashboard/.env.local");
  const o = { temperature: opts.temperature ?? 0.5, maxTokens: opts.maxTokens ?? 1200 };
  let r = await callModel(GROQ_CHAT_MODEL, messages, o);
  if (r.status === 429 || r.status >= 500 || (r.status === 200 && !r.text)) {
    r = await callModel(FALLBACK_MODEL, messages, o);
  }
  if (r.status !== 200) throw new Error(`Groq trả về HTTP ${r.status}: ${r.body.slice(0, 160)}`);
  if (!r.text) throw new Error("Groq không trả về nội dung");
  return r.text;
}

/** Bỏ markdown để câu trả lời hiện gọn trên Telegram và đọc to không vấp. */
export function plainText(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|\s)[*_](\S[^*_]*?)[*_](?=\s|$)/g, "$1$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "• ")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}
