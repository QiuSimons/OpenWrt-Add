use aya::{Btf, Endianness};
use std::fs;
use std::path::Path;

const DETACHED_BTF_CANDIDATES: &[&str] = &[
    "/sys/kernel/btf/vmlinux",
    "/usr/lib/debug/boot/vmlinux",
    "/boot/vmlinux",
    "/lib/modules/vmlinux",
];

/// Eagerly parses a user-supplied `--btf` file, returning an explicit error on failure.
pub(crate) fn load_custom_btf(custom_path: Option<&str>) -> Result<Option<Btf>, String> {
    let Some(p) = custom_path else {
        return Ok(None);
    };
    let b = Btf::parse_file(p, Endianness::default())
        .map_err(|e| format!("failed to parse BTF from '{}': {}", p, e))?;
    println!("flowcone: loaded custom BTF from {}", p);
    Ok(Some(b))
}

/// Lazily locates and parses kernel BTF only if the loaded eBPF object actually
/// contains CO-RE relocations or typed ksyms.
pub(crate) fn load_kernel_btf_with(
    parse: &(dyn Fn(&[u8]) -> Result<Btf, aya::BtfError> + '_),
) -> Result<Btf, aya::EbpfError> {
    for path in DETACHED_BTF_CANDIDATES {
        if Path::new(path).exists()
            && let Ok(bytes) = fs::read(path)
            && let Ok(btf) = parse(&bytes)
        {
            return Ok(btf);
        }
    }
    Btf::from_sys_fs().map_err(aya::EbpfError::from)
}
