# External-verifier tests (isolated group)

Two tests in this directory need the **compiled** Baymax BFF verifier rather than anything in this
repository:

- `test_host_custody.py::…test_real_compiled_bff_verifier_accepts_the_custody_assertion`
- `test_identity_interop.py::…test_python_runtime_signature_is_accepted_by_real_compiled_bff_verifier`

They assert interoperability of the Python signer with the TypeScript verifier that actually decides
authorization in the BFF. They are **not** part of the default repository suite: without the compiled
module they skip with an explicit reason instead of failing, so `python -m pytest
apps/desktop/enterprise/plankton-enterprise/baymax_delivery/tests` is self-contained.

## Pinned prerequisite

1. Build the reviewed BFF candidate (the same commit that is deployed to the sandbox) and keep the
   resulting `dist/modules/issue-delivery/workload-identity.js` next to its `node_modules`.
2. Run:

   ```sh
   BAYMAX_BFF_DIST_MODULE=/abs/path/to/dist/modules/issue-delivery/workload-identity.js \
     python -m pytest apps/desktop/enterprise/plankton-enterprise/baymax_delivery/tests \
     -k compiled_bff_verifier -q
   ```

The assertions inside those tests are unchanged when the module is present; the only difference is
that a missing module is a skip (with this file as the reason) rather than a hard failure. Nothing
here weakens the check that runs when the verifier is supplied.
