use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    let out_dir = env::var("OUT_DIR").expect("OUT_DIR not set");
    let dest = Path::new(&out_dir).join("flowcone-ebpf.bin");
    let manifest =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR not set"));
    let ebpf_dir = manifest.join("../flowcone-ebpf");
    let embedded = manifest.join("ebpf/flowcone-ebpf.bin");

    for path in [
        ebpf_dir.join("src"),
        manifest.join("../flowcone-common/src"),
        ebpf_dir.join("Cargo.toml"),
        manifest.join("../flowcone-common/Cargo.toml"),
        ebpf_dir.join(".cargo/config.toml"),
    ] {
        println!("cargo:rerun-if-changed={}", path.display());
    }

    if let Ok(path) = env::var("FLOWCONE_EBPF_PATH") {
        let path = PathBuf::from(path);
        if path.is_file() {
            fs::copy(&path, &dest).expect("copy eBPF from FLOWCONE_EBPF_PATH");
            return;
        }
    }

    if embedded.is_file() {
        fs::copy(&embedded, &dest).expect("copy embedded eBPF binary");
        return;
    }

    let mut cmd = Command::new("cargo");
    cmd.args([
        "+nightly",
        "build",
        "--release",
        "--target=bpfel-unknown-none",
        "-Z",
        "build-std=core",
    ])
    .current_dir(&ebpf_dir)
    .env_remove("RUSTFLAGS")
    .env_remove("CARGO_ENCODED_RUSTFLAGS")
    .env_remove("RUSTC")
    .env_remove("CARGO_BUILD_TARGET");
    assert!(
        cmd.status().map(|s| s.success()).unwrap_or(false),
        "failed to build flowcone-ebpf"
    );

    let built = ebpf_dir.join("target/bpfel-unknown-none/release/flowcone-ebpf");
    fs::copy(&built, &dest).expect("copy built eBPF binary");
}
