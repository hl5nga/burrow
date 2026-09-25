#[cfg(debug_assertions)]
mod devctl;
mod hooks;
mod menu;
mod pty;
mod remote;
mod stats;
mod store;

use std::sync::Arc;

use tauri::webview::PageLoadEvent;
use tauri::{Manager, RunEvent};

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
        stats::stats_record,
        stats::stats_top,
        remote::remote_probe,
        remote::remote_reachable,
        remote::remote_install_hooks,
        remote::pty_spawn_ssh,
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
        stats::stats_record,
        stats::stats_top,
        remote::remote_probe,
        remote::remote_reachable,
        remote::remote_install_hooks,
        remote::pty_spawn_ssh,
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(pty::PtyState::default())
        .menu(menu::build)
        .setup(|app| {
            let store = Arc::new(store::Store::open(store::default_root())?);
            store.start_stats_flusher();
            match hooks::install(store.root()) {
                Ok(dir) => pty::set_hook_dir(dir),
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
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                app.state::<pty::PtyState>().kill_all();
                if let Err(e) = app.state::<Arc<store::Store>>().flush_stats() {
                    eprintln!("store: cannot write stats on exit: {e}");
                }
                #[cfg(debug_assertions)]
                let _ = std::fs::remove_file(devctl::socket_path());
            }
        });
}
