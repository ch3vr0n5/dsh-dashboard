# Lifecycle supervisor proposal-to-dispatch contract

This stack defines the pure boundary between a canonical Personal `READY` task,
an accepted dispatch proposal, and a dispatcher adapter.

- `derivePersonalDispatchProposal` returns one bounded proposal and requires an
  explicit clock value, making proposal creation deterministic.
- `dispatchAcceptedPersonalProposal` validates the task, proposal, expiry, and
  exact accepted binding before calling `PersonalDispatcherAdapter.dispatch`.
- No proposal ledger, subprocess, network, Docker, or model implementation is
  part of this contract. A future ledger can supply the accepted value through
  its own adapter without changing this boundary.
