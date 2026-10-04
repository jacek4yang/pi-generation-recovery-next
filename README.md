# pi-generation-recovery-next

Experimental provider-neutral generation-interruption recovery for
[Pi](https://github.com/earendil-works/pi). The core assumes no provider;
provider-specific replay is a capability adapter permitted only when the
replay boundary is provably safe. Reference baseline:
`jacek4yang/pi-generation-recovery` (read-only).

**Status: bootstrap.** Feature branches: `feat/recovery-coordinator`,
`feat/<provider>-safe-prefix-adapter`, ... Invariants V1–V13 in
`make-pi-great-again/docs/INVARIANTS.md`.

## Development

```bash
npm ci
npm run ci
npm run package-smoke
```
