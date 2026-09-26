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

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let about = MenuItemBuilder::with_id(ABOUT_ID, "About Burrow").build(app)?;
    let view_startup = MenuItemBuilder::with_id(VIEW_STARTUP_ID, "연결 목록 보기…").build(app)?;
    let app_menu = SubmenuBuilder::new(app, "Burrow")
        .item(&about)
        .separator()
        .item(&view_startup)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .fullscreen()
        .build()?;
    MenuBuilder::new(app)
        .items(&[&app_menu, &edit, &window])
        .build()
}
