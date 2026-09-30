//! The macOS menu bar. Tauri's default menu binds ⌘W to "Close Window", and
//! menu shortcuts win over the webview, so ⌘W would close every tab at once
//! instead of the current one. This menu keeps the standard items (the Edit
//! menu is what makes ⌘C/⌘V work in text fields) but leaves ⌘W to the app.
//!
//! "About Burrow" and "View Startup" are custom items (not the native
//! `.about()`/dialog) so they can open the app's own themed overlays instead
//! of an OS-styled panel; `lib.rs` wires their ids to events the frontend
//! listens for.
//!
//! Labels follow the app's own language setting (src/i18n on the frontend),
//! not macOS's — this menu used to be pinned to Korean for that reason (a
//! mixed-language menu reads worse than an all-one-language one), but now
//! that the app can switch languages itself, the menu switches with it via
//! `set_menu_locale` (called from the frontend's `onLocaleChange`).

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

pub const ABOUT_ID: &str = "about-burrow";
pub const VIEW_STARTUP_ID: &str = "view-startup";
pub const COPY_ID: &str = "menu-copy";

struct Labels {
    about: &'static str,
    view_startup: &'static str,
    hide: &'static str,
    hide_others: &'static str,
    show_all: &'static str,
    quit: &'static str,
    edit_menu: &'static str,
    undo: &'static str,
    redo: &'static str,
    cut: &'static str,
    copy: &'static str,
    paste: &'static str,
    select_all: &'static str,
    window_menu: &'static str,
    minimize: &'static str,
    zoom: &'static str,
    fullscreen: &'static str,
}

const KO: Labels = Labels {
    about: "Burrow 정보",
    view_startup: "연결 목록 보기…",
    hide: "Burrow 가리기",
    hide_others: "다른 항목 가리기",
    show_all: "모두 보기",
    quit: "Burrow 종료",
    edit_menu: "편집",
    undo: "실행 취소",
    redo: "다시 실행",
    cut: "잘라내기",
    copy: "복사하기",
    paste: "붙여넣기",
    select_all: "모두 선택",
    window_menu: "윈도우",
    minimize: "최소화",
    zoom: "확대/축소",
    fullscreen: "전체 화면 전환",
};

const EN: Labels = Labels {
    about: "About Burrow",
    view_startup: "View Startup…",
    hide: "Hide Burrow",
    hide_others: "Hide Others",
    show_all: "Show All",
    quit: "Quit Burrow",
    edit_menu: "Edit",
    undo: "Undo",
    redo: "Redo",
    cut: "Cut",
    copy: "Copy",
    paste: "Paste",
    select_all: "Select All",
    window_menu: "Window",
    minimize: "Minimize",
    zoom: "Zoom",
    fullscreen: "Enter Full Screen",
};

fn labels_for(locale: &str) -> &'static Labels {
    if locale == "ko" {
        &KO
    } else {
        &EN
    }
}

/// Reads `config.json`'s `locale` directly off disk, without going through
/// the managed `Store` — the menu is built before `.setup()` runs (where the
/// `Store` is opened and put into app state), so nothing is available yet
/// except the filesystem. Missing/unreadable/unrecognized falls back to
/// "en", matching `ConfigFile`'s own default (store/model.rs).
fn detect_locale() -> String {
    let path = crate::store::default_root().join("config.json");
    let locale = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("locale").and_then(|l| l.as_str()).map(str::to_string));
    match locale.as_deref() {
        Some("ko") => "ko".into(),
        _ => "en".into(),
    }
}

fn build_with_labels<R: Runtime>(app: &AppHandle<R>, l: &Labels) -> tauri::Result<Menu<R>> {
    let about = MenuItemBuilder::with_id(ABOUT_ID, l.about).build(app)?;
    let view_startup = MenuItemBuilder::with_id(VIEW_STARTUP_ID, l.view_startup).build(app)?;
    let app_menu = SubmenuBuilder::new(app, "Burrow")
        .item(&about)
        .separator()
        .item(&view_startup)
        .separator()
        .hide_with_text(l.hide)
        .hide_others_with_text(l.hide_others)
        .show_all_with_text(l.show_all)
        .separator()
        .quit_with_text(l.quit)
        .build()?;
    // Custom (not the predefined Copy): a native ⌘C item swallows the key
    // before the webview sees it, and xterm's selection is not a DOM
    // selection, so the native copy would put nothing (or stale text) on the
    // clipboard. The frontend decides what "copy" means for the focus.
    let copy = MenuItemBuilder::with_id(COPY_ID, l.copy)
        .accelerator("CmdOrCtrl+C")
        .build(app)?;
    let edit = SubmenuBuilder::new(app, l.edit_menu)
        .undo_with_text(l.undo)
        .redo_with_text(l.redo)
        .separator()
        .cut_with_text(l.cut)
        .item(&copy)
        .paste_with_text(l.paste)
        .select_all_with_text(l.select_all)
        .build()?;
    let window = SubmenuBuilder::new(app, l.window_menu)
        .minimize_with_text(l.minimize)
        .maximize_with_text(l.zoom)
        .separator()
        .fullscreen_with_text(l.fullscreen)
        .build()?;
    MenuBuilder::new(app)
        .items(&[&app_menu, &edit, &window])
        .build()
}

/// Built once at startup (`.menu(menu::build)` in lib.rs, called before
/// `.setup()`), in whatever language `config.json` was last saved with.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    build_with_labels(app, labels_for(&detect_locale()))
}

/// Rebuilds the menu bar in the given language and installs it immediately —
/// called from the frontend whenever the user switches languages, so the
/// native menu updates live like every other part of the UI.
#[tauri::command]
pub fn set_menu_locale(app: tauri::AppHandle, locale: String) -> Result<(), String> {
    let menu = build_with_labels(&app, labels_for(&locale)).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}
