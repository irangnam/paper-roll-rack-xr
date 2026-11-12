#!/bin/bash
# 더블클릭하면 이 폴더를 http://localhost:8000 으로 띄웁니다 (macOS)
cd "$(dirname "$0")"
echo "데모:        http://localhost:8000/index.html"
echo "패턴 편집기: http://localhost:8000/pattern-editor.html"
echo "종료: Ctrl+C"
(sleep 1; open "http://localhost:8000/index.html") &
python3 -m http.server 8000
