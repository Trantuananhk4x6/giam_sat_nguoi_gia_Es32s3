# Rà soát bảo mật & kiểm thử xâm nhập — Hệ thống OALPHA

**Ngày:** 23/10/2026
**Phạm vi:** Firmware ESP32-S3 (`src/`) và dashboard Next.js (`dashboard/`).
**Phương pháp:** Rà soát mã nguồn (hộp trắng) + kiểm thử động trên bộ giả lập + xác minh bằng biên dịch (firmware `pio run`; dashboard `tsc --noEmit` và `next build`).

## Tóm tắt
| # | Vấn đề | Mức | Trạng thái |
|---|--------|-----|-----------|
| 1 | CSRF toàn bộ API ghi của dashboard | Cao | ✅ Đã vá — kiểm chứng 9/9 |
| 2 | CSRF trên `/api/action` của firmware | Trung bình | ✅ Đã vá — build xanh (cần nạp lại) |
| 3 | Trang web firmware mở trên LAN khi `WEB_USER` rỗng | Trung bình | ⚠ Tồn dư — khuyến nghị |
| 4 | `/api/assistant` gọi được cross-site (đốt quota LLM) | Thấp | ⚠ Tồn dư — khuyến nghị |
| 5 | SSRF qua `esp32Host` | Thấp | ⚠ Tồn dư — rủi ro thấp |
| 6 | Lộ thông tin riêng tư qua `/api/status` | Thấp | ⚠ Gắn với #3 |

## 1. [Cao] CSRF toàn bộ API ghi của dashboard — ĐÃ VÁ
**Vấn đề:** Dashboard không có đăng nhập và Next.js lắng nghe mọi giao diện mạng. Mọi route ghi dưới `/api` (action, loi-nhan, settings, sessions, trials, tong-quan, phan-tich, phan-tich-sinh-hieu, assistant-chat) không kiểm tra nguồn gốc. Một trang web lạ mở trong trình duyệt ở cùng máy / cùng LAN có thể gửi "simple request" (form tự submit, fetch text/plain) để:
- bắn lệnh xuống thiết bị: `sos`, `simfall`, `clearlog`…;
- **bắt loa trong phòng đọc chữ bất kỳ** (`POST /api/loi-nhan`) — tác hại vật lý cao nhất;
- đổi cấu hình, xóa dữ liệu thực nghiệm.

`/api/action` còn đọc tên lệnh từ query (`?name=`) nên cả form tự submit cũng khai thác được.

**Cách vá:** Thêm lớp "proxy" tập trung (`dashboard/src/proxy.ts` — quy ước mới của Next.js 16, thay cho `middleware`). Lớp này chặn mọi method ghi (POST/PUT/PATCH/DELETE) tới `/api` nếu không cùng nguồn (dùng `dashboard/src/lib/same-origin.ts`):
1. `Content-Type` phải là `application/json` (gửi JSON cross-site buộc trình duyệt preflight, mà dashboard không trả CORS nên bị chặn);
2. `Sec-Fetch-Site` nếu có phải là `same-origin` hoặc `none`;
3. `Origin` nếu có thì host phải khớp `Host`.

Miễn trừ `/api/assistant` (ESP32 gọi trực tiếp, multipart) và các method đọc (GET/HEAD/OPTIONS).

**Kiểm chứng:** 9/9 ca kiểm thử trên bộ giả lập — chặn 403 với `text/plain`, `x-www-form-urlencoded`, `Sec-Fetch-Site: cross-site`, `Origin` lạ; cho qua 200 với same-origin JSON (lệnh vẫn tới thiết bị); `/api/assistant` vẫn nhận multipart.

## 2. [Trung bình] CSRF trên `/api/action` của firmware — ĐÃ VÁ
**Vấn đề:** Firmware đăng ký cả `GET /api/action` ("tiện thử bằng thanh địa chỉ") nên `<img src="http://canhbao-tenga.local/api/action?name=sos">` trên một trang lạ cũng kích hoạt được; `POST` cũng thiếu lớp chống giả mạo mà 4 lệnh Wi-Fi đã có. Khi `WEB_USER` rỗng (mặc định khi demo) thiết bị mở trên LAN nên vector này sống.

**Cách vá (đồng bộ 4 nơi):**
- `src/net/web_ui.cpp`: bỏ tuyến `GET`; bắt buộc header `X-OALPHA` trên `POST /api/action` (giống hệt lệnh Wi-Fi);
- `data/index.html`: trang UI nội bộ của firmware gửi kèm `X-OALPHA`;
- `dashboard/src/lib/esp32.ts`: lớp gọi thiết bị gửi kèm `X-OALPHA`;
- `dashboard/tools/gia-lap-esp32.mjs`: bộ giả lập mô phỏng đúng ràng buộc để kiểm thử.

**Kiểm chứng:** firmware build xanh (Flash 28.8%, RAM 20.5%); test vòng dashboard → thiết bị (bộ giả lập nay bắt buộc `X-OALPHA`) trả 200 OK, chứng tỏ header được gửi đúng và lệnh không bị vỡ. **Cần `pio run -t upload` và `pio run -t uploadfs` để có hiệu lực trên thiết bị thật.**

## 3. [Trung bình — tồn dư] Trang web firmware mở trên LAN
`WEB_USER`/`WEB_PASS` mặc định rỗng → bất kỳ ai trong LAN đọc được `/api/status` (tên người được chăm `PATIENT_NAME`, vị trí, sinh hiệu ước lượng, cấu hình) và tải nhật ký.
**Khuyến nghị:** đặt `WEB_USER`/`WEB_PASS` trong `secrets.h` khi triển khai thật (cơ chế Basic auth đã có sẵn).

## 4. [Thấp — tồn dư] `/api/assistant` gọi được cross-site
Proxy miễn trừ `/api/assistant`. Vì multipart là kiểu "CORS-safelisted", một trang lạ vẫn POST được (dù không đọc được kết quả) → có thể đốt quota STT/LLM.
**Khuyến nghị:** thêm một "shared secret" header riêng cho `/api/assistant` (firmware gửi, dashboard kiểm). Rủi ro thấp vì cần biết địa chỉ dashboard.

## 5. [Thấp — tồn dư] SSRF qua `esp32Host`
Dashboard fetch phía máy chủ tới `esp32Host` do người vận hành đặt ở trang Cài đặt (nay đã được proxy CSRF bảo vệ). Người ngoài không đặt được → rủi ro thấp.
**Khuyến nghị:** nếu muốn chặt hơn, giới hạn `esp32Host` trong dải IP riêng hoặc tên `.local`.

## 6. [Thấp — tồn dư] Lộ thông tin qua `/api/status`
Gắn với #3; đặt mật khẩu trang web firmware là đủ.

## Điểm tốt (không cần sửa)
- Firmware không dùng hàm C nguy hiểm (`strcpy`/`sprintf`/`system`…) — chỉ `snprintf` có biên.
- Dashboard không có `eval`/`child_process`/`dangerouslySetInnerHTML`; mọi `exec(` đều là `RegExp.exec`.
- `/api/say`: giới hạn 700 KB + kiểm chữ ký `RIFF/WAVE` + chặn thân form (415).
- `/api/action`: có whitelist tên lệnh.
- Lease `?tg=`/`?zl=` xét SAU khi kiểm mật khẩu.
- Bí mật (token) để trong `secrets.h` / `.env.local` (gitignored), không lộ qua API/log.
- Model (hồi quy logistic + mạng nơ-ron): chuẩn hóa đầu vào, chặn tràn số (sigmoid, softmax trừ max), có guard phiên bản đặc trưng.
- **Đường an toàn tính mạng (nút SOS 433 MHz đeo tay, radar tự phát hiện) độc lập với HTTP** → lỗ hổng web không ảnh hưởng tới phát hiện/báo động té ngã.

## Thay đổi mã trong đợt rà soát này
- `dashboard/src/proxy.ts` (mới) — proxy chống CSRF tập trung; đã gỡ `middleware.ts` (quy ước Next.js 16).
- `dashboard/src/app/thuc-nghiem/page.tsx` — `removeTrial` gửi kèm `Content-Type: application/json`.
- `src/net/web_ui.cpp`, `data/index.html`, `dashboard/src/lib/esp32.ts`, `dashboard/tools/gia-lap-esp32.mjs` — chống CSRF cho `/api/action` bằng header `X-OALPHA`.