use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    let out_dir = env::var("OUT_DIR").expect("OUT_DIR not set");
    let dest = Path::new(&out_dir).join("flowcone-ebpf.bin");
    let manifest =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR not set"));
    let embedded = manifest.join("ebpf/flowcone-ebpf.bin");

    println!("cargo:rerun-if-changed={}", embedded.display());
    println!("cargo:rerun-if-env-changed=FLOWCONE_EBPF_PATH");

    // 1. External override via FLOWCONE_EBPF_PATH
    if let Ok(value) = env::var("FLOWCONE_EBPF_PATH") {
        let path = PathBuf::from(value);
        if path.is_file() {
            fs::copy(&path, &dest).expect("copy eBPF from FLOWCONE_EBPF_PATH");
            return;
        }
        println!(
            "cargo:warning=FLOWCONE_EBPF_PATH is not a file: {}",
            path.display()
        );
    }

    // 2. Prebuilt embedded binary (default for OpenWrt and release builds)
    if embedded.is_file() {
        fs::copy(&embedded, &dest).expect("copy embedded eBPF binary");
        return;
    }

    panic!(
        "flowcone-ebpf binary not found at {}! Run `cargo xtask build-ebpf` to compile it.",
        embedded.display()
    );
}
