//! The macOS menu bar. Tauri's default menu binds ⌘W to "Close Window", and
//! menu shortcuts win over the webview, so ⌘W would close every tab at once
//! instead of the current one. This menu keeps the standard items (the Edit
//! menu is what makes ⌘C/⌘V work in text fields) but leaves ⌘W to the app.

use tauri::menu::{Menu, MenuBuilder, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let app_menu = SubmenuBuilder::new(app, "Burrow")
        .about(None)
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
