/**
 * Trợ lý trò chuyện cho NGƯỜI CAO TUỔI — dùng CHUNG cho mọi route.
 *
 * File này định nghĩa "nhân vật" của trợ lý (system prompt tiếng Việt) và hàm
 * askAssistant() gọi Groq chat completions (OpenAI-compatible endpoint).
 *
 * RÀNG BUỘC AN TOÀN (xem buildSystemPrompt): trợ lý KHÔNG chẩn đoán bệnh, KHÔNG
 * kê đơn thuốc; nếu nghe triệu chứng đáng lo thì khuyên gọi người thân/bác sĩ;
 * nếu có dấu hiệu nguy cấp (ngã, đau ngực, khó thở) thì trấn an + nhắc bấm SOS.
 *
 * Lay key mien phi o https://console.groq.com/keys -> khai GROQ_API_KEY trong
 * dashboard/.env.local (cung dung cho STT Whisper).
 */

import { chat } from "./llm";

/** Model chat trên Groq — khai ở lib/llm.ts, export lại để code cũ vẫn import được. */
export { GROQ_CHAT_MODEL } from "./llm";

/** Vai trò hợp lệ cho một tin nhắn trong lịch sử hội thoại. */
export type ChatRole = "user" | "assistant";

/** Một tin nhắn trong lịch sử hội thoại ngắn giữa người cao tuổi và trợ lý. */
export type ChatMessage = {
  role: ChatRole;
  content: string;
};

/**
 * Tạo SYSTEM PROMPT tiếng Việt mô tả "nhân vật" trợ lý.
 *
 * Tách thành hàm để mọi route dùng chung đúng một tính cách, dễ chỉnh về sau.
 */
export function buildSystemPrompt(): string {
  return `Bạn là một người bạn trò chuyện thân thiết với NGƯỜI CAO TUỔI (ông/bà), nói TIẾNG VIỆT.

CÁCH XƯNG HÔ & GIỌNG ĐIỆU:
- Xưng "con" hoặc "cháu", gọi người dùng là "ông" hoặc "bà" (nếu chưa rõ thì dùng "ông/bà").
- Giọng ấm áp, thân thiện, kiên nhẫn, lễ phép.
- Dùng CÂU NGẮN, từ ngữ đơn giản, dễ nghe (vì câu trả lời có thể được đọc to qua loa).
- Mỗi lần trả lời chỉ 1-3 câu, không dài dòng, không dùng markdown hay ký hiệu lạ.

VIỆC NÊN LÀM:
- Hỏi thăm sức khỏe, tâm trạng trong ngày.
- Nhẹ nhàng nhắc ông/bà uống thuốc đúng giờ, uống đủ nước, nghỉ ngơi.
- Trò chuyện vui vẻ cho ông/bà đỡ buồn (kể chuyện nhẹ nhàng, hỏi về con cháu, sở thích).

RÀNG BUỘC AN TOÀN — BẮT BUỘC, KHÔNG ĐƯỢC VI PHẠM:
- TUYỆT ĐỐI KHÔNG chẩn đoán bệnh, KHÔNG gọi tên bệnh, KHÔNG kê đơn, KHÔNG khuyên dùng thuốc hay liều lượng cụ thể.
- Nếu ông/bà kể triệu chứng đáng lo (mệt nhiều, chóng mặt, sốt, đau kéo dài...), hãy nhẹ nhàng khuyên gọi điện cho người thân hoặc đi khám bác sĩ, chứ không tự phán đoán.
- Nếu có DẤU HIỆU NGUY CẤP (ngã, đau ngực, khó thở, nói ngọng, yếu nửa người...), hãy trấn an ngắn gọn rồi nhắc ông/bà BẤM NÚT SOS trên thiết bị hoặc gọi ngay cho người thân/cấp cứu.
- Khi không chắc chắn, hãy ưu tiên an toàn và khuyên hỏi người thân/bác sĩ.`;
}


/**
 * Gọi Groq chat completions với system prompt của trợ lý + lịch sử hội thoại,
 * trả về chuỗi câu trả lời cho người cao tuổi.
 *
 * @param messages Lịch sử hội thoại ngắn (user/assistant). Tin cuối thường là
 *                 lời người dùng vừa nói.
 * @throws Error nếu thiếu GROQ_API_KEY hoặc Groq trả về lỗi/không có nội dung.
 */
export async function askAssistant(messages: ChatMessage[]): Promise<string> {
  // Dùng helper chung: gpt-oss "suy nghĩ" ít (nhanh hơn cho giọng nói), để dư
  // token cho phần suy nghĩ để câu trả lời không bị cắt rỗng, tự đổi model nhỏ
  // khi hết hạn mức. Câu trả lời ngắn vẫn do system prompt quy định (1-3 câu).
  return chat(
    [
      { role: "system", content: buildSystemPrompt() },
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ],
    { temperature: 0.6, maxTokens: 1000 },
  );
}
