#!/bin/bash
# Strip trailing " Basic" / "Xem thử" suffix from .mp4 files under caulong360vn/
# Also trims any leftover trailing separator (space or underscore) before .mp4.
set -euo pipefail
cd "/Users/sonnp/tools/grabber/downloads/caulong360vn"

renamed=0
while IFS= read -r -d '' f; do
  dir="${f%/*}"; base="${f##*/}"; name="${base%.mp4}"
  new="$(printf '%s' "$name" | sed -E 's/[ _]*(Basic|Xem thử)$//; s/[ _]+$//')"
  if [ "$new" != "$name" ]; then
    mv "$f" "$dir/$new.mp4"
    renamed=$((renamed+1))
  fi
done < <(find . -type f -name '*.mp4' -print0)

echo "Renamed: $renamed"
echo "Remaining with suffix: $(find . -type f \( -name '*Basic.mp4' -o -name '*Xem thử.mp4' \) | wc -l | tr -d ' ')"
