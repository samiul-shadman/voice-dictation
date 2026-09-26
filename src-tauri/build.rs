fn main() {
    tauri_build::build();

    // sherpa-onnx is linked dynamically and the binary carries no rpath, so the
    // packaged app cannot find the shared libs. Point it at the private lib dir the
    // .deb installs them into; the AppImage's linuxdeploy pass replaces this rpath
    // with its own when it bundles the libs.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/../lib/voice-dictation");
    }
}
