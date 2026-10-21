# Third-party notices

The root [MIT license](LICENSE) covers project-authored Umpi source and documentation. It does not replace the licenses or terms of third-party software, services, or data.

## Public Suffix List

`src/browser/aside-export-system/public_suffix_list.dat` is the Mozilla Public Suffix List. `src/browser/aside-export-system/public-suffixes.h` is generated from that data. Both files remain subject to the [Mozilla Public License 2.0](https://mozilla.org/MPL/2.0/). Their headers identify the source version and integrity digest.

## Package dependencies and platform images

Packages resolved by the checked-in npm lockfiles and base images referenced by the Dockerfiles retain their own licenses and notices. The development graph includes libvips platform packages under LGPL-3.0-or-later terms and `caniuse-lite` data under CC-BY-4.0. Review all resolved terms, attribution, source-access, relinking, and notice obligations before distributing a built Worker bundle, development bundle, container image, or application.

The MIT license grants no access to or entitlement for Cloudflare, Telegram, Apple, Aside, OpenAI, Obsidian, or other external software and services. Their account, SDK, subscription, and usage terms apply independently.
