# docs/assets

Static assets referenced by the docs and the top-level `README.md`.

## `architecture.png`

The **canonical system-overview diagram** for AgentDesk. Referenced as the hero
image in the repo `README.md` and at the top of `docs/architecture.md`.

It depicts the three stages of the request→reply flow — **(1) Multi-Channel
Ingress & Identity Capture → (2) Host Orchestration & Isolated Sessions →
(3) Containerized Execution & Backend Gateway** — threaded end-to-end by the
**identity trust chain**, with a bottom band for read-only observability,
reliability/durability, and supply-chain hardening.

### Keeping it accurate

The diagram is a faithful synthesis of the actual architecture. If you change a
load-bearing structure (a stage's responsibilities, the three-DB single-writer
model, the identity chain, the gateway-only path), **regenerate it** so the
picture and the code stay in sync — the same rule as the `docs/*.md` ↔ runtime
contract sync in `CONTRIBUTING.md`.

To regenerate: feed `architecture-diagram-prompt.md` (in this folder) to an
image model, then save the result back here as `architecture.png`.
