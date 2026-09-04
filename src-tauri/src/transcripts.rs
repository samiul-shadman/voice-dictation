use std::fs;
use std::path::{Path, PathBuf};

use crate::transcriber::TranscriptData;

pub fn sidecar_path(audio: &Path) -> PathBuf {
    let stem = audio.file_stem().map(|s| s.to_os_string()).unwrap_or_default();
    let mut name = stem;
    name.push(".transcript.json");
    audio.with_file_name(name)
}

pub fn save_sidecar(audio: &Path, transcript: &TranscriptData) -> Result<(), String> {
    let path = sidecar_path(audio);
    let data = serde_json::to_string_pretty(transcript)
        .map_err(|e| format!("could not serialize transcript: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, data).map_err(|e| format!("could not write transcript: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("could not save transcript: {e}")
    })
}

pub fn load_sidecar(audio: &Path) -> Option<TranscriptData> {
    let raw = fs::read_to_string(sidecar_path(audio)).ok()?;
    serde_json::from_str(&raw).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn sample(audio_path: &str) -> TranscriptData {
        TranscriptData {
            audio_path: audio_path.to_string(),
            text: "hello world".to_string(),
            model_id: "parakeet-v2-en".to_string(),
            duration_ms: 1234,
            created_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        }
    }

    #[test]
    fn sidecar_uses_transcript_json_suffix() {
        assert_eq!(
            sidecar_path(Path::new("/recordings/clip.mp3")),
            PathBuf::from("/recordings/clip.transcript.json")
        );
    }

    #[test]
    fn round_trip_save_load() {
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("clip.wav");
        fs::write(&audio, b"fake audio").unwrap();
        let data = sample(&audio.to_string_lossy());
        save_sidecar(&audio, &data).expect("save");
        let loaded = load_sidecar(&audio).expect("load");
        assert_eq!(loaded.audio_path, data.audio_path);
        assert_eq!(loaded.text, data.text);
        assert_eq!(loaded.model_id, data.model_id);
        assert_eq!(loaded.duration_ms, data.duration_ms);
        assert_eq!(loaded.created_at, data.created_at);
        assert!(audio.exists());
    }

    #[test]
    fn missing_sidecar_loads_none() {
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("never.wav");
        assert!(load_sidecar(&audio).is_none());
    }

    #[test]
    fn corrupt_sidecar_loads_none_without_panic() {
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("clip.wav");
        fs::write(sidecar_path(&audio), "not json {{{{").unwrap();
        assert!(load_sidecar(&audio).is_none());
        fs::write(sidecar_path(&audio), b"\xff\xfe\x00binary").unwrap();
        assert!(load_sidecar(&audio).is_none());
    }
}
