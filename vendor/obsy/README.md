# Vendored obsy packages

umpi reads and writes the owner's daily notes in an obsy vault. obsy syncs an Obsidian vault through a bucket the owner controls. It is not published to npm, so its packages are vendored here as `npm pack` tarballs and installed as `file:` dependencies.

| Tarball | Package | Use in umpi |
| --- | --- | --- |
| `obsy-agent-0.0.0.tgz` | `@obsy/agent` | `VaultAgent`: `read`, `list`, `replaceIfUnchanged` |
| `obsy-core-0.0.0.tgz` | `@obsy/core` | `webEnvironment`, and the head reader used by the agent |
| `obsy-storage-r2-0.0.0.tgz` | `@obsy/storage-r2` | `R2Storage` over the Workers R2 binding |
| `obsy-protocol-0.0.0.tgz`, `obsy-merge-0.0.0.tgz` | `@obsy/protocol`, `@obsy/merge` | Dependencies of the above |

- Source: the obsy repository, commit `6dee15d`.
- Licence: MIT. Each tarball contains obsy's `LICENSE`; keep it when updating. `@obsy/merge` depends on `@jest/diff-sequences` (MIT), installed from npm.
- The container image builds copy this folder, because the root lockfile refers to it.

## Update

From the obsy repository, at a committed revision:

```sh
pnpm install && pnpm run build
for p in protocol merge core agent storage-r2; do (cd packages/$p && pnpm pack --pack-destination <umpi>/vendor/obsy); done
```

Then, in umpi, reinstall the tarballs so that the lockfile records their new integrity, update the commit above, and run `npm run typecheck`, `npm test`, and `npm run build`:

```sh
npm install --save-exact ./vendor/obsy/obsy-{protocol,merge,core,agent,storage-r2}-0.0.0.tgz
```
