fn main() {
    println!("cargo:rustc-check-cfg=cfg(has_payload)");
    let payload = std::path::Path::new("sidecar_payload.tar.gz");
    if payload.exists() {
        println!("cargo:rustc-cfg=has_payload");
        if let Ok(abs) = payload.canonicalize() {
            println!("cargo:rustc-env=SIDECAR_PAYLOAD_PATH={}", abs.display());
        } else {
            println!("cargo:rustc-env=SIDECAR_PAYLOAD_PATH={}", payload.display());
        }
        println!("cargo:rerun-if-changed=sidecar_payload.tar.gz");
    }
    tauri_build::build()
}
