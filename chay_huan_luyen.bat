@echo off
cd /d "%~dp0"
chcp 65001 >nul
title Huấn Luyện Model Phát Hiện Té Ngã - OALPHA ESP32-S3

echo ===========================================================================
echo    HUẤN LUYỆN MODEL PHÁT HIỆN TÉ NGÃ - OALPHA (ESP32-S3 + RADAR C1001)
echo ===========================================================================
echo.
echo  Chọn chế độ huấn luyện:
echo.
echo  [1] Tự động tìm dữ liệu & Huấn luyện (khuyên dùng khi đã có dữ liệu)
echo  [2] Chạy thử nghiệm DEMO (mô phỏng radar C1001 vật lý trong 10 giây)
echo  [3] Chạy DEMO và TỰ ĐỘNG GHI ĐÈ vào include/ (để nạp firmware ngay)
echo  [4] Huấn luyện đầy đủ mọi Fold & kiểm tra chuyển miền (--full)
echo  [5] Tự nhập tham số nâng cao
echo.
set /p choice="Nhập lựa chọn (1-5, mặc định 1): "

if "%choice%"=="" set choice=1

if "%choice%"=="1" (
    python tools/huan_luyen_local.py --fast
) else if "%choice%"=="2" (
    python tools/huan_luyen_local.py --demo
) else if "%choice%"=="3" (
    python tools/huan_luyen_local.py --demo --deploy
) else if "%choice%"=="4" (
    python tools/huan_luyen_local.py --full
) else if "%choice%"=="5" (
    set /p custom_args="Nhập các tham số (ví dụ: --demo --deploy): "
    python tools/huan_luyen_local.py %custom_args%
) else (
    python tools/huan_luyen_local.py --fast
)

echo.
echo ===========================================================================
pause
