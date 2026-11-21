import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";

const dir = new URL("./data/", import.meta.url);
const lines = (f) => createInterface({ input: createReadStream(new URL(f, dir)).pipe(createGunzip()), crlfDelay: Infinity });

const POP = [0.1, 1, 5, 10];
async function tmdb(kind) {
  const c = { total: 0, adult: 0, video: 0 };
  for (const p of POP) c[`pop>=${p}`] = 0;
  for await (const l of lines(`tmdb_${kind}_ids.json.gz`)) {
    if (!l) continue;
    const r = JSON.parse(l);
    c.total++;
    if (r.adult) c.adult++;
    if (r.video) c.video++;
    for (const p of POP) if (!r.adult && r.popularity >= p) c[`pop>=${p}`]++;
  }
  return c;
}

const VOTES = [10, 100, 1000, 10000];
async function imdb() {
  const votes = new Map();
  let first = true;
  for await (const l of lines("title.ratings.tsv.gz")) {
    if (first) { first = false; continue; }
    const [id, , n] = l.split("\t");
    votes.set(id, +n);
  }
  const byType = {};
  first = true;
  for await (const l of lines("title.basics.tsv.gz")) {
    if (first) { first = false; continue; }
    const [id, type, , , adult] = l.split("\t");
    if (adult === "1") continue;
    const t = (byType[type] ??= { total: 0, rated: 0, ...Object.fromEntries(VOTES.map((v) => [`votes>=${v}`, 0])) });
    t.total++;
    const n = votes.get(id);
    if (n === undefined) continue;
    t.rated++;
    for (const v of VOTES) if (n >= v) t[`votes>=${v}`]++;
  }
  return byType;
}

const keep = ["movie", "tvSeries", "tvMiniSeries", "tvMovie", "tvEpisode"];
const [movie, tv, im] = await Promise.all([tmdb("movie"), tmdb("tv_series"), imdb()]);
console.log("TMDB movie", movie);
console.log("TMDB tv", tv);
console.table(Object.fromEntries(keep.map((k) => [k, im[k]])));
