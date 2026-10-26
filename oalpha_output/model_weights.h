/**
 * @file  model_weights.h
 * @brief Trong so model phat hien te nga (Student LR Chung cat Tri thuc). FILE NAY DUOC SINH TU DONG.
 *
 * Sinh luc: 23:20 24/10/2026 (gio Viet Nam)
 * Sinh boi: tools/kaggle/huan_luyen_model_te_nga.ipynb
 *
 * DUNG SUA TAY. Muon doi thi huan luyen lai roi tai file moi.
 *
 * ----------------------------- SO LIEU -----------------------------------
 * Du lieu tu do C1001 : 0 cua so co nhan, 0 lan thu
 * Du lieu cong khai   : 150342 cua so co nhan, 21 nguoi (mm-ADL + mm-ADL-Home + C1001-Ext, doi sang tin hieu C1001) + RadHAR 5 hoat dong thuong
 * Hoi quy logistic Chung cat Tri thuc (KD T=2.0), C = 0.03, danh gia cheo 3 phan theo nguoi/lan thu
 * Nguong 0.91027 chon theo TRAN BAO NHAM 6.0/gio
 * Ngoai-tap c1001-ext   : Precision 100.0%, Recall 90.6%, F1 95.0%, AUC 1.0
 * Ngoai-tap mm-adl      : Precision 96.1%, Recall 70.5%, F1 81.3%, AUC 0.984
 * Ngoai-tap mm-adl-home : Precision 94.0%, Recall 61.8%, F1 74.6%, AUC 0.986
 * Ngoai-tap radhar      : Precision 100.0%, Recall 100.0%, F1 100.0%, AUC 1.0
 * Cong khai theo su kien: bat 735/813 cu nga, 5.6 bao nham/gio
 * CHUA CO DU DU LIEU TU DO: so lieu tren chi de thu, KHONG dua vao bao cao.
 * -------------------------------------------------------------------------
 */
#pragma once
#include <Arduino.h>

#define FALL_MODEL_TRAINED 1
#define FALL_MODEL_SPEC_VERSION 1
#define FALL_MODEL_INFO "kaggle 24/10/2026 | tu do 0 cua so, cong khai 150342 | bat 90% cu nga @ 6.6 bao nham/gio"
// So cua so LIEN TIEP phai vuot nguong moi ket luan la nga. Mo phong o muc 8
// dung dung con so nay, nen no phai di cung bo trong so.
#define FALL_MODEL_CONFIRM_WINDOWS 2

constexpr float FALL_MODEL_THRESHOLD = 0.910269f;
constexpr float FALL_MODEL_BIAS      = -8.586531f;

// Thu tu dac trung xem src/core/fall_model.h
constexpr float FALL_MODEL_WEIGHTS[10] = {
    3.663888f,  // f0 Trung binh bien do
    2.500000f,  // f1 Bien do lon nhat
    3.648949f,  // f2 Do lech chuan bien do
    0.150000f,  // f3 Bien do cuoi - dau
    1.983752f,  // f4 Trung binh khoang cach
    5.217507f,  // f5 Khoang cach cuoi - dau
    0.852403f,  // f6 Khoang cach nho nhat
    0.100000f,  // f7 Ti le mau co nguoi
    0.400000f,  // f8 Ti le mau dang hoat dong
    2.304737f,  // f9 Ti le mau nam im lau
};
