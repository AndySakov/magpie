#!/usr/bin/env bash
# Downloads the source dumps the ingest reads into $DATA_DIR. Skips files already present.
set -euo pipefail
: "${DATA_DIR:?set DATA_DIR (see .env.example)}"
mkdir -p "$DATA_DIR" && cd "$DATA_DIR"
get() { [ -s "$2" ] || curl -fL --retry 3 -A magpie-research/0.1 "$1" -o "$2"; }

for f in title.basics title.ratings title.crew name.basics; do
  get "https://datasets.imdbws.com/$f.tsv.gz" "$f.tsv.gz"
done
get https://files.grouplens.org/datasets/movielens/ml-32m.zip ml-32m.zip
[ -d ml-32m ] || unzip -q ml-32m.zip
get https://github.com/manami-project/anime-offline-database/releases/latest/download/anime-offline-database.jsonl.zst aod.jsonl.zst
[ -s aod.jsonl ] || zstd -dq aod.jsonl.zst -o aod.jsonl
get https://openlibrary.org/data/ol_dump_ratings_latest.txt.gz ol_ratings.txt.gz
