// Region & formats: the app-level locale preferences (Settings → General → Region).
// Region is AUTO-detected offline, preferring the user's actual REGION (the macOS Region /
// Format setting + timezone) over the UI LANGUAGE — running e.g. US English in the UK must
// detect GB, not US. An explicit user-triggered IP lookup is the last resort. Everything
// below the region selector (currency · separators · units · map POV) follows it, each
// individually overridable.

export type NumberStyle = "1,234.56" | "1.234,56" | "1 234,56" | "1,23,456.78";

export interface AppRegion {
  /** ISO 3166-1 alpha-2 (e.g. "US", "IN"); "" = undetected. */
  code: string;
  currency: string;
  numberStyle: NumberStyle;
  units: "metric" | "imperial";
  /** Disputed-border point of view for geo maps ("neutral" default). */
  mapPov: "neutral" | "in" | "cn" | "pk" | "us";
  /** Short-date field order — region default, individually overridable. */
  dateOrder: "DMY" | "MDY" | "YMD";
  /** 12- or 24-hour clock — region default, individually overridable. */
  clock: "12h" | "24h";
}

/** Region presets — currency, separator style and units a region conventionally uses. */
const PRESETS: Record<string, Omit<AppRegion, "code" | "mapPov" | "dateOrder" | "clock"> & { mapPov?: AppRegion["mapPov"] }> = {
  US: { currency: "USD", numberStyle: "1,234.56", units: "imperial", mapPov: "us" },
  GB: { currency: "GBP", numberStyle: "1,234.56", units: "metric" },
  IN: { currency: "INR", numberStyle: "1,23,456.78", units: "metric", mapPov: "in" },
  CN: { currency: "CNY", numberStyle: "1,234.56", units: "metric", mapPov: "cn" },
  PK: { currency: "PKR", numberStyle: "1,23,456.78", units: "metric", mapPov: "pk" },
  JP: { currency: "JPY", numberStyle: "1,234.56", units: "metric" },
  DE: { currency: "EUR", numberStyle: "1.234,56", units: "metric" },
  FR: { currency: "EUR", numberStyle: "1 234,56", units: "metric" },
  ES: { currency: "EUR", numberStyle: "1.234,56", units: "metric" },
  IT: { currency: "EUR", numberStyle: "1.234,56", units: "metric" },
  NL: { currency: "EUR", numberStyle: "1.234,56", units: "metric" },
  BR: { currency: "BRL", numberStyle: "1.234,56", units: "metric" },
  RU: { currency: "RUB", numberStyle: "1 234,56", units: "metric" },
  AU: { currency: "AUD", numberStyle: "1,234.56", units: "metric" },
  CA: { currency: "CAD", numberStyle: "1,234.56", units: "metric" },
  AE: { currency: "AED", numberStyle: "1,234.56", units: "metric" },
  SG: { currency: "SGD", numberStyle: "1,234.56", units: "metric" },
  KR: { currency: "KRW", numberStyle: "1,234.56", units: "metric" },
  MX: { currency: "MXN", numberStyle: "1,234.56", units: "metric" },
  ZA: { currency: "ZAR", numberStyle: "1 234,56", units: "metric" },
};

/** Every selectable country, grouped by continent, as compact `CC:CUR` pairs.
 *  One table drives the picker grouping, the currency default, and the
 *  valid-region check; everything else (separators, date order, clock) is
 *  derived per country from Intl at pick time. */
const COUNTRY_TABLE: [string, string][] = [
  ["Europe", "AD:EUR AL:ALL AT:EUR BA:BAM BE:EUR BG:BGN BY:BYN CH:CHF CY:EUR CZ:CZK DE:EUR DK:DKK EE:EUR ES:EUR FI:EUR FR:EUR GB:GBP GR:EUR HR:EUR HU:HUF IE:EUR IS:ISK IT:EUR LI:CHF LT:EUR LU:EUR LV:EUR MC:EUR MD:MDL ME:EUR MK:MKD MT:EUR NL:EUR NO:NOK PL:PLN PT:EUR RO:RON RS:RSD RU:RUB SE:SEK SI:EUR SK:EUR SM:EUR UA:UAH VA:EUR"],
  ["Asia", "AF:AFN AM:AMD AZ:AZN BD:BDT BN:BND BT:BTN CN:CNY GE:GEL HK:HKD ID:IDR IN:INR JP:JPY KG:KGS KH:KHR KP:KPW KR:KRW KZ:KZT LA:LAK LK:LKR MM:MMK MN:MNT MO:MOP MV:MVR MY:MYR NP:NPR PH:PHP PK:PKR SG:SGD TH:THB TJ:TJS TL:USD TM:TMT TW:TWD UZ:UZS VN:VND"],
  ["Middle East", "AE:AED BH:BHD IL:ILS IQ:IQD IR:IRR JO:JOD KW:KWD LB:LBP OM:OMR PS:ILS QA:QAR SA:SAR SY:SYP TR:TRY YE:YER"],
  ["Africa", "AO:AOA BF:XOF BI:BIF BJ:XOF BW:BWP CD:CDF CF:XAF CG:XAF CI:XOF CM:XAF CV:CVE DJ:DJF DZ:DZD EG:EGP ER:ERN ET:ETB GA:XAF GH:GHS GM:GMD GN:GNF GQ:XAF GW:XOF KE:KES KM:KMF LR:LRD LS:LSL LY:LYD MA:MAD MG:MGA ML:XOF MR:MRU MU:MUR MW:MWK MZ:MZN NA:NAD NE:XOF NG:NGN RW:RWF SC:SCR SD:SDG SL:SLE SN:XOF SO:SOS SS:SSP ST:STN SZ:SZL TD:XAF TG:XOF TN:TND TZ:TZS UG:UGX ZA:ZAR ZM:ZMW ZW:ZWL"],
  ["North America", "AG:XCD BB:BBD BS:BSD BZ:BZD CA:CAD CR:CRC CU:CUP DM:XCD DO:DOP GD:XCD GT:GTQ HN:HNL HT:HTG JM:JMD KN:XCD LC:XCD MX:MXN NI:NIO PA:PAB SV:USD TT:TTD US:USD VC:XCD"],
  ["South America", "AR:ARS BO:BOB BR:BRL CL:CLP CO:COP EC:USD GY:GYD PE:PEN PY:PYG SR:SRD UY:UYU VE:VES"],
  ["Oceania", "AU:AUD FJ:FJD FM:USD KI:AUD MH:USD NR:AUD NZ:NZD PG:PGK PW:USD SB:SBD TO:TOP TV:AUD VU:VUV WS:WST"],
];

const COUNTRY_CURRENCY: Record<string, string> = {};
/** Continent → country codes, for the grouped Region picker. */
export const REGION_CONTINENTS: { continent: string; codes: string[] }[] = COUNTRY_TABLE.map(
  ([continent, pairs]) => ({
    continent,
    codes: pairs.split(" ").map((p) => {
      const [cc, cur] = p.split(":");
      COUNTRY_CURRENCY[cc] = cur;
      return cc;
    }),
  }),
);

export const REGION_CHOICES = Object.keys(COUNTRY_CURRENCY).sort();

/** All currencies a region can map to, for the Currency picker. */
export const CURRENCY_CHOICES = [...new Set(Object.values(COUNTRY_CURRENCY))].sort();

/** Separator convention for a country, derived from Intl (lakh grouping,
 *  dot-thousands, space-thousands, or comma-thousands). */
function numberStyleFor(code: string): NumberStyle {
  try {
    const s = new Intl.NumberFormat(`en-${code}`)
      .format(1234567.8)
      .replace(/[  ]/g, " ");
    if (s.includes("12,34,567")) return "1,23,456.78";
    if (s.includes("1.234.567")) return "1.234,56";
    if (s.includes("1 234 567")) return "1 234,56";
  } catch { /* fall through */ }
  return "1,234.56";
}

/** The only countries conventionally on imperial units. */
const IMPERIAL = new Set(["US", "LR", "MM"]);

export const DEFAULT_REGION: AppRegion = { code: "", currency: "USD", numberStyle: "1,234.56", units: "metric", mapPov: "neutral", dateOrder: "MDY", clock: "12h" };

/** Date order + clock a region conventionally uses, derived from the platform so each country
 *  follows its own (e.g. en-GB → day-first, 24-hour; en-US → month-first, 12-hour). */
function dateTimeDefaults(code: string): Pick<AppRegion, "dateOrder" | "clock"> {
  try {
    const loc = `en-${code.toUpperCase()}`;
    const parts = new Intl.DateTimeFormat(loc, { day: "numeric", month: "numeric", year: "numeric" })
      .formatToParts(new Date(Date.UTC(2001, 1, 3))); // 3 Feb 2001 — day ≠ month so order is unambiguous
    const order = parts
      .filter((p) => p.type === "day" || p.type === "month" || p.type === "year")
      .map((p) => (p.type === "day" ? "D" : p.type === "month" ? "M" : "Y"))
      .join("");
    const dateOrder = order === "DMY" || order === "MDY" || order === "YMD" ? (order as AppRegion["dateOrder"]) : "MDY";
    const hour12 = new Intl.DateTimeFormat(loc, { hour: "numeric" }).resolvedOptions().hour12 ?? true;
    return { dateOrder, clock: hour12 ? "12h" : "24h" };
  } catch {
    return { dateOrder: "MDY", clock: "12h" };
  }
}

/** Defaults for a region code: hand-tuned preset when we have one, otherwise
 *  derived — currency from the country table, separators/date/clock from Intl,
 *  imperial units only where that's the convention. */
export function regionDefaults(code: string): AppRegion {
  const cc = code.toUpperCase();
  const p = PRESETS[cc];
  const dt = dateTimeDefaults(cc);
  if (p) return { code: cc, mapPov: "neutral", ...p, ...dt };
  if (COUNTRY_CURRENCY[cc]) {
    return {
      code: cc,
      currency: COUNTRY_CURRENCY[cc],
      numberStyle: numberStyleFor(cc),
      units: IMPERIAL.has(cc) ? "imperial" : "metric",
      mapPov: "neutral",
      ...dt,
    };
  }
  return { ...DEFAULT_REGION, code: cc, ...dt };
}

/** Map a few common IANA timezones to a region (the OFFLINE fallback). */
const TZ_REGION: Record<string, string> = {
  "Asia/Kolkata": "IN", "Asia/Calcutta": "IN", "Asia/Karachi": "PK", "Asia/Shanghai": "CN",
  "Asia/Tokyo": "JP", "Asia/Singapore": "SG", "Asia/Seoul": "KR", "Asia/Dubai": "AE",
  "Europe/London": "GB", "Europe/Berlin": "DE", "Europe/Paris": "FR", "Europe/Madrid": "ES",
  "Europe/Rome": "IT", "Europe/Amsterdam": "NL", "Europe/Moscow": "RU",
  "America/New_York": "US", "America/Chicago": "US", "America/Denver": "US", "America/Los_Angeles": "US",
  "America/Toronto": "CA", "America/Vancouver": "CA", "America/Sao_Paulo": "BR", "America/Mexico_City": "MX",
  "Australia/Sydney": "AU", "Australia/Melbourne": "AU", "Africa/Johannesburg": "ZA",
};

/** Auto-detect the region: ① locale region subtag → ② timezone → ③ (only when
 *  `allowNetwork`) an IP lookup. Returns the ISO code or "". */
export async function detectRegion(allowNetwork: boolean): Promise<string> {
  const known = (c?: string | null): string =>
    c && COUNTRY_CURRENCY[c.toUpperCase()] ? c.toUpperCase() : "";
  let resolved = "";
  let tz = "";
  try {
    const o = Intl.DateTimeFormat().resolvedOptions();
    resolved = o.locale || "";
    tz = o.timeZone || "";
  } catch { /* ignore */ }

  // ① macOS REGION override. When the Region (Format) differs from the UI language, the
  //    resolved locale carries a `-u-rg-<cc>zzzz` extension — e.g. language English (US) but
  //    Region United Kingdom → "en-US-u-rg-gbzzzz". This is the authoritative region.
  const rg = known(/-rg-([a-z]{2})/i.exec(resolved)?.[1]);
  if (rg) return rg;
  // ② Timezone — a physical-location signal the UI language can't pollute (a UK Mac set to US
  //    English still reports Europe/London). Preferred over the language locale.
  if (TZ_REGION[tz]) return TZ_REGION[tz];
  // ③ Region subtag of the resolved locale (the Region setting when it matches the language).
  const resolvedRegion = resolved.split(/[-_]/).slice(1).map(known).find(Boolean);
  if (resolvedRegion) return resolvedRegion;
  // ④ UI-language region subtag — LAST, because language ≠ region.
  const lang = known((navigator.language || "").split("-")[1]);
  if (lang) return lang;
  // ⑤ Optional IP lookup (only when the caller allows network).
  if (allowNetwork) {
    try {
      const r = await fetch("https://ipapi.co/json/", { signal: AbortSignal.timeout(4000) });
      const j = (await r.json()) as { country_code?: string };
      if (j.country_code) return j.country_code.toUpperCase();
    } catch { /* offline — leave undetected */ }
  }
  return "";
}

/** Full country name for an ISO code (e.g. "US" → "United States"), via the platform's
 *  display names (offline). Falls back to the upper-cased code. */
export function regionName(code: string): string {
  if (!code) return "";
  try {
    return new Intl.DisplayNames(undefined, { type: "region" }).of(code.toUpperCase()) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

/** Short date in the chosen field order (DMY / MDY use slashes; YMD uses ISO dashes). */
export function formatRegionDate(d: Date, order: AppRegion["dateOrder"]): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  if (order === "YMD") return `${yyyy}-${mm}-${dd}`;
  if (order === "MDY") return `${mm}/${dd}/${yyyy}`;
  return `${dd}/${mm}/${yyyy}`;
}

/** Long date with a SPELLED-OUT month, in the chosen field order — "20 July 2026" (DMY),
 *  "July 20 2026" (MDY), "2026 July 20" (YMD). Used where a numeric date reads ambiguously
 *  (e.g. the status bar's last-auto-saved stamp). Month name follows the device locale. */
export function formatRegionLongDate(d: Date, order: AppRegion["dateOrder"]): string {
  const day = d.getDate();
  const month = d.toLocaleString(undefined, { month: "long" });
  const year = d.getFullYear();
  if (order === "MDY") return `${month} ${day} ${year}`;
  if (order === "YMD") return `${year} ${month} ${day}`;
  return `${day} ${month} ${year}`;
}

/** Clock time honouring the region's 12/24-hour preference — "12:45 PM" or "13:45". */
export function formatRegionTime(d: Date, clock: AppRegion["clock"]): string {
  const h = d.getHours();
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (clock === "24h") return `${String(h).padStart(2, "0")}:${mm}`;
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${mm} ${suffix}`;
}

/** The Intl locale that produces the chosen separator style. */
export function numberLocale(style: NumberStyle): string {
  switch (style) {
    case "1.234,56": return "de-DE";
    case "1 234,56": return "fr-FR";
    case "1,23,456.78": return "en-IN";
    default: return "en-US";
  }
}
