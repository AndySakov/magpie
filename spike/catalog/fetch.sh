#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/data"

d=$(date -v-1d +%m_%d_%Y)
for kind in movie tv_series person collection keyword; do
  f="tmdb_${kind}_ids.json.gz"
  [ -s "$f" ] || curl -fsSL "http://files.tmdb.org/p/exports/${kind}_ids_${d}.json.gz" -o "$f"
done

for f in title.basics title.ratings; do
  [ -s "$f.tsv.gz" ] || curl -fsSL "https://datasets.imdbws.com/$f.tsv.gz" -o "$f.tsv.gz"
done

ls -la
