// RFC 1624 incremental checksum update (pure register ALU)

#[inline(always)]
pub fn csum_replace4(csum: u16, from: u32, to: u32) -> u16 {
    let mut sum = (!u16::from_be(csum)) as u32;

    let from_hi = (from >> 16) as u16;
    let from_lo = from as u16;
    let to_hi = (to >> 16) as u16;
    let to_lo = to as u16;

    sum = sum
        .wrapping_add((!u16::from_be(from_hi)) as u32)
        .wrapping_add(u16::from_be(to_hi) as u32)
        .wrapping_add((!u16::from_be(from_lo)) as u32)
        .wrapping_add(u16::from_be(to_lo) as u32);

    sum = (sum >> 16).wrapping_add(sum & 0xffff);
    sum = sum.wrapping_add(sum >> 16);
    u16::to_be(!sum as u16)
}

#[inline(always)]
pub fn csum_replace2(csum: u16, from: u16, to: u16) -> u16 {
    let mut sum = (!u16::from_be(csum)) as u32;

    sum = sum
        .wrapping_add((!u16::from_be(from)) as u32)
        .wrapping_add(u16::from_be(to) as u32);

    sum = (sum >> 16).wrapping_add(sum & 0xffff);
    sum = sum.wrapping_add(sum >> 16);
    u16::to_be(!sum as u16)
}

#[inline(always)]
pub fn csum_replace16(csum: u16, from: &[u8; 16], to: &[u8; 16]) -> u16 {
    let mut sum = (!u16::from_be(csum)) as u32;

    let mut i = 0;
    while i < 8 {
        let f = u16::from_be_bytes([from[i * 2], from[i * 2 + 1]]) as u32;
        let t = u16::from_be_bytes([to[i * 2], to[i * 2 + 1]]) as u32;
        sum = sum.wrapping_add(!f & 0xffff).wrapping_add(t);
        i += 1;
    }

    sum = (sum >> 16).wrapping_add(sum & 0xffff);
    sum = sum.wrapping_add(sum >> 16);
    u16::to_be(!sum as u16)
}
