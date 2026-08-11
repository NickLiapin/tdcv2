//! SHA-256, written out.
//!
//! The registry publishes a digest beside every bundle and `pack add` checks the
//! bytes against it before writing anything: data that arrived corrupted, or
//! altered on the way, is refused rather than unpacked, because a generator
//! quietly fed the wrong names produces a dataset nobody can tell is wrong.
//!
//! FIPS 180-4. Under two hundred lines, no dependency, and pinned to the
//! standard's own vectors — which is the only thing that makes a hand-written
//! hash worth trusting.

const K: [u32; 64] = [
    0x428a_2f98,
    0x7137_4491,
    0xb5c0_fbcf,
    0xe9b5_dba5,
    0x3956_c25b,
    0x59f1_11f1,
    0x923f_82a4,
    0xab1c_5ed5,
    0xd807_aa98,
    0x1283_5b01,
    0x2431_85be,
    0x550c_7dc3,
    0x72be_5d74,
    0x80de_b1fe,
    0x9bdc_06a7,
    0xc19b_f174,
    0xe49b_69c1,
    0xefbe_4786,
    0x0fc1_9dc6,
    0x240c_a1cc,
    0x2de9_2c6f,
    0x4a74_84aa,
    0x5cb0_a9dc,
    0x76f9_88da,
    0x983e_5152,
    0xa831_c66d,
    0xb003_27c8,
    0xbf59_7fc7,
    0xc6e0_0bf3,
    0xd5a7_9147,
    0x06ca_6351,
    0x1429_2967,
    0x27b7_0a85,
    0x2e1b_2138,
    0x4d2c_6dfc,
    0x5338_0d13,
    0x650a_7354,
    0x766a_0abb,
    0x81c2_c92e,
    0x9272_2c85,
    0xa2bf_e8a1,
    0xa81a_664b,
    0xc24b_8b70,
    0xc76c_51a3,
    0xd192_e819,
    0xd699_0624,
    0xf40e_3585,
    0x106a_a070,
    0x19a4_c116,
    0x1e37_6c08,
    0x2748_774c,
    0x34b0_bcb5,
    0x391c_0cb3,
    0x4ed8_aa4a,
    0x5b9c_ca4f,
    0x682e_6ff3,
    0x748f_82ee,
    0x78a5_636f,
    0x84c8_7814,
    0x8cc7_0208,
    0x90be_fffa,
    0xa450_6ceb,
    0xbef9_a3f7,
    0xc671_78f2,
];

const INITIAL: [u32; 8] = [
    0x6a09_e667,
    0xbb67_ae85,
    0x3c6e_f372,
    0xa54f_f53a,
    0x510e_527f,
    0x9b05_688c,
    0x1f83_d9ab,
    0x5be0_cd19,
];

/// The digest of `data`, lowercase hex — the shape the registry's index writes.
pub fn hex(data: &[u8]) -> String {
    digest(data).iter().map(|b| format!("{b:02x}")).collect()
}

/// The 32 raw bytes.
pub fn digest(data: &[u8]) -> [u8; 32] {
    let mut state = INITIAL;

    // The message, then a 1 bit, then zeros to 56 mod 64, then the bit length
    // big-endian. Built as one buffer rather than streamed: a bundle is a few
    // megabytes, and the whole thing is already in memory to be checked.
    let mut message = data.to_vec();
    let bits = (data.len() as u64) * 8;
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bits.to_be_bytes());

    for block in message.chunks_exact(64) {
        compress(&mut state, block);
    }

    let mut out = [0u8; 32];
    for (i, word) in state.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

fn compress(state: &mut [u32; 8], block: &[u8]) {
    let mut w = [0u32; 64];
    for (i, word) in w.iter_mut().take(16).enumerate() {
        *word = u32::from_be_bytes([
            block[i * 4],
            block[i * 4 + 1],
            block[i * 4 + 2],
            block[i * 4 + 3],
        ]);
    }
    for i in 16..64 {
        let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
        let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16]
            .wrapping_add(s0)
            .wrapping_add(w[i - 7])
            .wrapping_add(s1);
    }

    let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = *state;
    for i in 0..64 {
        let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
        let choose = (e & f) ^ (!e & g);
        let t1 = h
            .wrapping_add(s1)
            .wrapping_add(choose)
            .wrapping_add(K[i])
            .wrapping_add(w[i]);
        let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
        let majority = (a & b) ^ (a & c) ^ (b & c);
        let t2 = s0.wrapping_add(majority);

        h = g;
        g = f;
        f = e;
        e = d.wrapping_add(t1);
        d = c;
        c = b;
        b = a;
        a = t1.wrapping_add(t2);
    }

    for (slot, value) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
        *slot = slot.wrapping_add(value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// FIPS 180-4's own vectors, plus the empty string and a message long enough
    /// to need a second block — which is where a padding mistake shows.
    #[test]
    fn matches_the_standards_vectors() {
        assert_eq!(
            hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
    }

    #[test]
    fn a_message_that_straddles_the_padding_boundary_is_right() {
        // 55, 56 and 64 bytes: one block, two blocks by a hair, and exactly two.
        // Every off-by-one in the padding lands on one of these.
        assert_eq!(
            hex(&[b'a'; 55]),
            "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318"
        );
        assert_eq!(
            hex(&[b'a'; 56]),
            "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a"
        );
        assert_eq!(
            hex(&[b'a'; 64]),
            "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb"
        );
    }

    #[test]
    fn a_million_a_s_is_the_long_vector() {
        assert_eq!(
            hex(&[b'a'; 1_000_000]),
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
        );
    }
}

/// `HMAC-SHA256(key, message)` as lowercase hex — RFC 2104 over the digest above.
///
/// Written out rather than pulled in: this crate has no dependencies, and the
/// construction is six lines once a hash exists. A key longer than the block is
/// hashed first, a shorter one is zero-padded; the two pads are the constants
/// the RFC names, and the result must agree byte for byte with `crypto.createHmac`
/// in Node, `hmac` in Python, `Mac` in Java and `HMACSHA256` in .NET — a service
/// checks one signature, whichever runtime sent it.
pub fn hmac_hex(key: &[u8], message: &[u8]) -> String {
    const BLOCK: usize = 64;
    let mut padded = [0u8; BLOCK];
    if key.len() > BLOCK {
        padded[..32].copy_from_slice(&digest(key));
    } else {
        padded[..key.len()].copy_from_slice(key);
    }

    let mut inner = Vec::with_capacity(BLOCK + message.len());
    inner.extend(padded.iter().map(|b| b ^ 0x36));
    inner.extend_from_slice(message);

    let mut outer = Vec::with_capacity(BLOCK + 32);
    outer.extend(padded.iter().map(|b| b ^ 0x5c));
    outer.extend_from_slice(&digest(&inner));

    hex(&outer)
}

#[cfg(test)]
mod hmac_tests {
    use super::hmac_hex;

    /// The value the other four implementations produce for the same inputs.
    ///
    /// A service checks ONE signature, so this is the number that has to agree:
    /// measured from `crypto.createHmac` in Node and `hmac` in Python, both of
    /// which give the same 64 hex digits for these bytes.
    #[test]
    fn agrees_with_the_other_implementations() {
        assert_eq!(
            hmac_hex(b"k7Fm2p-test-secret", b"1786000000\nseed1\n4\nbody"),
            "d0be9a276deb4802b0a2ec6d85050f7f90e1c44cf42c25773740b755f98803ce"
        );
    }

    /// RFC 4231 case 2 — a short key, so the zero-padding branch is the one used.
    #[test]
    fn matches_rfc_4231() {
        assert_eq!(
            hmac_hex(b"Jefe", b"what do ya want for nothing?"),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    /// A key longer than the 64-byte block is hashed first — the other branch.
    #[test]
    fn hashes_an_over_long_key() {
        let key = vec![0xaa_u8; 131];
        assert_eq!(
            hmac_hex(
                &key,
                b"Test Using Larger Than Block-Size Key - Hash Key First"
            ),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }
}
