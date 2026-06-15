# TelosPDF translations

TelosPDF's UI is written in **English (UK)** — the strings in the code are the
source of truth, so `en-GB` has no file here. Every other language is an
*override file* mapping each en-GB string to its translation (gettext-style),
downloaded by the app when you pick that language in
**Settings → Region and language**.

## Contributing a translation

1. Edit `<code>.src.json` for your language (BCP-47 code, e.g. `hi`, `pt-BR`,
   `zh-Hans`). Fill in the empty `""` values — untranslated keys simply fall
   back to English.
2. Run `node build-locales.mjs` — it regenerates `<code>.json` (the flat
   runtime file the app downloads) and `manifest.json` (per-file hashes the
   app uses to detect updates).
3. Open a pull request.

`en-US.json` is generated automatically from a UK→US spelling transform — do
not edit it by hand.
