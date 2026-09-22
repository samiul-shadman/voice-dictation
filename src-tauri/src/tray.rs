use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};

pub const TRAY_ID: &str = "voice-dictation-indicator";
const ICON_SIZE: u32 = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayState {
    Idle,
    Recording,
    Transcribing,
    Error,
}

impl TrayState {
    pub fn parse(raw: &str) -> Self {
        match raw {
            "recording" => Self::Recording,
            "transcribing" => Self::Transcribing,
            "error" => Self::Error,
            _ => Self::Idle,
        }
    }

    fn rgba(self) -> [u8; 4] {
        match self {
            Self::Idle => [148, 163, 184, 255],
            Self::Recording => [244, 63, 94, 255],
            Self::Transcribing => [56, 189, 248, 255],
            Self::Error => [251, 146, 60, 255],
        }
    }
}

fn icon_for(state: TrayState) -> Image<'static> {
    let size = ICON_SIZE;
    let mut rgba = vec![0u8; (size * size * 4) as usize];
    let color = state.rgba();
    let center = (size as f32 - 1.0) / 2.0;
    let radius = size as f32 / 2.0 - 2.0;
    for y in 0..size {
        for x in 0..size {
            let dx = x as f32 - center;
            let dy = y as f32 - center;
            let dist = (dx * dx + dy * dy).sqrt();
            let coverage = (radius + 0.5 - dist).clamp(0.0, 1.0);
            let idx = ((y * size + x) * 4) as usize;
            rgba[idx] = color[0];
            rgba[idx + 1] = color[1];
            rgba[idx + 2] = color[2];
            rgba[idx + 3] = (coverage * color[3] as f32) as u8;
        }
    }
    Image::new_owned(rgba, size, size)
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Voice Dictation", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon_for(TrayState::Idle))
        .tooltip("Voice Dictation")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

#[tauri::command]
pub fn set_tray_state(app: AppHandle, state: String) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_icon(Some(icon_for(TrayState::parse(&state))));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_maps_known_state_names() {
        assert_eq!(TrayState::parse("idle"), TrayState::Idle);
        assert_eq!(TrayState::parse("recording"), TrayState::Recording);
        assert_eq!(TrayState::parse("transcribing"), TrayState::Transcribing);
        assert_eq!(TrayState::parse("error"), TrayState::Error);
        assert_eq!(TrayState::parse("nonsense"), TrayState::Idle);
    }

    #[test]
    fn icon_buffer_is_rgba_sized() {
        let image = icon_for(TrayState::Recording);
        assert_eq!(image.width(), ICON_SIZE);
        assert_eq!(image.height(), ICON_SIZE);
        assert_eq!(image.rgba().len(), (ICON_SIZE * ICON_SIZE * 4) as usize);
    }

    #[test]
    fn states_have_distinct_colors() {
        let colors = [
            TrayState::Idle.rgba(),
            TrayState::Recording.rgba(),
            TrayState::Transcribing.rgba(),
            TrayState::Error.rgba(),
        ];
        for i in 0..colors.len() {
            for j in (i + 1)..colors.len() {
                assert_ne!(colors[i], colors[j]);
            }
        }
    }
}
