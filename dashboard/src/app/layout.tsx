import type { Metadata } from "next";
import Nav from "@/components/Nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "OALPHA · Giám sát sức khỏe người cao tuổi",
  description:
    "Hệ thống OALPHA theo dõi và cảnh báo té ngã cho người cao tuổi dùng radar 60 GHz + ESP32-S3",
  // Favicon: Next.js tự lấy app/icon.png và app/apple-icon.png (cắt từ logo gốc image.png)
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi">
      <body>
        <div className="wrap">
          <Nav />
          {children}
          <footer>
            OALPHA · Hệ thống giám sát &amp; cảnh báo té ngã · Radar sóng milimet 60 GHz + ESP32-S3
            <br />
            Dashboard chạy trên máy tính — hệ thống cảnh báo vẫn hoạt động độc lập khi tắt máy
          </footer>
        </div>
      </body>
    </html>
  );
}
