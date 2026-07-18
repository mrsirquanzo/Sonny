/**
 * Development/demo release trust anchor. The matching private key lives only in
 * test fixtures. Production releases must replace this public key at build time;
 * the release private key is supplied out-of-band and must never ship in a package.
 */
export const ANALYSIS_RELEASE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAkWgXHyPmjCWAWMmrg+ZMAz7M13wbY7ue6WqGW+WcNzQ=
-----END PUBLIC KEY-----
`;
