/* ==========================================================================
   Khai báo kiểu tối thiểu cho Web Speech API (nhận dạng giọng nói).
   Trình duyệt hỗ trợ qua `SpeechRecognition` (chuẩn) hoặc `webkitSpeechRecognition`
   (Chrome/Edge). Các kiểu này CHƯA có sẵn trong lib "dom" của TypeScript nên
   ta tự khai báo đủ phần dùng tới, tránh phải rải `any` khắp trang.
   (SpeechSynthesis / speechSynthesis để ĐỌC TO đã có sẵn trong lib "dom".)
   ========================================================================== */

/** Một phương án nhận dạng cho một đoạn nói. */
interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

/** Kết quả nhận dạng của một đoạn (có thể gồm nhiều phương án). */
interface SpeechRecognitionResult {
  readonly length: number;
  readonly isFinal: boolean;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

/** Danh sách kết quả trả về trong một sự kiện nhận dạng. */
interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

/** Sự kiện phát ra mỗi khi có kết quả nhận dạng mới. */
interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

/** Sự kiện lỗi khi nhận dạng gặp sự cố. */
interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message: string;
}

/** Đối tượng điều khiển việc nghe – nhận dạng giọng nói. */
interface SpeechRecognition extends EventTarget {
  /** Ngôn ngữ nhận dạng, ví dụ "vi-VN". */
  lang: string;
  /** true = nghe liên tục, false = dừng sau mỗi câu. */
  continuous: boolean;
  /** true = trả cả kết quả tạm thời (chưa chốt). */
  interimResults: boolean;
  /** Số phương án tối đa cho mỗi kết quả. */
  maxAlternatives: number;

  start(): void;
  stop(): void;
  abort(): void;

  onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void) | null;
  onerror: ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => void) | null;
  onend: ((this: SpeechRecognition, ev: Event) => void) | null;
  onstart: ((this: SpeechRecognition, ev: Event) => void) | null;
}

/** Hàm tạo đối tượng SpeechRecognition. */
interface SpeechRecognitionConstructor {
  new (): SpeechRecognition;
}

/** Bổ sung hai thuộc tính (có thể không tồn tại) vào `window`. */
interface Window {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}
