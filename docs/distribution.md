# Source terms and third-party distribution inventory

Fleet source is licensed under the [MIT License](../LICENSE), with copyright attributed to Benjamin Wilson. Package metadata declares `MIT`; `private: true` only prevents npm publication. Third-party dependencies and bundled tools retain their own licences and required notices.

This inventory is a packaging work list, not a completed legal review or a claim that a distributable installer exists. Do not present an installer as ready until the **actual bundle** has been inspected and its notices retained. No installer was built in this pass.

| Distribution input | Locally inspected licence metadata / notice source | Before publishing installers |
| --- | --- | --- |
| Electron 44.2.0 and embedded Chromium/Node | `node_modules/electron/LICENSE` (MIT); runtime has additional third-party notices | Preserve Electron licence plus runtime `LICENSES.chromium.html` and all embedded runtime notices; inspect the produced package, not only the npm wrapper |
| node-pty 1.1.0; node-addon-api 7.1.1 | `node_modules/node-pty/LICENSE`, `node_modules/node-pty/deps/winpty/LICENSE`, `node_modules/node-addon-api/LICENSE.md` (MIT metadata) | Keep notices with copied `runtime/node_modules`; verify native binaries and Windows winpty/ConPTY inputs |
| Bundled web UI | React/React DOM 19.2.8, xterm 6.0.0/addon-fit 0.11.0, react-markdown 10.1.0, remark-gfm 4.0.1: MIT metadata. lucide-react 0.468.0: ISC metadata | Vite output alone does not constitute a notice inventory; collect direct and transitive runtime notices from the lockfile/package contents |
| ws 8.21.3 | MIT metadata in installed package | Confirm whether the final runtime includes it; retain notice if shipped |
| Downloaded Node 24.19.0 | Pinned archive + integrity in `scripts/prepare-tools.mjs`; archive not downloaded/inspected in this pass | Preserve archive licence and bundled dependency notices alongside Node/npm |
| Windows MinGit 2.55.0.windows.5 | Pinned archive + integrity in `scripts/prepare-tools.mjs`; not downloaded/inspected here | Inventory shipped Git components, notices and applicable corresponding-source obligations from the exact distribution |
| Codex 0.153.4 and included tools | Pinned platform archive + integrity in `scripts/prepare-tools.mjs`; not downloaded/inspected here | Inspect CLI, ripgrep and sandbox-helper notices in each exact archive; retain them in the bundle |

`electron-builder.yml` copies `build/managed-tools/**`, the external daemon runtime and selected native packages. `scripts/prepare-tools.mjs` verifies download checksums, which establishes input integrity, not licence compliance. Development-only tools should be distinguished from shipped code when preparing notices. Source terms, dependency notices, native package verification and signing are separate decisions; signing is not required to inspect this portfolio project.
