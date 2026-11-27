mod corners;
mod menu;
mod sidecar;

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Listener, Manager, Runtime};
use tauri_plugin_opener::OpenerExt;

/// The workspace window's label, as declared in `tauri.conf.json`.
const MAIN_WINDOW: &str = "main";

/// Emitted by the Angular shell once it has painted.
const READY_EVENT: &str = "glassbeetle://ready";

/// How long to wait for that before showing the window regardless.
const READY_TIMEOUT: Duration = Duration::from_secs(4);

/// Shows and focuses the workspace window.
fn reveal<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Renders a styled error screen inside the webview when the sidecar cannot start.
fn show_error_screen<R: Runtime>(
    app: &AppHandle<R>,
    title: &str,
    message: &str,
    hint: Option<&str>,
) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let hint_html = match hint {
            Some(h) => format!(
                r#"<div style="background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:12px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;color:#79c0ff;margin:16px 0;text-align:left;">{h}</div>"#
            ),
            None => String::new(),
        };

        let script = format!(
            r#"
            (function() {{
                const show = () => {{
                    document.body.innerHTML = `
                        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;padding:32px;text-align:center;user-select:none;">
                            <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px 40px;max-width:520px;box-shadow:0 8px 24px rgba(0,0,0,0.5);">
                                <div style="font-size:36px;margin-bottom:16px;">⚠️</div>
                                <h1 style="font-size:20px;font-weight:600;margin:0 0 12px 0;color:#f85149;">{title}</h1>
                                <p style="font-size:14px;line-height:1.6;color:#8b949e;margin:0 0 12px 0;">{message}</p>
                                {hint_html}
                            </div>
                        </div>
                    `;
                }};
                if (document.body) {{ show(); }} else {{ document.addEventListener('DOMContentLoaded', show); }}
            }})();
            "#
        );

        let _ = window.eval(&script);
        reveal(app);
    }
}

/// Opens a URL in the user's browser on the frontend's behalf.
///
/// The scheme is checked here rather than trusted from the webview. The
/// frontend only ever needs to open documentation and the repository, and a
/// command that hands the host any string it is given is a wider door than
/// this app has a use for.
#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("only http and https URLs can be opened".into());
    }

    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            app.set_menu(menu::build(app.handle())?)?;

            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                corners::round(&window, corners::WINDOW_RADIUS);
            }

            // In development (`npm run dev`), the API is started externally by the
            // dev toolchain in watch mode. In release builds (or when forced via
            // `GLASSBEETLE_FORCE_SIDECAR=1`), the Rust shell spawns and manages
            // the compiled sidecar binary directly.
            let is_dev = cfg!(debug_assertions);
            let force_sidecar = std::env::var("GLASSBEETLE_FORCE_SIDECAR")
                .map(|v| v == "1" || v == "true")
                .unwrap_or(false);
            let manage_sidecar = !is_dev || force_sidecar;

            if manage_sidecar {
                if sidecar::is_port_in_use(sidecar::DEFAULT_PORT) {
                    log::error!(
                        "Port {} is already in use; cannot start sidecar API",
                        sidecar::DEFAULT_PORT
                    );
                    show_error_screen(
                        app.handle(),
                        "Port 3000 is already in use",
                        "Glassbeetle API cannot start because another process is listening on port 3000.",
                        Some("# Free the port from a terminal:<br/>npm run stop"),
                    );
                    return Ok(());
                }

                match sidecar::SidecarManager::start(sidecar::DEFAULT_PORT) {
                    Ok(manager) => {
                        app.manage(Arc::new(manager));
                    }
                    Err(err) => {
                        log::error!("Failed to start API sidecar: {err}");
                        show_error_screen(
                            app.handle(),
                            "Failed to start backend API",
                            &err,
                            Some("# Compile the sidecar binary:<br/>npm run build:sidecar"),
                        );
                        return Ok(());
                    }
                }

                // Poll health in the background to ensure API answered before window appears
                let health_app = app.handle().clone();
                std::thread::spawn(move || {
                    let start = std::time::Instant::now();
                    let timeout = Duration::from_secs(20);
                    let mut ready = false;
                    while start.elapsed() < timeout {
                        if sidecar::probe_health(sidecar::DEFAULT_PORT) {
                            ready = true;
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(150));
                    }
                    if !ready {
                        log::error!("API sidecar failed health check within {timeout:?}");
                        show_error_screen(
                            &health_app,
                            "Backend API did not respond",
                            "The backend API was started but did not respond to health checks in time.",
                            Some("# Check running processes or logs:<br/>npm run stop"),
                        );
                    } else {
                        log::info!("API sidecar answered health check successfully");
                    }
                });
            }

            // The window is created hidden and revealed once the frontend
            // reports it has painted. A webview shown while still blank is a
            // white rectangle for a moment, which on a dark workspace reads as
            // a flash on every launch.
            let on_ready = app.handle().clone();
            app.once(READY_EVENT, move |_| {
                log::info!("frontend ready; revealing the window");
                reveal(&on_ready);
            });

            // A window that is hidden until the frontend asks for it is only
            // ever as reliable as the frontend. If the dev server is down, the
            // bundle fails to boot or the event is lost, the app would sit
            // there as a process with nothing on screen and no way to tell
            // what went wrong. After the grace period it is shown regardless:
            // a window displaying an error beats no window at all.
            let fallback_timeout = if manage_sidecar {
                Duration::from_secs(12)
            } else {
                READY_TIMEOUT
            };
            let fallback = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(fallback_timeout);

                if let Some(window) = fallback.get_webview_window(MAIN_WINDOW) {
                    if !window.is_visible().unwrap_or(true) {
                        log::warn!(
                            "frontend did not report ready within {fallback_timeout:?}; \
                             showing the window anyway"
                        );
                        reveal(&fallback);
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed = event {
                if let Some(sidecar) = window.app_handle().try_state::<Arc<sidecar::SidecarManager>>() {
                    sidecar.stop();
                }
            }
        })
        .on_menu_event(|app, event| menu::handle(app, event.id().as_ref()))
        .invoke_handler(tauri::generate_handler![open_external])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
