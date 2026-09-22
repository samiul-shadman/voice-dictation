use tauri::{AppHandle, Manager, WebviewWindow};

#[tauri::command]
pub fn configure_overlay_window(app: AppHandle, label: String) -> Result<(), String> {
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("overlay window '{label}' not found"))?;
    apply_overlay_hints(&window)
}

// GNOME Shell's windowAttentionHandler ignores windows that report
// `is_skip_taskbar()`; asserting the hints synchronously (rather than relying on
// Tauri's async window-option queue) guarantees they are on the X11 window
// before its first map. See __plans notes on the "Tauri App is ready" toast.
#[cfg(target_os = "linux")]
fn apply_overlay_hints(window: &WebviewWindow) -> Result<(), String> {
    use gtk::prelude::*;

    let gtk_window = window.gtk_window().map_err(|e| e.to_string())?;
    gtk_window.set_skip_taskbar_hint(true);
    gtk_window.set_skip_pager_hint(true);
    gtk_window.set_type_hint(gtk::gdk::WindowTypeHint::Notification);
    gtk_window.set_accept_focus(false);
    gtk_window.set_focus_on_map(false);
    gtk_window.set_urgency_hint(false);
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn apply_overlay_hints(_window: &WebviewWindow) -> Result<(), String> {
    Ok(())
}
