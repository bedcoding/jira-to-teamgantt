#!/bin/sh
# Chrome 웹 스토어에 올릴 zip을 만든다.
# 파일 이름의 버전은 manifest.json에서 읽으므로, 올리기 전에 manifest의 version을 먼저 올린다.
# 스토어는 이미 올린 버전 이하의 zip을 받지 않는다.
set -e
cd "$(dirname "$0")/.."

version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json | head -1)
if [ -z "$version" ]; then
  echo "manifest.json에서 version을 찾지 못했습니다." >&2
  exit 1
fi

out="jira-to-teamgantt-$version.zip"
rm -f "$out"

# 확장이 실제로 쓰는 것만 넣는다.
# 문서, assets(원본 svg), 숨김 파일은 스토어 패키지에 필요 없다.
zip -rq "$out" manifest.json background content icons lib popup -x '*.DS_Store' -x '*/.*'

echo "$out 만들었습니다."
unzip -l "$out" | tail -1
