import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Dashboard chỉ chạy trong mạng LAN của gia đình / phòng thí nghiệm nên không
  // cần tối ưu gì đặc biệt. Tắt header "x-powered-by" cho gọn.
  poweredByHeader: false,
};

export default nextConfig;
