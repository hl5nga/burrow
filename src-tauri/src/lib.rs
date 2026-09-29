mod clip;
#[cfg(debug_assertions)]
mod devctl;
mod events;
mod files;
mod guardrails;
mod hooks;
mod menu;
mod network;
mod pty;
mod remote;
mod resources;
mod stats;
mod store;
mod tmux;
mod vpn;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::webview::PageLoadEvent;
use tauri::{Manager, RunEvent};

/// Set once the user confirms closing the window (the last tab, the red
/// button, ⌘Q, Dock Quit, or the menu's Burrow 종료 — window.close() emits
/// the same CloseRequested event as those, so one flag covers every path).
struct ConfirmedExit(AtomicBool);

#[tauri::command]
fn confirm_exit(confirmed: tauri::State<'_, ConfirmedExit>) {
    confirmed.0.store(true, Ordering::SeqCst);
}

#[cfg(debug_assertions)]
fn invoke_handler() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        pty::pty_spawn,
        pty::pty_write,
        pty::pty_resize,
        pty::pty_kill,
        store::store_get,
        store::store_put,
        store::store_take_recoveries,
        store::keybinding_defaults,
        stats::stats_record,
        stats::stats_top,
        clip::clip_image_save,
        events::remote_event_stream,
        events::remote_event_stop,
        files::fs_list,
        files::fs_read,
        guardrails::guardrail_test,
        guardrails::guardrail_presets,
        guardrails::remote_sync_guardrails,
        guardrails::claude_hook_install,
        remote::remote_probe,
        remote::remote_reachable,
        remote::remote_cwd,
        resources::resource_sample,
        tmux::tmux_panes,
        tmux::tmux_select_pane,
        vpn::vpn_status,
        vpn::vpn_toggle,
        vpn::network_fingerprint,
        network::network_online,
        vpn::vpn_pre_connect,
        vpn::vpn_post_disconnect,
        remote::remote_install_hooks,
        remote::pty_spawn_ssh,
        confirm_exit,
        devctl::dev_log,
    ]
}

#[cfg(not(debug_assertions))]
fn invoke_handler() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        pty::pty_spawn,
        pty::pty_write,
        pty::pty_resize,
        pty::pty_kill,
        store::store_get,
        store::store_put,
        store::store_take_recoveries,
        store::keybinding_defaults,
        stats::stats_record,
        stats::stats_top,
        clip::clip_image_save,
        events::remote_event_stream,
        events::remote_event_stop,
        files::fs_list,
        files::fs_read,
        guardrails::guardrail_test,
        guardrails::guardrail_presets,
        guardrails::remote_sync_guardrails,
        guardrails::claude_hook_install,
        remote::remote_probe,
        remote::remote_reachable,
        remote::remote_cwd,
        resources::resource_sample,
        tmux::tmux_panes,
        tmux::tmux_select_pane,
        vpn::vpn_status,
        vpn::vpn_toggle,
        vpn::network_fingerprint,
        network::network_online,
        vpn::vpn_pre_connect,
        vpn::vpn_post_disconnect,
        remote::remote_install_hooks,
        remote::pty_spawn_ssh,
        confirm_exit,
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(pty::PtyState::default())
        .manage(events::EventStreams::default())
        .manage(ConfirmedExit(AtomicBool::new(false)))
        .menu(menu::build)
        // The user must confirm before the window (and with it, the app —
        // there's only one window) actually closes; see ConfirmedExit.
        .on_window_event(|window, event| {
            use tauri::Emitter;
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let confirmed = window.state::<ConfirmedExit>();
                if confirmed.0.load(Ordering::SeqCst) {
                    return;
                }
                api.prevent_close();
                let _ = window.emit("confirm-quit", ());
            }
        })
        .on_menu_event(|app, event| {
            use tauri::Emitter;
            let id = event.id().as_ref();
            if id == menu::ABOUT_ID {
                let _ = app.emit("menu-about", ());
            } else if id == menu::VIEW_STARTUP_ID {
                let _ = app.emit("menu-view-startup", ());
            }
        })
        .setup(|app| {
            let store = Arc::new(store::Store::open(store::default_root())?);
            store.start_stats_flusher();
            match hooks::install(store.root()) {
                Ok(dir) => {
                    pty::set_hook_dir(dir);
                    if let Err(e) = guardrails::write_local(&store) {
                        eprintln!("guardrails: cannot write rules: {e}");
                    }
                }
                Err(e) => eprintln!("hooks: cannot install zsh wrappers: {e}"),
            }
            app.manage(store);
            remote::watch_network(app.handle().clone());
            #[cfg(debug_assertions)]
            devctl::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(invoke_handler())
        // A reload (including Vite HMR) starts a fresh page that knows nothing of
        // the old shells, so they would otherwise keep running unseen.
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Started {
                webview.state::<pty::PtyState>().kill_all();
                webview.state::<events::EventStreams>().kill_all();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                app.state::<pty::PtyState>().kill_all();
                app.state::<events::EventStreams>().kill_all();
                if let Err(e) = app.state::<Arc<store::Store>>().flush_stats() {
                    eprintln!("store: cannot write stats on exit: {e}");
                }
                #[cfg(debug_assertions)]
                let _ = std::fs::remove_file(devctl::socket_path());
            }
        });
}
