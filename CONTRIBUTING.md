# Contributing to TelosPDF

Thanks for your interest in contributing to TelosPDF!

## Ground rules

- **License gate**: TelosPDF is MIT. Only permissive dependency licences are
  allowed — CI (`deny.toml`) hard-fails on anything else, including wrappers
  around non-permissive engines. Banned by design, not oversight.
- **Core purity**: nothing under `crates/` may depend on Tauri or UI code. The core must
  stay embeddable (CLI, servers, future non-Tauri shells).
- **The webview never touches PDF bytes.** Rendering and mutation happen in Rust; the UI
  consumes tiles and commands. PRs that parse PDFs in TypeScript will be redirected.
- **Cross-platform is a hard requirement**: desktop (macOS/Windows/Linux) *and* Android.
  Features that can't reach Android must degrade to "desktop-only" explicitly, not break.

## Easy on-ramps (no Rust needed)

- **Corpus files**: PDFs that render wrong, open slowly, or crash other viewers.
- **Tool UIs**: Tool Pane panels and wizards are plain TypeScript packages over the command
  registry (`packages/`).
- **Themes**: workbench token JSON (see `packages/shell/src/styles.css`).

## Dev setup

See the Building section in [README.md](README.md). Before pushing:

```sh
cargo test --workspace
cargo fmt --all
pnpm typecheck
```
