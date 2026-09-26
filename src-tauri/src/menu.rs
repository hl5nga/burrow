//! The macOS menu bar. Tauri's default menu binds ⌘W to "Close Window", and
//! menu shortcuts win over the webview, so ⌘W would close every tab at once
//! instead of the current one. This menu keeps the standard items (the Edit
//! menu is what makes ⌘C/⌘V work in text fields) but leaves ⌘W to the app.
//!
//! "About Burrow" and "연결 목록 보기" are custom items (not the native
//! `.about()`/dialog) so they can open the app's own themed overlays instead
//! of an OS-styled panel; `lib.rs` wires their ids to events the frontend
//! listens for.

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

pub const ABOUT_ID: &str = "about-burrow";
pub const VIEW_STARTUP_ID: &str = "view-startup";

/// All-Korean labels: the predefined items below would otherwise render in
/// whatever language macOS's own UI is set to (English on this Mac), while
/// our own custom items were Korean — a mixed menu. Every label here is
/// pinned to Korean instead of relying on that OS auto-localization.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let about = MenuItemBuilder::with_id(ABOUT_ID, "Burrow 정보").build(app)?;
    let view_startup = MenuItemBuilder::with_id(VIEW_STARTUP_ID, "연결 목록 보기…").build(app)?;
    let app_menu = SubmenuBuilder::new(app, "Burrow")
        .item(&about)
        .separator()
        .item(&view_startup)
        .separator()
        .hide_with_text("Burrow 가리기")
        .hide_others_with_text("다른 항목 가리기")
        .show_all_with_text("모두 보기")
        .separator()
        .quit_with_text("Burrow 종료")
        .build()?;
    let edit = SubmenuBuilder::new(app, "편집")
        .undo_with_text("실행 취소")
        .redo_with_text("다시 실행")
        .separator()
        .cut_with_text("잘라내기")
        .copy_with_text("복사하기")
        .paste_with_text("붙여넣기")
        .select_all_with_text("모두 선택")
        .build()?;
    let window = SubmenuBuilder::new(app, "윈도우")
        .minimize_with_text("최소화")
        .maximize_with_text("확대/축소")
        .separator()
        .fullscreen_with_text("전체 화면 전환")
        .build()?;
    MenuBuilder::new(app)
        .items(&[&app_menu, &edit, &window])
        .build()
}
