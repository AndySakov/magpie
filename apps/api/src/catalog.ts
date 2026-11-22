export const BOOK_GENRES: ReadonlyArray<readonly [string, RegExp]> = [
  ["fantasy", /\bfantasy|magic|dragons|wizards\b/i],
  ["science fiction", /science fiction|sci-fi|dystopia|space opera|cyberpunk/i],
  ["mystery", /\bmystery|detective|whodunit|crime fiction\b/i],
  ["thriller", /thriller|suspense|espionage/i],
  ["horror", /\bhorror|ghost stories|supernatural fiction\b/i],
  ["romance", /\bromance|love stories\b/i],
  ["historical fiction", /historical fiction|fiction, historical/i],
  ["literary fiction", /literary fiction|psychological fiction|domestic fiction/i],
  ["classics", /\bclassic(s|al) literature|classics\b/i],
  ["young adult", /young adult|juvenile fiction|teen/i],
  ["children", /children's (stories|fiction|literature)|picture books/i],
  ["graphic novels", /graphic novels|comic books|comics|manga/i],
  ["biography", /biography|autobiography|memoir/i],
  ["history", /^history\b|world history|military history|history, modern/i],
  ["philosophy", /\bphilosophy\b/i],
  ["psychology", /\bpsychology\b/i],
  ["self-help", /self-help|self-actualization|personal development|success/i],
  ["business", /\bbusiness|economics|management|entrepreneurship\b/i],
  ["science", /\bscience\b(?! fiction)|physics|biology|astronomy|evolution/i],
  ["poetry", /\bpoetry|poems\b/i],
  ["humor", /\bhumor|humorous|satire\b/i],
  ["religion", /\breligion|spirituality|theology\b/i],
  ["true crime", /true crime|murder investigation/i],
  ["politics", /\bpolitic(s|al)\b/i]
]

const ISO1: Record<string, string> = {
  eng: "en", fre: "fr", fra: "fr", spa: "es", ger: "de", deu: "de", ita: "it", por: "pt", rus: "ru", chi: "zh", zho: "zh",
  jpn: "ja", kor: "ko", ara: "ar", hin: "hi", tur: "tr", pol: "pl", dut: "nl", nld: "nl", swe: "sv", dan: "da", nor: "no",
  fin: "fi", ice: "is", isl: "is", gre: "el", ell: "el", heb: "he", per: "fa", fas: "fa", urd: "ur", ben: "bn", tam: "ta",
  tel: "te", mal: "ml", kan: "kn", mar: "mr", guj: "gu", pan: "pa", ind: "id", may: "ms", msa: "ms", vie: "vi", tha: "th",
  tgl: "tl", ukr: "uk", cze: "cs", ces: "cs", slo: "sk", slk: "sk", hun: "hu", rum: "ro", ron: "ro", bul: "bg", srp: "sr",
  hrv: "hr", slv: "sl", cat: "ca", baq: "eu", eus: "eu", glg: "gl", wel: "cy", cym: "cy", gle: "ga", lat: "la", afr: "af",
  swa: "sw", yor: "yo", ibo: "ig", hau: "ha", amh: "am", som: "so", zul: "zu", xho: "xh", sna: "sn", epo: "eo", yid: "yi",
  est: "et", lav: "lv", lit: "lt", alb: "sq", sqi: "sq", arm: "hy", hye: "hy", geo: "ka", kat: "ka", mac: "mk", mkd: "mk"
}

export const toIso1 = (code: string): string | null => {
  const c = code.toLowerCase()
  if (c.length === 2) return c
  return ISO1[c] ?? null
}

export const EMBED_MODEL = "Xenova/bge-small-en-v1.5"

export interface EmbedRow {
  readonly category: string
  readonly title: string
  readonly year: number | null
  readonly synopsis: string | null
  readonly genres: ReadonlyArray<string>
  readonly tags: ReadonlyArray<string>
  readonly creators: string | null
}

export const embedText = (r: EmbedRow) =>
  [
    `${r.title}${r.year ? ` (${r.year})` : ""}, ${r.category}.`,
    r.genres.length ? `Genres: ${r.genres.join(", ")}.` : "",
    r.tags.length ? `Themes: ${r.tags.slice(0, 15).join(", ")}.` : "",
    r.creators ? `By ${r.creators}.` : "",
    r.synopsis ? r.synopsis.slice(0, 900) : ""
  ].filter(Boolean).join(" ")
