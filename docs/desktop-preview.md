# Standalone macOS preview packages

The normal church workflow uses the operator controls in Community or SyncShow.
This standalone app is an additional macOS console; it still connects to a
configured processor and does not bundle a translation server or provider keys.
The 0.1.1 Apple-silicon and Intel packages passed hosted native builds and
independent installer/mounted-bundle checks. The retained Apple-silicon app also
passed a launch and version check; physical Intel launch and real capture are
separate acceptance. Both installers and seven checksum/verification files are
now retained in the [private 0.1.1 preview release](https://github.com/edydex/heritage-preview-builds/releases/tag/multilinguum-v0.1.1-preview.1).
Sign into GitHub with access to that repository. Choose `aarch64` for Apple
silicon or `x64` for Intel. All nine uploaded files were independently downloaded
and matched byte-for-byte before publication on September 21, 2026.

The package source is `90f91308eaa46e6ed2e4b738e287f5f6bcd46257`.
The subsequent processor-only bilingual keyword correction does not change the
operator or protocol packaged in these installers. They are ad-hoc signed,
not Developer ID signed or notarized. No automatic updater is enabled by this
private publication.

## Build and inspect

Use macOS 13 or newer, Xcode command-line tools, Node 24, pnpm 11.19.0 and Rust.
From a clean checkout of the intended commit:

```sh
pnpm install --frozen-lockfile
pnpm --filter @multilinguum/protocol build
python3 scripts/macos-preview.py prepare
pnpm --filter @multilinguum/operator exec tauri build --ci --bundles app,dmg --config src-tauri/target/preview-config.json
python3 scripts/macos-preview.py verify --architecture arm64
```

Use `x86_64` on an Intel Mac. The preview metadata embeds the exact source
revision and selects ad-hoc signing without a certificate or Apple account.
See [Tauri's signing documentation](https://v2.tauri.app/distribute/sign/macos/).
These are development previews, not notarized distribution packages.

The verifier checks app identity, version, architecture, microphone purpose,
minimum macOS version, signature, portable library paths and DMG integrity. It
mounts the image read-only and compares every installed app file/symlink with the
built bundle before copying the installer, source receipt and checksums into
`desktop-preview/`. The output is ignored by Git. Builds on both Mac architectures
run through the **Desktop preview packages** workflow and retain these artifacts
for 30 days; that alone is not permanent release publication.

Packaging checks do not establish rendered UI, microphone capture or provider
acceptance. Open the exact retained app, verify its Connection screen and Muse
settings, then connect deliberately to the intended processor. Do not paste
provider keys into source files. Saving a Muse token uses the processor's
protected encrypted settings, not the app's browser storage. Start/Stop and a
real mixer must be rehearsed separately.
