//! Rounded corners for the transparent, undecorated window.
//!
//! The window is a pane of glass the system blurs. Its glass view ignores the
//! corner radius it is given, so without this the blur fills the window's full
//! rectangle and the old square shape shows behind the rounded page. Rounding
//! and clipping the window's own views cuts the glass, the webview and
//! everything else in it to one shape.

use tauri::{Runtime, WebviewWindow};

/// The window's corner radius, in points. Kept equal to `--gb-radius-window`
/// in the web app, which rounds the page itself to the same curve.
pub const WINDOW_RADIUS: f64 = 32.0;

#[cfg(target_os = "macos")]
pub fn round<R: Runtime>(window: &WebviewWindow<R>, radius: f64) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let Ok(ns_window) = window.ns_window() else {
        log::warn!("no native window to round");
        return;
    };
    let ns_window = ns_window.cast::<AnyObject>();

    // SAFETY: called on the main thread during setup with a live NSWindow;
    // every view and layer is checked for null before it is messaged.
    unsafe {
        let content: *mut AnyObject = msg_send![ns_window, contentView];
        if content.is_null() {
            return;
        }

        // The frame view behind the content view draws too, so both are cut.
        let frame: *mut AnyObject = msg_send![content, superview];

        for view in [content, frame] {
            if view.is_null() {
                continue;
            }

            let _: () = msg_send![view, setWantsLayer: true];
            let layer: *mut AnyObject = msg_send![view, layer];
            if layer.is_null() {
                continue;
            }

            let _: () = msg_send![layer, setCornerRadius: radius];
            let _: () = msg_send![layer, setMasksToBounds: true];
        }
    }
}

/// Windows 11 rounds an undecorated window's corners itself, and Linux leaves
/// it to the compositor, so there is nothing to do elsewhere.
#[cfg(not(target_os = "macos"))]
pub fn round<R: Runtime>(_window: &WebviewWindow<R>, _radius: f64) {}
