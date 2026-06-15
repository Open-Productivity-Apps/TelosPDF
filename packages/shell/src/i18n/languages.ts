// MyBI supported languages — the registry the language picker + i18n loader read, grouped by
// CONTINENT. Each entry has a BCP-47 code, English name, ENDONYM (the language's own name),
// the primary country + its flag, and `rtl` for right-to-left scripts.
//
// Only en-GB ships in the bundle (src/i18n/locales/en-GB.json — the source of truth + fallback).
// Every OTHER language is DOWNLOADED from the repo the first time the user selects it (see
// ./index.ts); until then it falls back to en-GB. See ./README.md.

// Open set — codes can be added in the repo at runtime, so the type is a plain locale string
// validated against the registry by `isLocale()`.
export type LocaleCode = string;

export type Continent =
  | "Europe" | "Asia" | "Middle East" | "Africa" | "North America" | "South America" | "Oceania";

export interface Language {
  /** BCP-47 locale code (the locale file is `<code>.json`). */
  code: LocaleCode;
  /** English name, for English-language UI + sorting. */
  english: string;
  /** Endonym — the language's own name, shown in the picker. */
  native: string;
  /** Primary country/territory where it's the main language. */
  country: string;
  /** Flag emoji for that country/territory. */
  flag: string;
  continent: Continent;
  /** Right-to-left script (Arabic, Hebrew, Persian, Urdu, Pashto…). */
  rtl?: boolean;
}

export const CONTINENTS: Continent[] = [
  "Europe", "Asia", "Middle East", "Africa", "North America", "South America", "Oceania",
];

export const LANGUAGES: Language[] = [
  // ── Europe ───────────────────────────────────────────────────────────────
  // The four UK entries carry their HOME-NATION flag + "(UK)" so England / Scotland / Wales read
  // consistently (Irish below is the Republic of Ireland — deliberately NOT marked UK).
  { code: "en-GB", english: "English", native: "English", country: "England (UK)", flag: "🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}", continent: "Europe" },
  { code: "es",    english: "Spanish",      native: "Español",      country: "Spain",        flag: "🇪🇸", continent: "Europe" },
  { code: "de",    english: "German",       native: "Deutsch",      country: "Germany",      flag: "🇩🇪", continent: "Europe" },
  { code: "fr",    english: "French",       native: "Français",     country: "France",       flag: "🇫🇷", continent: "Europe" },
  { code: "it",    english: "Italian",      native: "Italiano",     country: "Italy",        flag: "🇮🇹", continent: "Europe" },
  { code: "pt-PT", english: "Portuguese (Portugal)", native: "Português (Portugal)", country: "Portugal", flag: "🇵🇹", continent: "Europe" },
  { code: "nl",    english: "Dutch",        native: "Nederlands",   country: "Netherlands",  flag: "🇳🇱", continent: "Europe" },
  { code: "pl",    english: "Polish",       native: "Polski",       country: "Poland",       flag: "🇵🇱", continent: "Europe" },
  { code: "ru",    english: "Russian",      native: "Русский",      country: "Russia",       flag: "🇷🇺", continent: "Europe" },
  { code: "uk",    english: "Ukrainian",    native: "Українська",   country: "Ukraine",      flag: "🇺🇦", continent: "Europe" },
  { code: "ro",    english: "Romanian",     native: "Română",       country: "Romania",      flag: "🇷🇴", continent: "Europe" },
  { code: "el",    english: "Greek",        native: "Ελληνικά",     country: "Greece",       flag: "🇬🇷", continent: "Europe" },
  { code: "cs",    english: "Czech",        native: "Čeština",      country: "Czechia",      flag: "🇨🇿", continent: "Europe" },
  { code: "hu",    english: "Hungarian",    native: "Magyar",       country: "Hungary",      flag: "🇭🇺", continent: "Europe" },
  { code: "sv",    english: "Swedish",      native: "Svenska",      country: "Sweden",       flag: "🇸🇪", continent: "Europe" },
  { code: "da",    english: "Danish",       native: "Dansk",        country: "Denmark",      flag: "🇩🇰", continent: "Europe" },
  { code: "fi",    english: "Finnish",      native: "Suomi",        country: "Finland",      flag: "🇫🇮", continent: "Europe" },
  { code: "nb",    english: "Norwegian",    native: "Norsk bokmål", country: "Norway",       flag: "🇳🇴", continent: "Europe" },
  { code: "sk",    english: "Slovak",       native: "Slovenčina",   country: "Slovakia",     flag: "🇸🇰", continent: "Europe" },
  { code: "sl",    english: "Slovenian",    native: "Slovenščina",  country: "Slovenia",     flag: "🇸🇮", continent: "Europe" },
  { code: "bg",    english: "Bulgarian",    native: "Български",     country: "Bulgaria",     flag: "🇧🇬", continent: "Europe" },
  { code: "hr",    english: "Croatian",     native: "Hrvatski",     country: "Croatia",      flag: "🇭🇷", continent: "Europe" },
  { code: "sr",    english: "Serbian",      native: "Српски",       country: "Serbia",       flag: "🇷🇸", continent: "Europe" },
  { code: "ca",    english: "Catalan",      native: "Català",       country: "Spain (Catalonia)", flag: "🇪🇸", continent: "Europe" },
  { code: "gd",    english: "Scottish Gaelic", native: "Gàidhlig",  country: "Scotland (UK)", flag: "🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}", continent: "Europe" },
  { code: "ga",    english: "Irish",        native: "Gaeilge",      country: "Ireland",      flag: "🇮🇪", continent: "Europe" },
  { code: "cy",    english: "Welsh",        native: "Cymraeg",      country: "Wales (UK)",   flag: "🏴\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}", continent: "Europe" },
  { code: "is",    english: "Icelandic",    native: "Íslenska",     country: "Iceland",      flag: "🇮🇸", continent: "Europe" },
  { code: "et",    english: "Estonian",     native: "Eesti",        country: "Estonia",      flag: "🇪🇪", continent: "Europe" },
  { code: "lv",    english: "Latvian",      native: "Latviešu",     country: "Latvia",       flag: "🇱🇻", continent: "Europe" },
  { code: "lt",    english: "Lithuanian",   native: "Lietuvių",     country: "Lithuania",    flag: "🇱🇹", continent: "Europe" },

  // ── Asia ─────────────────────────────────────────────────────────────────
  { code: "zh-Hans", english: "Chinese (Simplified, Mandarin)",  native: "简体中文", country: "China",     flag: "🇨🇳", continent: "Asia" },
  { code: "zh-Hant", english: "Chinese (Traditional, Mandarin)", native: "繁體中文", country: "Taiwan",    flag: "🇹🇼", continent: "Asia" },
  { code: "yue",     english: "Cantonese",  native: "粵語",        country: "Hong Kong", flag: "🇭🇰", continent: "Asia" },
  { code: "hi",      english: "Hindi",      native: "हिन्दी",      country: "India",      flag: "🇮🇳", continent: "Asia" },
  { code: "bn",      english: "Bengali",    native: "বাংলা",       country: "Bangladesh", flag: "🇧🇩", continent: "Asia" },
  { code: "ja",      english: "Japanese",   native: "日本語",       country: "Japan",      flag: "🇯🇵", continent: "Asia" },
  { code: "ko",      english: "Korean",     native: "한국어",       country: "South Korea", flag: "🇰🇷", continent: "Asia" },
  { code: "ta",      english: "Tamil",      native: "தமிழ்",       country: "India",      flag: "🇮🇳", continent: "Asia" },
  { code: "te",      english: "Telugu",     native: "తెలుగు",      country: "India",      flag: "🇮🇳", continent: "Asia" },
  { code: "mr",      english: "Marathi",    native: "मराठी",       country: "India",      flag: "🇮🇳", continent: "Asia" },
  { code: "gu",      english: "Gujarati",   native: "ગુજરાતી",     country: "India",      flag: "🇮🇳", continent: "Asia" },
  { code: "kn",      english: "Kannada",    native: "ಕನ್ನಡ",       country: "India",      flag: "🇮🇳", continent: "Asia" },
  { code: "ml",      english: "Malayalam",  native: "മലയാളം",      country: "India",      flag: "🇮🇳", continent: "Asia" },
  { code: "pa",      english: "Punjabi",    native: "ਪੰਜਾਬੀ",      country: "India",      flag: "🇮🇳", continent: "Asia" },
  // India — remaining 8th Schedule official languages (translations pending).
  { code: "as",      english: "Assamese",   native: "অসমীয়া",      country: "India",      flag: "🇮🇳", continent: "Asia" },
  { code: "or",      english: "Odia",       native: "ଓଡ଼ିଆ",        country: "India",      flag: "🇮🇳", continent: "Asia" },
  { code: "sa",      english: "Sanskrit",   native: "संस्कृतम्",    country: "India",      flag: "🇮🇳", continent: "Asia" },
  { code: "mai",     english: "Maithili",   native: "मैथिली",       country: "India",      flag: "🇮🇳", continent: "Asia" },
  { code: "sat",     english: "Santali",    native: "ᱥᱟᱱᱛᱟᱲᱤ",      country: "India",      flag: "🇮🇳", continent: "Asia" },
  { code: "ks",      english: "Kashmiri",   native: "کٲشُر",        country: "India",      flag: "🇮🇳", continent: "Asia", rtl: true },
  { code: "kok",     english: "Konkani",    native: "कोंकणी",       country: "India",      flag: "🇮🇳", continent: "Asia" },
  { code: "doi",     english: "Dogri",      native: "डोगरी",        country: "India",      flag: "🇮🇳", continent: "Asia" },
  { code: "mni",     english: "Manipuri (Meitei)", native: "ꯃꯤꯇꯩ ꯂꯣꯟ", country: "India",  flag: "🇮🇳", continent: "Asia" },
  { code: "brx",     english: "Bodo",       native: "बड़ो",         country: "India",      flag: "🇮🇳", continent: "Asia" },
  { code: "sd",      english: "Sindhi",     native: "سنڌي",         country: "India",      flag: "🇮🇳", continent: "Asia", rtl: true },
  { code: "ur",      english: "Urdu",       native: "اردو",        country: "Pakistan",   flag: "🇵🇰", continent: "Asia", rtl: true },
  { code: "th",      english: "Thai",       native: "ไทย",         country: "Thailand",   flag: "🇹🇭", continent: "Asia" },
  { code: "vi",      english: "Vietnamese", native: "Tiếng Việt",  country: "Vietnam",    flag: "🇻🇳", continent: "Asia" },
  { code: "id",      english: "Indonesian", native: "Bahasa Indonesia", country: "Indonesia", flag: "🇮🇩", continent: "Asia" },
  { code: "ms",      english: "Malay",      native: "Bahasa Melayu",    country: "Malaysia",  flag: "🇲🇾", continent: "Asia" },
  { code: "fil",     english: "Filipino",   native: "Filipino",    country: "Philippines", flag: "🇵🇭", continent: "Asia" },
  { code: "my",      english: "Burmese",    native: "မြန်မာ",       country: "Myanmar",    flag: "🇲🇲", continent: "Asia" },
  { code: "km",      english: "Khmer",      native: "ខ្មែរ",        country: "Cambodia",   flag: "🇰🇭", continent: "Asia" },
  { code: "lo",      english: "Lao",        native: "ລາວ",         country: "Laos",       flag: "🇱🇦", continent: "Asia" },
  { code: "si",      english: "Sinhala",    native: "සිංහල",       country: "Sri Lanka",  flag: "🇱🇰", continent: "Asia" },
  { code: "ne",      english: "Nepali",     native: "नेपाली",      country: "Nepal",      flag: "🇳🇵", continent: "Asia" },
  { code: "kk",      english: "Kazakh",     native: "Қазақ",       country: "Kazakhstan", flag: "🇰🇿", continent: "Asia" },
  { code: "uz",      english: "Uzbek",      native: "Oʻzbek",      country: "Uzbekistan", flag: "🇺🇿", continent: "Asia" },
  { code: "mn",      english: "Mongolian",  native: "Монгол",      country: "Mongolia",   flag: "🇲🇳", continent: "Asia" },

  // ── Middle East ──────────────────────────────────────────────────────────
  { code: "ar", english: "Arabic",      native: "العربية",    country: "Saudi Arabia", flag: "🇸🇦", continent: "Middle East", rtl: true },
  { code: "he", english: "Hebrew",      native: "עברית",      country: "Israel",       flag: "🇮🇱", continent: "Middle East", rtl: true },
  { code: "fa", english: "Persian",     native: "فارسی",      country: "Iran",         flag: "🇮🇷", continent: "Middle East", rtl: true },
  { code: "ps", english: "Pashto",      native: "پښتو",       country: "Afghanistan",  flag: "🇦🇫", continent: "Middle East", rtl: true },
  { code: "tr", english: "Turkish",     native: "Türkçe",     country: "Türkiye",      flag: "🇹🇷", continent: "Middle East" },
  { code: "az", english: "Azerbaijani", native: "Azərbaycan", country: "Azerbaijan",   flag: "🇦🇿", continent: "Middle East" },
  { code: "ku", english: "Kurdish",     native: "Kurdî",      country: "Kurdistan",    flag: "🇮🇶", continent: "Middle East" },

  // ── Africa ───────────────────────────────────────────────────────────────
  { code: "sw", english: "Swahili",     native: "Kiswahili",    country: "Tanzania",     flag: "🇹🇿", continent: "Africa" },
  { code: "am", english: "Amharic",     native: "አማርኛ",        country: "Ethiopia",     flag: "🇪🇹", continent: "Africa" },
  { code: "ha", english: "Hausa",       native: "Hausa",        country: "Nigeria",      flag: "🇳🇬", continent: "Africa" },
  { code: "yo", english: "Yoruba",      native: "Yorùbá",       country: "Nigeria",      flag: "🇳🇬", continent: "Africa" },
  { code: "ig", english: "Igbo",        native: "Igbo",         country: "Nigeria",      flag: "🇳🇬", continent: "Africa" },
  { code: "zu", english: "Zulu",        native: "isiZulu",      country: "South Africa", flag: "🇿🇦", continent: "Africa" },
  { code: "xh", english: "Xhosa",       native: "isiXhosa",     country: "South Africa", flag: "🇿🇦", continent: "Africa" },
  { code: "af", english: "Afrikaans",   native: "Afrikaans",    country: "South Africa", flag: "🇿🇦", continent: "Africa" },
  { code: "so", english: "Somali",      native: "Soomaali",     country: "Somalia",      flag: "🇸🇴", continent: "Africa" },
  { code: "rw", english: "Kinyarwanda", native: "Ikinyarwanda", country: "Rwanda",       flag: "🇷🇼", continent: "Africa" },
  { code: "mg", english: "Malagasy",    native: "Malagasy",     country: "Madagascar",   flag: "🇲🇬", continent: "Africa" },
  { code: "sn", english: "Shona",       native: "chiShona",     country: "Zimbabwe",     flag: "🇿🇼", continent: "Africa" },
  { code: "ny", english: "Chichewa",    native: "Chichewa",     country: "Malawi",       flag: "🇲🇼", continent: "Africa" },

  // ── North America ────────────────────────────────────────────────────────
  { code: "en-US", english: "English (US)",     native: "English (US)",      country: "United States", flag: "🇺🇸", continent: "North America" },
  { code: "es-MX", english: "Spanish (Mexico)", native: "Español (México)",  country: "Mexico",        flag: "🇲🇽", continent: "North America" },
  { code: "fr-CA", english: "French (Canada)",  native: "Français (Canada)", country: "Canada",        flag: "🇨🇦", continent: "North America" },
  { code: "ht",    english: "Haitian Creole",   native: "Kreyòl ayisyen",    country: "Haiti",         flag: "🇭🇹", continent: "North America" },
  { code: "nv",    english: "Navajo",           native: "Diné bizaad",       country: "United States", flag: "🇺🇸", continent: "North America" },

  // ── South America ────────────────────────────────────────────────────────
  { code: "pt-BR",  english: "Portuguese (Brazil)",     native: "Português (Brasil)",      country: "Brazil",        flag: "🇧🇷", continent: "South America" },
  { code: "es-419", english: "Spanish (Latin America)", native: "Español (Latinoamérica)", country: "Latin America", flag: "🌎", continent: "South America" },
  { code: "qu",     english: "Quechua",                 native: "Runa Simi",               country: "Peru",          flag: "🇵🇪", continent: "South America" },
  { code: "gn",     english: "Guarani",                 native: "Avañe'ẽ",                 country: "Paraguay",      flag: "🇵🇾", continent: "South America" },
  { code: "ay",     english: "Aymara",                  native: "Aymar aru",               country: "Bolivia",       flag: "🇧🇴", continent: "South America" },

  // ── Oceania ──────────────────────────────────────────────────────────────
  { code: "en-AU", english: "English (Australia)", native: "English (Australia)", country: "Australia",   flag: "🇦🇺", continent: "Oceania" },
  { code: "mi",    english: "Māori",   native: "Te Reo Māori",   country: "New Zealand", flag: "🇳🇿", continent: "Oceania" },
  { code: "sm",    english: "Samoan",  native: "Gagana Sāmoa",   country: "Samoa",       flag: "🇼🇸", continent: "Oceania" },
  { code: "to",    english: "Tongan",  native: "Lea Faka-Tonga", country: "Tonga",       flag: "🇹🇴", continent: "Oceania" },
  { code: "fj",    english: "Fijian",  native: "Na Vosa Vakaviti", country: "Fiji",      flag: "🇫🇯", continent: "Oceania" },
  { code: "haw",   english: "Hawaiian", native: "ʻŌlelo Hawaiʻi", country: "Hawaii (USA)", flag: "🇺🇸", continent: "Oceania" },
];

/** The source-of-truth / fallback locale (all keys are guaranteed to exist here) + the ONLY one
 *  shipped in the bundle. */
export const SOURCE_LOCALE: LocaleCode = "en-GB";
/** The locale the app boots in before a saved/system choice is applied. */
export const DEFAULT_LOCALE: LocaleCode = "en-GB";

export const isLocale = (s: string): s is LocaleCode => LANGUAGES.some((l) => l.code === s);
export const isRtl = (code: LocaleCode): boolean => !!LANGUAGES.find((l) => l.code === code)?.rtl;
export const findLanguage = (code: LocaleCode): Language | undefined => LANGUAGES.find((l) => l.code === code);

/** The languages grouped by continent, in display order — for a sectioned picker. */
export function languagesByContinent(): { continent: Continent; items: Language[] }[] {
  return CONTINENTS.map((continent) => ({ continent, items: LANGUAGES.filter((l) => l.continent === continent) }));
}
