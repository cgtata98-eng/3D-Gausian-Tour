#!/usr/bin/env bash
# 逆歩き用の反転動画を作る。
#
# `-vf reverse` を 58 秒に直接かけるとデコード済みフレームを全部メモリに積むので
# (1920x1080 yuv420p = 3.1MB/frame x 1757 = 5.5GB) 落ちる。
# 5 秒チャンクに割って各チャンクを反転し、逆順に concat する。1 チャンク約 465MB で済む。
set -e
cd "$(dirname "$0")/.."
SRC=media/tour.mp4
TMP=media/.revtmp
rm -rf "$TMP"; mkdir -p "$TMP"

# キーフレーム境界で無劣化分割 (g=15 なので 5 秒指定はほぼそのまま通る)
ffmpeg -y -v error -i "$SRC" -an -c copy -f segment -segment_time 5 -reset_timestamps 1 "$TMP/seg%03d.mp4"

for f in "$TMP"/seg*.mp4; do
  ffmpeg -y -v error -i "$f" -vf reverse -an -c:v libx264 -preset medium -crf 20 \
    -g 15 -keyint_min 15 -x264-params "scenecut=0:open-gop=0" -pix_fmt yuv420p "${f%.mp4}.rev.mp4"
done

# 逆順に並べて連結
# concat デマクサはリストと同じ階層を基準にパスを解く。ファイル名だけを書く。
(cd "$TMP" && ls seg*.rev.mp4 | sort -r | sed "s|^|file '|;s|$|'|" > list.txt)
ffmpeg -y -v error -f concat -safe 0 -i "$TMP/list.txt" -c copy -movflags +faststart media/tour-rev.mp4

rm -rf "$TMP"
echo "done: media/tour-rev.mp4"
