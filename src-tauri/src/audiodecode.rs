use std::path::Path;

use symphonia::core::audio::sample::Sample;
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::units::TimeBase;

pub(crate) const TARGET_SAMPLE_RATE: u32 = 16_000;

pub(crate) fn mixdown_interleaved_to_mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

pub(crate) fn rms_level(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_squares: f64 = samples.iter().map(|s| f64::from(*s) * f64::from(*s)).sum();
    let rms = (sum_squares / samples.len() as f64).sqrt();
    if rms <= f64::EPSILON {
        return f64::NEG_INFINITY as f32;
    }
    (20.0 * rms.log10()) as f32
}

pub(crate) fn dbfs_to_level(db: f64) -> f32 {
    if db.is_nan() || db <= -60.0 {
        return 0.0;
    }
    if db >= 0.0 {
        return 1.0;
    }
    ((db + 60.0) / 60.0) as f32
}

pub(crate) fn probe_duration_secs(path: &Path) -> Option<f64> {
    let src = std::fs::File::open(path).ok()?;
    let mss = MediaSourceStream::new(Box::new(src), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let format = symphonia::default::get_probe()
        .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
        .ok()?;
    let track = format.default_track(TrackType::Audio)?;
    let time_base: TimeBase = track.time_base?;
    time_base
        .calc_duration(track.duration?)
        .map(|t| t.as_secs_f64())
        .filter(|d| d.is_finite() && *d >= 0.0)
}

pub(crate) fn decode_pcm16k_mono(input: &Path) -> Result<(Vec<f32>, u64), String> {
    let (interleaved, channels, rate) = decode_interleaved(input)?;
    let mono = mixdown_interleaved_to_mono(&interleaved, channels);
    let mono = resample_to_16k(mono, rate)?;
    let duration_ms = mono.len() as u64 * 1000 / u64::from(TARGET_SAMPLE_RATE);
    Ok((mono, duration_ms))
}

fn decode_interleaved(input: &Path) -> Result<(Vec<f32>, usize, u32), String> {
    let src =
        std::fs::File::open(input).map_err(|e| format!("could not open {}: {e}", input.display()))?;
    let mss = MediaSourceStream::new(Box::new(src), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = input.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let mut format = symphonia::default::get_probe()
        .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
        .map_err(|e| unsupported_or_error(input, e))?;
    let track = format
        .default_track(TrackType::Audio)
        .ok_or_else(|| format!("{} contains no audio track", input.display()))?;
    let audio_params = track
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .ok_or_else(|| format!("{} has no decodable audio codec", input.display()))?;
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(audio_params, &AudioDecoderOptions::default())
        .map_err(|e| format!("could not decode {}: {e}", input.display()))?;
    let track_id = track.id;
    let mut interleaved: Vec<f32> = Vec::new();
    let mut channels = 1usize;
    let mut rate = TARGET_SAMPLE_RATE;
    loop {
        let packet = match format.next_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => break,
            Err(SymphoniaError::ResetRequired) => break,
            Err(e) => return Err(format!("could not read {}: {e}", input.display())),
        };
        if packet.track_id != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(buf) => {
                let spec = buf.spec();
                rate = spec.rate();
                channels = spec.channels().count().max(1);
                let n = buf.samples_interleaved();
                interleaved.resize(interleaved.len() + n, f32::MID);
                let start = interleaved.len() - n;
                buf.copy_to_slice_interleaved(&mut interleaved[start..]);
            }
            Err(SymphoniaError::DecodeError(_)) | Err(SymphoniaError::IoError(_)) => continue,
            Err(e) => return Err(format!("could not decode {}: {e}", input.display())),
        }
    }
    if interleaved.is_empty() {
        return Err(format!("{} contains no audio samples", input.display()));
    }
    Ok((interleaved, channels, rate))
}

fn resample_to_16k(mono: Vec<f32>, rate: u32) -> Result<Vec<f32>, String> {
    if rate == TARGET_SAMPLE_RATE {
        return Ok(mono);
    }
    if rate == 0 {
        return Err("audio has an invalid sample rate".to_string());
    }
    use audioadapter_buffers::direct::InterleavedSlice;
    use rubato::{FixedSync, Fft, Resampler};
    let mut resampler = Fft::<f32>::new(
        rate as usize,
        TARGET_SAMPLE_RATE as usize,
        1024,
        1,
        FixedSync::Both,
    )
    .map_err(|e| format!("could not resample {rate} Hz audio: {e}"))?;
    let input = InterleavedSlice::new(&mono, 1, mono.len())
        .map_err(|e| format!("could not prepare audio for resampling: {e}"))?;
    let resampled = resampler
        .process_all(&input, mono.len(), None)
        .map_err(|e| format!("could not resample {rate} Hz audio: {e}"))?;
    Ok(resampled.take_data())
}

fn unsupported_or_error(input: &Path, e: SymphoniaError) -> String {
    if matches!(e, SymphoniaError::Unsupported(_)) {
        format!(
            "{} is not a supported audio format — try mp3, wav, flac, ogg or m4a",
            input.display()
        )
    } else {
        format!("could not read {}: {e}", input.display())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mono_mixdown_passes_single_channel_through() {
        let samples = vec![0.5, -0.5, 1.0];
        assert_eq!(mixdown_interleaved_to_mono(&samples, 1), samples);
    }

    #[test]
    fn stereo_mixdown_averages_each_frame() {
        assert_eq!(
            mixdown_interleaved_to_mono(&[0.0, 1.0, -1.0, 1.0], 2),
            vec![0.5, 0.0]
        );
    }

    #[test]
    fn rms_level_is_silent_for_empty_and_zero_input() {
        assert_eq!(rms_level(&[]), 0.0);
        assert_eq!(rms_level(&[0.0, 0.0]), f32::NEG_INFINITY);
    }

    #[test]
    fn rms_level_matches_expected_dbfs() {
        let square_half: Vec<f32> = vec![0.5, -0.5];
        let level = rms_level(&square_half);
        assert!((f64::from(level) - -6.02).abs() < 0.05, "got {level}");
    }

    #[test]
    fn dbfs_to_level_clamps_to_unit_range() {
        assert_eq!(dbfs_to_level(f64::NEG_INFINITY), 0.0);
        assert_eq!(dbfs_to_level(-60.0), 0.0);
        assert_eq!(dbfs_to_level(-30.0), 0.5);
        assert_eq!(dbfs_to_level(0.0), 1.0);
        assert_eq!(dbfs_to_level(10.0), 1.0);
        assert_eq!(dbfs_to_level(f64::NAN), 0.0);
    }

    #[test]
    fn probe_duration_rejects_missing_files() {
        assert!(probe_duration_secs(Path::new("/nonexistent/audio.mp3")).is_none());
    }
}
