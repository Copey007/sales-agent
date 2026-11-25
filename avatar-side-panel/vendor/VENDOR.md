# Vendored @heygen/liveavatar-web-sdk

- Package: `@heygen/liveavatar-web-sdk@0.0.18`
- Source tarball: npm pack (sha256 `cfc1da6a97a7f100a82a35e7c5c420df91744ff6dc3ac0a1590bcb8ce6615141`)
- Bundled file: `liveavatar-web-sdk.js` (ESM, esbuild, platform=browser, dependencies included: livekit-client@2.15.7, events@3.3.0, webrtc-issue-detector@1.16.3)
- Bundled file sha256: `26dbaeb71334ac67aa9deb636756035d25c84f6bea6019ac0a003e0694ff7b51`
- Bytes: 886060
- License: MIT (see the upstream package LICENSE)
- Rebuild (do not fetch at runtime):

      npm pack @heygen/liveavatar-web-sdk@0.0.18
      # install the package's runtime deps in a clean folder, then:
      esbuild package/lib/index.esm.js --bundle --format=esm --platform=browser --legal-comments=none --outfile=liveavatar-web-sdk.js

The extension must load this local file only. Remote script hosts (including esm.sh) are forbidden by MV3 `script-src 'self'` and by Chrome Web Store policy.
