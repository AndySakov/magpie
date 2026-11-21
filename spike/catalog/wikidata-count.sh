#!/usr/bin/env bash
# Wikidata coverage per category: items carrying each source's ID property, and how many have an English Wikipedia article.
set -euo pipefail

q() {
  curl -s -G https://query.wikidata.org/sparql -H 'Accept: application/sparql-results+json' \
    -A 'magpie-catalog-spike/0.1' --data-urlencode "query=$1" | jq -r '.results.bindings[0].n.value // "timeout"'
  sleep 2
}

for pair in "P4947:TMDB movie" "P4983:TMDB TV" "P4086:MyAnimeList anime" "P8729:AniList anime" "P4087:MyAnimeList manga" \
            "P648:Open Library ID (works+editions+authors)" "P5794:IGDB game" "P2339:BoardGameGeek" "P436:MusicBrainz release group"; do
  p=${pair%%:*}; label=${pair#*:}
  all=$(q "SELECT (COUNT(DISTINCT ?x) AS ?n) WHERE { ?x wdt:$p ?id }")
  en=$(q "SELECT (COUNT(DISTINCT ?x) AS ?n) WHERE { ?x wdt:$p ?id . ?a schema:about ?x ; schema:isPartOf <https://en.wikipedia.org/> }")
  printf '%-45s items=%-10s with_enwiki=%s\n' "$label ($p)" "$all" "$en"
done
