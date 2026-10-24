use aya_ebpf::macros::map;
use aya_ebpf::maps::Array;
use flowcone_common::PORT_MAP_ENTRIES;

#[map]
pub static PORT_BITMAP_V4: Array<u8> = Array::with_max_entries(PORT_MAP_ENTRIES, 0);

#[map]
pub static PORT_BITMAP_V6: Array<u8> = Array::with_max_entries(PORT_MAP_ENTRIES, 0);

#[inline(always)]
fn alloc_port_inner(
    port_map: &Array<u8>,
    preferred: u16,
    min_port: u16,
    max_port: u16,
    seed: u32,
) -> Option<u16> {
    flowcone_common::select_rfc4787_port(preferred, min_port, max_port, seed, |port| {
        if let Some(slot) = port_map.get_ptr_mut(port as u32) {
            if unsafe { *slot } == 0 {
                unsafe { *slot = 1 };
                return true;
            }
        }
        false
    })
}

#[inline(always)]
fn free_port_inner(port_map: &Array<u8>, port: u16) {
    if let Some(slot) = port_map.get_ptr_mut(port as u32) {
        unsafe { *slot = 0 };
    }
}

#[inline(always)]
pub fn alloc_port_v4(preferred: u16, min_port: u16, max_port: u16, seed: u32) -> Option<u16> {
    alloc_port_inner(&PORT_BITMAP_V4, preferred, min_port, max_port, seed)
}

#[inline(always)]
pub fn free_port_v4(port: u16) {
    free_port_inner(&PORT_BITMAP_V4, port);
}

#[inline(always)]
pub fn alloc_port_v6(preferred: u16, min_port: u16, max_port: u16, seed: u32) -> Option<u16> {
    alloc_port_inner(&PORT_BITMAP_V6, preferred, min_port, max_port, seed)
}

#[inline(always)]
pub fn free_port_v6(port: u16) {
    free_port_inner(&PORT_BITMAP_V6, port);
}
