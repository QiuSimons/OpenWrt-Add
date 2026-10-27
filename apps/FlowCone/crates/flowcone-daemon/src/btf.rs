use aya::{Btf, Endianness};
use std::path::Path;

pub fn find_btf(custom_path: Option<&str>) -> Option<Btf> {
    if let Some(p) = custom_path
        && let Ok(b) = Btf::parse_file(p, Endianness::default())
    {
        println!("flowcone: loaded custom BTF from {}", p);
        return Some(b);
    }

    if let Ok(b) = Btf::from_sys_fs() {
        println!("flowcone: loaded kernel sysfs BTF");
        return Some(b);
    }

    let candidates = [
        "/usr/lib/debug/boot/vmlinux",
        "/boot/vmlinux",
        "/lib/modules/vmlinux",
    ];
    for path in candidates {
        if Path::new(path).exists()
            && let Ok(b) = Btf::parse_file(path, Endianness::default())
        {
            println!("flowcone: loaded detached BTF from {}", path);
            return Some(b);
        }
    }

    None
}
