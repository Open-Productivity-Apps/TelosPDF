//! Protect/unlock round-trip: protect a blank PDF, verify PDFium demands a
//! password, unlock with the right password, verify it renders again.
//! Requires `cargo xtask fetch-pdfium`.

use telos_doc::{ProtectPermissions, create_blank, protect_to, unlock_to};

#[test]
fn protect_then_unlock_round_trip() {
    let dir = std::env::temp_dir().join("telos-protect");
    std::fs::create_dir_all(&dir).unwrap();
    let plain = dir.join("plain.pdf");
    let locked = dir.join("locked.pdf");
    let unlocked = dir.join("unlocked.pdf");
    create_blank(&plain).unwrap();

    protect_to(
        &plain,
        &locked,
        "s3cret",
        "",
        ProtectPermissions {
            print: true,
            copy: false,
            modify: false,
            annotate: true,
        },
    )
    .unwrap();

    let renderer = telos_render::Renderer::new().expect("run `cargo xtask fetch-pdfium`");
    assert!(
        renderer.needs_password(&locked).unwrap(),
        "protected file must demand a password"
    );

    // Wrong password refused.
    assert!(unlock_to(&locked, &unlocked, "wrong").is_err());

    // Right password unlocks; result opens without a password and renders.
    unlock_to(&locked, &unlocked, "s3cret").unwrap();
    assert!(!renderer.needs_password(&unlocked).unwrap());
    assert_eq!(renderer.page_count(&unlocked).unwrap(), 1);
    let png = renderer.render_page_png(&unlocked, 0, 300, 0).unwrap();
    assert!(png.len() > 100);
}
