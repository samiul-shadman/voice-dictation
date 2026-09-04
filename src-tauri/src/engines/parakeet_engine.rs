use std::path::Path;
use sherpa_rs::transducer::{TransducerConfig, TransducerRecognizer};

use crate::models::{self, ModelPaths};

const TAIL_PADDING_SAMPLES: usize = 4800;

pub(crate) fn ensure_tokens_have_blank(tokens_path: &Path) -> Result<(), String> {
    let raw = std::fs::read_to_string(tokens_path).map_err(|e| {
        format!("tokens.txt could not be read ({e}) — re-download the model")
    })?;
    let has_blank = raw
        .lines()
        .any(|line| line.trim().split_whitespace().next() == Some("<blk>"));
    if !has_blank {
        return Err("tokens.txt is invalid (missing <blk> token) — re-download the model".to_string());
    }
    Ok(())
}

pub(crate) fn build_config(paths: &ModelPaths, tokens_ok: bool) -> Result<TransducerConfig, String> {
    if !tokens_ok {
        return Err("tokens.txt is invalid (missing <blk> token) — re-download the model".to_string());
    }
    let mut config = TransducerConfig::default();
    config.encoder = paths.encoder.to_string_lossy().into_owned();
    config.decoder = paths.decoder.to_string_lossy().into_owned();
    config.joiner = paths.joiner.to_string_lossy().into_owned();
    config.tokens = paths.tokens.to_string_lossy().into_owned();
    config.num_threads = 2;
    // v2 commit 65215df: the default icefall decoder misreads NeMo graphs and the
    // ONNX Runtime C++ exception crosses the FFI, aborting the process — the model
    // type must stay hard-pinned to nemo_transducer.
    config.model_type = "nemo_transducer".into();
    Ok(config)
}

pub(crate) fn load_engine(paths: &ModelPaths) -> Result<TransducerRecognizer, String> {
    models::verify_model_paths(paths)?;
    ensure_tokens_have_blank(&paths.tokens)?;
    let config = build_config(paths, true)?;
    TransducerRecognizer::new(config)
        .map_err(|e| format!("could not load the Parakeet engine: {e}"))
}

fn padded_samples(samples: &[f32]) -> Vec<f32> {
    // 300 ms of zero tail padding: without it the TDT decoder drops the final
    // tokens of the last utterance (truncated-final-tokens fix, kept from v2).
    let mut padded = Vec::with_capacity(samples.len() + TAIL_PADDING_SAMPLES);
    padded.extend_from_slice(samples);
    padded.resize(samples.len() + TAIL_PADDING_SAMPLES, 0.0);
    padded
}

pub(crate) fn recognize(
    engine: &mut TransducerRecognizer,
    samples: &[f32],
    sample_rate: u32,
) -> String {
    engine.transcribe(sample_rate, &padded_samples(samples))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn test_paths() -> ModelPaths {
        ModelPaths {
            model_id: "parakeet-v2-en".to_string(),
            encoder: PathBuf::from("/models/parakeet-v2-en/encoder.int8.onnx"),
            decoder: PathBuf::from("/models/parakeet-v2-en/decoder.int8.onnx"),
            joiner: PathBuf::from("/models/parakeet-v2-en/joiner.int8.onnx"),
            tokens: PathBuf::from("/models/parakeet-v2-en/tokens.txt"),
        }
    }

    #[test]
    fn build_config_pins_nemo_transducer_and_fields() {
        let paths = test_paths();
        let config = build_config(&paths, true).expect("config");
        assert_eq!(config.model_type, "nemo_transducer");
        assert_eq!(config.encoder, paths.encoder.to_string_lossy());
        assert_eq!(config.decoder, paths.decoder.to_string_lossy());
        assert_eq!(config.joiner, paths.joiner.to_string_lossy());
        assert_eq!(config.tokens, paths.tokens.to_string_lossy());
        assert_eq!(config.num_threads, 2);
        assert_eq!(config.decoding_method, "");
        assert!(!config.debug);
        assert!(config.provider.is_none());
    }

    #[test]
    fn build_config_rejects_missing_blank_token_flag() {
        let paths = test_paths();
        let err = build_config(&paths, false).expect_err("tokens_ok=false");
        assert!(err.contains("re-download"), "got: {err}");
    }

    #[test]
    fn tokens_with_blank_are_valid() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = dir.path().join("tokens.txt");
        std::fs::write(&tokens, "<unk> 0\n▁t 1\n▁th 2\n<blk> 1024\n").unwrap();
        assert!(ensure_tokens_have_blank(&tokens).is_ok());
    }

    #[test]
    fn tokens_without_blank_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = dir.path().join("tokens.txt");
        std::fs::write(&tokens, "<unk> 0\n▁t 1\n▁th 2\n").unwrap();
        let err = ensure_tokens_have_blank(&tokens).expect_err("no <blk>");
        assert!(err.contains("re-download"), "got: {err}");
    }

    #[test]
    fn html_garbage_tokens_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let tokens = dir.path().join("tokens.txt");
        std::fs::write(
            &tokens,
            "<html>\n<head><title>404</title></head>\n<body>Not Found</body>\n</html>\n",
        )
        .unwrap();
        let err = ensure_tokens_have_blank(&tokens).expect_err("html garbage");
        assert!(err.contains("re-download"), "got: {err}");
    }

    #[test]
    fn missing_tokens_file_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let err = ensure_tokens_have_blank(&dir.path().join("tokens.txt")).expect_err("missing");
        assert!(err.contains("re-download"), "got: {err}");
    }

    #[test]
    fn recognize_pads_samples_with_4800_zero_tail() {
        let samples = vec![1.0, 2.0, 3.0];
        let padded = padded_samples(&samples);
        assert_eq!(padded.len(), samples.len() + 4800);
        assert_eq!(&padded[..3], &[1.0, 2.0, 3.0]);
        assert!(padded[3..].iter().all(|s| *s == 0.0));
    }
}
