use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

pub const DECODER_FILE: &str = "decoder.int8.onnx";
const PATCHED_MANIFEST: &str = "patched.json";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub languages: Vec<String>,
    pub description: String,
    pub total_size_bytes: u64,
    pub downloaded: bool,
    pub downloading: bool,
    pub cancelling: bool,
    pub download_error: Option<String>,
    pub is_default: bool,
}

#[derive(Debug)]
pub struct ModelPaths {
    pub model_id: String,
    pub encoder: PathBuf,
    pub decoder: PathBuf,
    pub joiner: PathBuf,
    pub tokens: PathBuf,
}

#[derive(Debug, PartialEq)]
pub(crate) struct ModelFile {
    pub(crate) name: &'static str,
    pub(crate) size_bytes: u64,
}

#[derive(Debug, PartialEq)]
pub(crate) struct ModelSpec {
    pub(crate) id: &'static str,
    pub(crate) name: &'static str,
    pub(crate) languages: &'static [&'static str],
    pub(crate) description: &'static str,
    pub(crate) repo: &'static str,
    pub(crate) files: [ModelFile; 4],
}

/// Pinned upstream file sizes, verified 2026-09-04 against
/// `curl -s https://huggingface.co/api/models/<repo>/tree/main`.
/// Re-verify (and update) whenever sherpa-onnx is upgraded or the upstream
/// repos change — hardcoded sizes drift (doc 08, pitfall 1).
pub(crate) static CATALOG: [ModelSpec; 2] = [
    ModelSpec {
        id: "parakeet-v2-en",
        name: "Parakeet TDT 0.6B v2 (English)",
        languages: &["en"],
        description: "Fast, accurate English transcription (NVIDIA Parakeet TDT 0.6B v2, int8 ONNX).",
        repo: "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
        files: [
            ModelFile { name: "encoder.int8.onnx", size_bytes: 652_184_296 },
            ModelFile { name: "decoder.int8.onnx", size_bytes: 7_257_753 },
            ModelFile { name: "joiner.int8.onnx", size_bytes: 1_739_080 },
            ModelFile { name: "tokens.txt", size_bytes: 9_384 },
        ],
    },
    ModelSpec {
        id: "parakeet-v3-multilingual",
        name: "Parakeet TDT 0.6B v3 (Multilingual)",
        languages: &[
            "bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hu", "it", "lv",
            "lt", "mt", "pl", "pt", "ro", "sk", "sl", "es", "sv", "ru", "uk",
        ],
        description: "25 European languages (NVIDIA Parakeet TDT 0.6B v3, int8 ONNX).",
        repo: "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
        files: [
            ModelFile { name: "encoder.int8.onnx", size_bytes: 652_184_281 },
            ModelFile { name: "decoder.int8.onnx", size_bytes: 11_845_275 },
            ModelFile { name: "joiner.int8.onnx", size_bytes: 6_355_277 },
            ModelFile { name: "tokens.txt", size_bytes: 93_939 },
        ],
    },
];

/// Auto-selection preference order: v2 (en) first, then v3 (doc 08).
pub(crate) const PREFERENCE_ORDER: [&str; 2] = ["parakeet-v2-en", "parakeet-v3-multilingual"];

pub(crate) fn find_spec(id: &str) -> Option<&'static ModelSpec> {
    CATALOG.iter().find(|spec| spec.id == id)
}

pub(crate) fn file_url(spec: &ModelSpec, file: &ModelFile) -> String {
    format!("https://huggingface.co/{}/resolve/main/{}", spec.repo, file.name)
}

pub fn resolve_models_dir(app: &tauri::AppHandle) -> PathBuf {
    let configured = crate::settings::with_settings(app, |s| s.models_dir.clone());
    match configured {
        Some(dir) => PathBuf::from(dir),
        None => default_models_dir_path(app),
    }
}

fn default_models_dir_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("models"))
        .unwrap_or_else(|_| PathBuf::from("models"))
}

fn patched_manifest_path(dir: &Path) -> PathBuf {
    dir.join(PATCHED_MANIFEST)
}

pub(crate) fn load_patched_manifest(dir: &Path) -> Option<BTreeMap<String, u64>> {
    let raw = fs::read_to_string(patched_manifest_path(dir)).ok()?;
    serde_json::from_str(&raw).ok()
}

pub(crate) fn remove_patched_manifest(dir: &Path) {
    let _ = fs::remove_file(patched_manifest_path(dir));
}

fn write_manifest_entry(dir: &Path, file_name: &str, size: u64) -> Result<(), String> {
    let path = patched_manifest_path(dir);
    let mut map: BTreeMap<String, u64> = load_patched_manifest(dir).unwrap_or_default();
    map.insert(file_name.to_string(), size);
    let data = serde_json::to_string_pretty(&map)
        .map_err(|e| format!("could not serialize the patch manifest: {e}"))?;
    let tmp = dir.join(format!("{PATCHED_MANIFEST}.tmp"));
    fs::write(&tmp, data).map_err(|e| format!("could not write the patch manifest: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("could not save the patch manifest: {e}")
    })
}

fn read_varint(bytes: &[u8], pos: &mut usize) -> Result<u64, String> {
    let mut value: u64 = 0;
    let mut shift = 0u32;
    loop {
        let Some(&byte) = bytes.get(*pos) else {
            return Err("malformed ONNX protobuf (unexpected end of file)".to_string());
        };
        *pos += 1;
        value |= ((byte & 0x7f) as u64) << shift;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
        shift += 7;
        if shift > 63 {
            return Err("malformed ONNX protobuf (varint too long)".to_string());
        }
    }
}

fn push_varint(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

fn take_length_delimited(bytes: &[u8], pos: &mut usize) -> Result<usize, String> {
    let len = read_varint(bytes, pos)? as usize;
    let end = pos
        .checked_add(len)
        .ok_or_else(|| "malformed ONNX protobuf (length overflow)".to_string())?;
    if end > bytes.len() {
        return Err("malformed ONNX protobuf (field extends past end of file)".to_string());
    }
    Ok(end)
}

fn skip_protobuf_field(bytes: &[u8], pos: &mut usize, wire_type: u64) -> Result<(), String> {
    match wire_type {
        0 => {
            read_varint(bytes, pos)?;
        }
        1 => {
            let end = pos
                .checked_add(8)
                .ok_or_else(|| "malformed ONNX protobuf".to_string())?;
            if end > bytes.len() {
                return Err("malformed ONNX protobuf (unexpected end of file)".to_string());
            }
            *pos = end;
        }
        2 => {
            let end = take_length_delimited(bytes, pos)?;
            *pos = end;
        }
        5 => {
            let end = pos
                .checked_add(4)
                .ok_or_else(|| "malformed ONNX protobuf".to_string())?;
            if end > bytes.len() {
                return Err("malformed ONNX protobuf (unexpected end of file)".to_string());
            }
            *pos = end;
        }
        _ => {
            return Err(format!(
                "malformed ONNX protobuf (unsupported wire type {wire_type})"
            ))
        }
    }
    Ok(())
}

fn parse_metadata_entry(bytes: &[u8]) -> Option<(String, String)> {
    let mut pos = 0usize;
    let mut key = None;
    let mut value = None;
    while pos < bytes.len() {
        let tag = read_varint(bytes, &mut pos).ok()?;
        let field = tag >> 3;
        let wire = tag & 0x7;
        match (field, wire) {
            (1, 2) => {
                let end = take_length_delimited(bytes, &mut pos).ok()?;
                key = Some(String::from_utf8_lossy(&bytes[pos..end]).into_owned());
                pos = end;
            }
            (2, 2) => {
                let end = take_length_delimited(bytes, &mut pos).ok()?;
                value = Some(String::from_utf8_lossy(&bytes[pos..end]).into_owned());
                pos = end;
            }
            (_, 2) => {
                let end = take_length_delimited(bytes, &mut pos).ok()?;
                pos = end;
            }
            (_, 0) => {
                read_varint(bytes, &mut pos).ok()?;
            }
            _ => return None,
        }
    }
    Some((key?, value.unwrap_or_default()))
}

fn scan_model_metadata(bytes: &[u8]) -> Result<Vec<(String, String)>, String> {
    let mut pos = 0usize;
    let mut entries = Vec::new();
    while pos < bytes.len() {
        let tag = read_varint(bytes, &mut pos)?;
        let field = tag >> 3;
        let wire = tag & 0x7;
        if field == 0 {
            return Err("malformed ONNX protobuf (field number 0)".to_string());
        }
        if field == 14 && wire == 2 {
            let end = take_length_delimited(bytes, &mut pos)?;
            if let Some(entry) = parse_metadata_entry(&bytes[pos..end]) {
                entries.push(entry);
            }
            pos = end;
        } else {
            skip_protobuf_field(bytes, &mut pos, wire)?;
        }
    }
    Ok(entries)
}

fn build_metadata_field(key: &str, value: &str) -> Vec<u8> {
    let mut entry = Vec::with_capacity(key.len() + value.len() + 8);
    entry.push(0x0A);
    push_varint(&mut entry, key.len() as u64);
    entry.extend_from_slice(key.as_bytes());
    entry.push(0x12);
    push_varint(&mut entry, value.len() as u64);
    entry.extend_from_slice(value.as_bytes());
    let mut out = Vec::with_capacity(entry.len() + 5);
    out.push(0x72);
    push_varint(&mut out, entry.len() as u64);
    out.extend_from_slice(&entry);
    out
}

/// Appends `vocab_size` (non-empty line count of tokens.txt) and `context_size`
/// (= 2) metadata records to the decoder ONNX file — sherpa-onnx ≥ 1.11 requires
/// them, HF-hosted decoders lack them (doc 08). Returns the new file size.
pub(crate) fn patch_parakeet_decoder(decoder_path: &Path) -> Result<u64, String> {
    let dir = decoder_path
        .parent()
        .ok_or_else(|| "decoder path has no parent directory".to_string())?;
    let file_name = decoder_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| "decoder path has no file name".to_string())?;
    let tokens_raw = fs::read_to_string(dir.join("tokens.txt"))
        .map_err(|e| format!("tokens.txt could not be read ({e}) — re-download the model"))?;
    let vocab_size = tokens_raw.lines().filter(|l| !l.trim().is_empty()).count();
    let bytes = fs::read(decoder_path)
        .map_err(|e| format!("{file_name} could not be read ({e}) — re-download the model"))?;
    let entries = scan_model_metadata(&bytes)?;
    if entries.iter().any(|(k, _)| k == "vocab_size") {
        write_manifest_entry(dir, &file_name, bytes.len() as u64)?;
        return Ok(bytes.len() as u64);
    }
    let mut patched = bytes.clone();
    patched.extend_from_slice(&build_metadata_field("vocab_size", &vocab_size.to_string()));
    if !entries.iter().any(|(k, _)| k == "context_size") {
        patched.extend_from_slice(&build_metadata_field("context_size", "2"));
    }
    let tmp = dir.join(format!("{file_name}.patching"));
    fs::write(&tmp, &patched).map_err(|e| format!("could not write the patched decoder: {e}"))?;
    fs::rename(&tmp, decoder_path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("could not save the patched decoder: {e}")
    })?;
    write_manifest_entry(dir, &file_name, patched.len() as u64)?;
    Ok(patched.len() as u64)
}

fn size_accepted(actual: u64, file: &ModelFile, manifest: &Option<BTreeMap<String, u64>>) -> bool {
    match manifest.as_ref().and_then(|m| m.get(file.name)) {
        Some(patched) => actual == *patched,
        None => actual == file.size_bytes,
    }
}

fn check_file(
    dir: &Path,
    file: &ModelFile,
    manifest: &Option<BTreeMap<String, u64>>,
) -> Result<PathBuf, String> {
    let path = dir.join(file.name);
    let actual = fs::metadata(&path)
        .map(|m| m.len())
        .map_err(|_| format!("{} is missing — re-download the model", file.name))?;
    if !size_accepted(actual, file, manifest) {
        return Err(format!(
            "{} has an unexpected size (expected {} bytes, found {actual}) — re-download the model",
            file.name, file.size_bytes
        ));
    }
    Ok(path)
}

pub(crate) fn verify_dir_with(dir: &Path, spec: &ModelSpec) -> Result<ModelPaths, String> {
    let manifest = load_patched_manifest(dir);
    let file_by_name = |name: &str| -> Result<&ModelFile, String> {
        spec.files
            .iter()
            .find(|f| f.name == name)
            .ok_or_else(|| format!("catalog entry {name} is malformed for model {}", spec.id))
    };
    Ok(ModelPaths {
        model_id: spec.id.to_string(),
        encoder: check_file(dir, file_by_name("encoder.int8.onnx")?, &manifest)?,
        decoder: check_file(dir, file_by_name(DECODER_FILE)?, &manifest)?,
        joiner: check_file(dir, file_by_name("joiner.int8.onnx")?, &manifest)?,
        tokens: check_file(dir, file_by_name("tokens.txt")?, &manifest)?,
    })
}

pub(crate) fn verify_model_paths(paths: &ModelPaths) -> Result<(), String> {
    let dir = paths
        .encoder
        .parent()
        .ok_or_else(|| "model path has no parent directory".to_string())?;
    let spec = find_spec(&paths.model_id)
        .ok_or_else(|| format!("unknown model id: {}", paths.model_id))?;
    let manifest = load_patched_manifest(dir);
    verify_model_paths_with(paths, spec, &manifest)
}

fn verify_model_paths_with(
    paths: &ModelPaths,
    spec: &ModelSpec,
    manifest: &Option<BTreeMap<String, u64>>,
) -> Result<(), String> {
    for (name, path) in [
        ("encoder.int8.onnx", &paths.encoder),
        (DECODER_FILE, &paths.decoder),
        ("joiner.int8.onnx", &paths.joiner),
        ("tokens.txt", &paths.tokens),
    ] {
        let file = spec
            .files
            .iter()
            .find(|f| f.name == name)
            .ok_or_else(|| format!("catalog entry {name} is malformed for model {}", spec.id))?;
        let actual = fs::metadata(path)
            .map(|m| m.len())
            .map_err(|_| format!("{name} is missing — re-download the model"))?;
        if !size_accepted(actual, file, manifest) {
            return Err(format!(
                "{name} has an unexpected size (expected {} bytes, found {actual}) — re-download the model",
                file.size_bytes
            ));
        }
    }
    Ok(())
}

pub(crate) fn is_model_dir_ready(dir: &Path, spec: &ModelSpec) -> bool {
    verify_dir_with(dir, spec).is_ok()
}

pub(crate) fn is_downloaded(models_dir: &Path, id: &str) -> bool {
    match find_spec(id) {
        Some(spec) => is_model_dir_ready(&models_dir.join(id), spec),
        None => false,
    }
}

pub fn ensure_model_ready(app: &tauri::AppHandle, id: &str) -> Result<ModelPaths, String> {
    let spec =
        find_spec(id).ok_or_else(|| format!("unknown model id: {id}"))?;
    verify_dir_with(&resolve_models_dir(app).join(id), spec)
}

#[tauri::command]
pub fn list_models(app: tauri::AppHandle) -> Vec<ModelInfo> {
    crate::downloader::gc_finished();
    let models_dir = resolve_models_dir(&app);
    let default_id = crate::settings::with_settings(&app, |s| s.default_model.clone());
    CATALOG.iter()
        .map(|spec| ModelInfo {
            id: spec.id.to_string(),
            name: spec.name.to_string(),
            languages: spec.languages.iter().map(|l| l.to_string()).collect(),
            description: spec.description.to_string(),
            total_size_bytes: spec.files.iter().map(|f| f.size_bytes).sum(),
            downloaded: is_downloaded(&models_dir, spec.id),
            downloading: crate::downloader::is_downloading(spec.id),
            cancelling: crate::downloader::is_cancelling(spec.id),
            download_error: crate::downloader::error_of(spec.id),
            is_default: default_id == spec.id,
        })
        .collect()
}

#[tauri::command]
pub fn download_model(app: tauri::AppHandle, id: String) -> Result<(), String> {
    crate::downloader::start_download(app, &id)
}

#[tauri::command]
pub fn cancel_download(_app: tauri::AppHandle, id: String) -> Result<(), String> {
    crate::downloader::request_cancel(&id)
}

#[tauri::command]
pub fn delete_model(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let spec = find_spec(&id).ok_or_else(|| format!("unknown model id: {id}"))?;
    if crate::downloader::is_downloading(spec.id) {
        return Err("model is downloading — cancel the download before deleting".to_string());
    }
    let is_default = crate::settings::with_settings(&app, |s| s.default_model == spec.id);
    if is_default {
        return Err("model is the default — choose another default before deleting".to_string());
    }
    let dir = resolve_models_dir(&app).join(spec.id);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("could not delete the model: {e}"))?;
    }
    crate::transcriber::evict_engine_cache(&id);
    Ok(())
}

#[tauri::command]
pub fn set_default_model(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let spec = find_spec(&id).ok_or_else(|| format!("unknown model id: {id}"))?;
    crate::settings::update_settings(&app, move |s| {
        s.default_model = spec.id.to_string();
        Ok(())
    })
}

#[tauri::command]
pub fn get_models_dir(app: tauri::AppHandle) -> String {
    resolve_models_dir(&app).to_string_lossy().to_string()
}

#[tauri::command]
pub fn set_models_dir(app: tauri::AppHandle, dir: Option<String>) -> Result<(), String> {
    if crate::downloader::any_active() {
        return Err(
            "cannot change the models directory while a download is in progress".to_string(),
        );
    }
    let value = match dir.as_deref() {
        None | Some("") => None,
        Some(dir) => {
            let path = PathBuf::from(dir);
            if !path.is_absolute() {
                return Err("models dir must be an absolute path".to_string());
            }
            fs::create_dir_all(&path).map_err(|e| format!("could not create models dir: {e}"))?;
            let probe = path.join(".write_test");
            fs::write(&probe, b"").map_err(|e| format!("models dir is not writable: {e}"))?;
            fs::remove_file(&probe)
                .map_err(|e| format!("could not remove write probe in models dir: {e}"))?;
            Some(dir.to_string())
        }
    };
    crate::settings::update_settings(&app, move |s| {
        s.models_dir = value;
        Ok(())
    })?;
    crate::transcriber::evict_all_engines();
    Ok(())
}

#[tauri::command]
pub fn default_models_dir(app: tauri::AppHandle) -> String {
    default_models_dir_path(&app).to_string_lossy().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_spec() -> ModelSpec {
        ModelSpec {
            id: "test-model",
            name: "Test Model",
            languages: &["en"],
            description: "test",
            repo: "example/test",
            files: [
                ModelFile { name: "encoder.int8.onnx", size_bytes: 10 },
                ModelFile { name: "decoder.int8.onnx", size_bytes: 8 },
                ModelFile { name: "joiner.int8.onnx", size_bytes: 6 },
                ModelFile { name: "tokens.txt", size_bytes: 4 },
            ],
        }
    }

    fn write_model_files(dir: &Path, spec: &ModelSpec, sizes: [u64; 4]) {
        fs::create_dir_all(dir).unwrap();
        for (file, size) in spec.files.iter().zip(sizes) {
            fs::write(dir.join(file.name), vec![0u8; size as usize]).unwrap();
        }
    }

    fn mini_onnx() -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.push(0x08);
        bytes.push(0x01);
        bytes.push(0x12);
        bytes.push(3);
        bytes.extend_from_slice(b"abc");
        bytes.push(0x3A);
        bytes.push(0x00);
        bytes
    }

    #[test]
    fn verify_dir_accepts_exact_sizes() {
        let dir = tempfile::tempdir().unwrap();
        let spec = test_spec();
        write_model_files(dir.path(), &spec, [10, 8, 6, 4]);
        let paths = verify_dir_with(dir.path(), &spec).expect("integrity should pass");
        assert_eq!(paths.encoder, dir.path().join("encoder.int8.onnx"));
        assert_eq!(paths.model_id, "test-model");
    }

    #[test]
    fn verify_dir_rejects_wrong_sizes_and_missing_files() {
        let dir = tempfile::tempdir().unwrap();
        let spec = test_spec();
        write_model_files(dir.path(), &spec, [9, 8, 6, 4]);
        let err = verify_dir_with(dir.path(), &spec).expect_err("size mismatch");
        assert!(err.contains("re-download"), "got: {err}");
        assert!(err.contains("encoder.int8.onnx"));
        let dir2 = tempfile::tempdir().unwrap();
        let err = verify_dir_with(dir2.path(), &spec).expect_err("missing files");
        assert!(err.contains("re-download"), "got: {err}");
    }

    #[test]
    fn verify_dir_honors_patched_manifest_for_decoder() {
        let dir = tempfile::tempdir().unwrap();
        let spec = test_spec();
        write_model_files(dir.path(), &spec, [10, 8 + 5000, 6, 4]);
        let patched_size = 8 + 5000;
        let mut manifest = BTreeMap::new();
        manifest.insert(DECODER_FILE.to_string(), patched_size);
        let data = serde_json::to_string(&manifest).unwrap();
        fs::write(dir.path().join(PATCHED_MANIFEST), data).unwrap();
        assert!(verify_dir_with(dir.path(), &spec).is_ok());
        fs::write(dir.path().join(DECODER_FILE), vec![0u8; patched_size + 1]).unwrap();
        let err = verify_dir_with(dir.path(), &spec).expect_err("manifest size mismatch");
        assert!(err.contains("re-download"), "got: {err}");
    }

    #[test]
    fn verify_dir_requires_exact_decoder_size_without_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let spec = test_spec();
        write_model_files(dir.path(), &spec, [10, 8 + 30, 6, 4]);
        let err = verify_dir_with(dir.path(), &spec)
            .expect_err("without a manifest only the exact pinned size is accepted");
        assert!(err.contains("re-download"), "got: {err}");
    }

    #[test]
    fn verify_dir_rejects_wrong_encoder_size() {
        let dir = tempfile::tempdir().unwrap();
        let spec = test_spec();
        write_model_files(dir.path(), &spec, [10 + 30, 8, 6, 4]);
        let err = verify_dir_with(dir.path(), &spec).expect_err("encoder size mismatch");
        assert!(err.contains("re-download"), "got: {err}");
    }

    #[test]
    fn patch_appends_metadata_and_writes_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let original = mini_onnx();
        fs::write(dir.path().join(DECODER_FILE), &original).unwrap();
        fs::write(dir.path().join("tokens.txt"), "a 0\nb 1\n<blk> 2\n").unwrap();
        let new_size = patch_parakeet_decoder(&dir.path().join(DECODER_FILE)).unwrap();
        assert_eq!(new_size as usize, original.len() + 17 + 19);
        let patched = fs::read(dir.path().join(DECODER_FILE)).unwrap();
        assert_eq!(patched.len(), new_size as usize);
        assert_eq!(&patched[..original.len()], &original[..]);
        let entries = scan_model_metadata(&patched).unwrap();
        assert!(entries.contains(&("vocab_size".to_string(), "3".to_string())));
        assert!(entries.contains(&("context_size".to_string(), "2".to_string())));
        let manifest: BTreeMap<String, u64> = serde_json::from_str(
            &fs::read_to_string(dir.path().join(PATCHED_MANIFEST)).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest.get(DECODER_FILE), Some(&(new_size)));
    }

    #[test]
    fn patch_twice_is_noop() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(DECODER_FILE), mini_onnx()).unwrap();
        fs::write(dir.path().join("tokens.txt"), "a 0\n<blk> 1\n").unwrap();
        let first = patch_parakeet_decoder(&dir.path().join(DECODER_FILE)).unwrap();
        let after_first = fs::read(dir.path().join(DECODER_FILE)).unwrap();
        let second = patch_parakeet_decoder(&dir.path().join(DECODER_FILE)).unwrap();
        assert_eq!(first, second);
        let after_second = fs::read(dir.path().join(DECODER_FILE)).unwrap();
        assert_eq!(after_first, after_second);
    }

    #[test]
    fn patch_keeps_existing_metadata_entries() {
        let dir = tempfile::tempdir().unwrap();
        let mut bytes = mini_onnx();
        bytes.extend_from_slice(&build_metadata_field("existing_key", "7"));
        fs::write(dir.path().join(DECODER_FILE), &bytes).unwrap();
        fs::write(dir.path().join("tokens.txt"), "a 0\n<blk> 1\n").unwrap();
        patch_parakeet_decoder(&dir.path().join(DECODER_FILE)).unwrap();
        let entries = scan_model_metadata(&fs::read(dir.path().join(DECODER_FILE)).unwrap()).unwrap();
        assert!(entries.contains(&("existing_key".to_string(), "7".to_string())));
        assert!(entries.contains(&("vocab_size".to_string(), "2".to_string())));
        assert!(entries.contains(&("context_size".to_string(), "2".to_string())));
    }

    #[test]
    fn patch_rejects_malformed_protobuf() {
        let dir = tempfile::tempdir().unwrap();
        let mut bytes = mini_onnx();
        bytes.push(0xFF);
        fs::write(dir.path().join(DECODER_FILE), bytes).unwrap();
        fs::write(dir.path().join("tokens.txt"), "a 0\n").unwrap();
        assert!(patch_parakeet_decoder(&dir.path().join(DECODER_FILE)).is_err());
    }

    #[test]
    fn patch_requires_tokens_file() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(DECODER_FILE), mini_onnx()).unwrap();
        let err =
            patch_parakeet_decoder(&dir.path().join(DECODER_FILE)).expect_err("no tokens.txt");
        assert!(err.contains("re-download"), "got: {err}");
    }

    #[test]
    fn verify_model_paths_reverifies_engine_files() {
        let dir = tempfile::tempdir().unwrap();
        let spec = test_spec();
        write_model_files(dir.path(), &spec, [10, 8, 6, 4]);
        let paths = verify_dir_with(dir.path(), &spec).expect("integrity should pass");
        let manifest = None;
        assert!(verify_model_paths_with(&paths, &spec, &manifest).is_ok());
        fs::write(dir.path().join("encoder.int8.onnx"), vec![0u8; 7]).unwrap();
        let err =
            verify_model_paths_with(&paths, &spec, &manifest).expect_err("truncated");
        assert!(err.contains("re-download"), "got: {err}");
    }

    #[test]
    #[ignore = "manual check: set PARAKEET_REAL_DECODER (and optionally PARAKEET_REAL_TOKENS) to real HF files"]
    fn patch_real_decoder_when_env_set() {
        let Some(decoder) = std::env::var_os("PARAKEET_REAL_DECODER") else {
            return;
        };
        let decoder = PathBuf::from(decoder);
        let dir = decoder.parent().unwrap().to_path_buf();
        if let Some(tokens_src) = std::env::var_os("PARAKEET_REAL_TOKENS") {
            fs::copy(&tokens_src, dir.join("tokens.txt")).unwrap();
        }
        let already_patched = scan_model_metadata(&fs::read(&decoder).unwrap())
            .expect("parse real decoder")
            .iter()
            .any(|(k, _)| k == "vocab_size");
        let before = fs::metadata(&decoder).unwrap().len();
        let after = patch_parakeet_decoder(&decoder).unwrap();
        if already_patched {
            assert_eq!(after, before);
        } else {
            let tokens = fs::read_to_string(dir.join("tokens.txt")).unwrap();
            let vocab = tokens.lines().filter(|l| !l.trim().is_empty()).count();
            let expected_delta = (build_metadata_field("vocab_size", &vocab.to_string()).len()
                + build_metadata_field("context_size", "2").len())
                as u64;
            assert_eq!(after, before + expected_delta);
        }
        let entries = scan_model_metadata(&fs::read(&decoder).unwrap()).unwrap();
        let tokens = fs::read_to_string(dir.join("tokens.txt")).unwrap();
        let vocab = tokens.lines().filter(|l| !l.trim().is_empty()).count();
        assert!(entries.contains(&("vocab_size".to_string(), vocab.to_string())));
        assert!(entries.contains(&("context_size".to_string(), "2".to_string())));
        let manifest = load_patched_manifest(&dir).unwrap();
        let name = decoder.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(manifest.get(&name), Some(&(after)));
    }

    #[test]
    fn catalog_urls_and_preference_order() {
        assert_eq!(PREFERENCE_ORDER, ["parakeet-v2-en", "parakeet-v3-multilingual"]);
        for spec in &CATALOG {
            assert_eq!(find_spec(spec.id), Some(spec));
            for file in &spec.files {
                assert_eq!(
                    file_url(spec, file),
                    format!("https://huggingface.co/{}/resolve/main/{}", spec.repo, file.name)
                );
            }
            assert_eq!(spec.files.len(), 4);
        }
        assert_eq!(
            CATALOG[0].files.iter().map(|f| f.size_bytes).sum::<u64>(),
            652_184_296 + 7_257_753 + 1_739_080 + 9_384
        );
        assert_eq!(
            CATALOG[1].files.iter().map(|f| f.size_bytes).sum::<u64>(),
            652_184_281 + 11_845_275 + 6_355_277 + 93_939
        );
    }
}
