#!/bin/bash
# Fix-up: rename current "vê cầu" files in luu-huy/ to "ve cầu" (5 files).
set -euo pipefail
cd "/Users/sonnp/tools/grabber/downloads/hlv-luu-huy-ton-hao-bang/luu-huy"
echo "Before (vê cầu): $(ls *vê\ cầu* *Vê\ cầu* 2>/dev/null | wc -l | tr -d ' ')"

mv "21 - Hướng dẫn vê cầu kiểu Chiharu Shida.mp4" "21 - Hướng dẫn ve cầu kiểu Chiharu Shida.mp4"
mv "28 - Hướng dẫn vê cầu cao sâu với vài bước đơn giản.mp4" "28 - Hướng dẫn ve cầu cao sâu với vài bước đơn giản.mp4"
mv "40 - Vê cầu trái tay bị động cao sâu về cuối sân, kỹ thuật nâng cao.mp4" "40 - Ve cầu trái tay bị động cao sâu về cuối sân, kỹ thuật nâng cao.mp4"
mv "41 - Sửa lỗi vê cầu cao sâu cho học viên, chỉ 1 điểm nhỏ thay đổi tất cả.mp4" "41 - Sửa lỗi ve cầu cao sâu cho học viên, chỉ 1 điểm nhỏ thay đổi tất cả.mp4"
mv "44 - Hướng dẫn vê cầu cao sâu nên thủ vợt thấp hay cao để đánh.mp4" "44 - Hướng dẫn ve cầu cao sâu nên thủ vợt thấp hay cao để đánh.mp4"

echo "After (vê cầu remaining): $(ls *vê\ cầu* *Vê\ cầu* 2>/dev/null | wc -l | tr -d ' ')"
echo "ve cầu now: $(ls *ve\ cầu* *Ve\ cầu* 2>/dev/null | wc -l | tr -d ' ')"
