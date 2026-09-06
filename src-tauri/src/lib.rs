mod audiodecode;
mod downloader;
mod engines;
mod models;
mod paste;
mod recorder;
mod settings;
mod sysinfo;
mod transcriber;
mod transcripts;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let settings = settings::SettingsState::load(app.handle())?;
            app.manage(settings);
            sysinfo::detect_and_cache(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings::get_settings,
            settings::set_shortcut,
            settings::set_global_shortcuts_enabled,
            settings::set_audio_dir,
            settings::set_audio_format,
            settings::set_paste_mode,
            settings::set_indicator_style,
            settings::get_settings_warning,
            sysinfo::detect_environment,
            recorder::start_recording,
            recorder::stop_recording,
            recorder::cancel_recording,
            recorder::recording_state,
            recorder::list_recordings,
            recorder::delete_recording,
            recorder::read_recording,
            recorder::default_recordings_dir,
            models::list_models,
            models::download_model,
            models::cancel_download,
            models::delete_model,
            models::set_default_model,
            models::get_models_dir,
            models::set_models_dir,
            models::default_models_dir,
            transcriber::transcribe_file,
            transcriber::get_transcript,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
