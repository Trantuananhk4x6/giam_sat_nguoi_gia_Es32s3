/**
 * Next.js gọi register() một lần khi máy chủ khởi động.
 * Ta dùng nó để bật bộ thu thập dữ liệu, nhờ vậy dashboard ghi lịch sử sự kiện
 * ngay cả khi chưa ai mở trình duyệt.
 *
 * (Các route API cũng gọi ensurePoller() nên dù môi trường nào không chạy
 * instrumentation thì bộ thu thập vẫn được bật ở lần gọi đầu tiên.)
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ensurePoller } = await import("./lib/poller");
  await ensurePoller();
  // Bot Telegram hai chiều (tự nằm im nếu chưa khai TELEGRAM_BOT_TOKEN)
  const { ensureTelegramBot } = await import("./lib/telegram-bot");
  ensureTelegramBot();
}
