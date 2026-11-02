# How to release

Releases are built by the [Release workflow](../.github/workflows/release.yml) when a
version tag is pushed. It packages the VSIX, generates an SPDX SBOM, and attaches both
to a new GitHub release. Publishing to the Marketplace is not automated.

## Release steps

1. Edit the version in [package.json](../package.json).
    - Update the version of the extension - this is usually the minor version.
    - Run `npm install` to update `package-lock.json`.
    - (If necessary) Update the vscode engine version.

2. Update [CHANGELOG.md](../CHANGELOG.md).
    - In the **Changes** section, link to issues that were fixed or closed. Use a link to the pull request if there is no issue to reference.

3. Create a PR with the changes to `package.json`, `package-lock.json`, and `CHANGELOG.md`.
    - Merge the PR once CI and security checks pass and the changes are reviewed.

4. Tag the merge commit on `main` with the version prefixed by `v`, and push the tag:

    ```sh
    git switch main && git pull
    git tag v0.170.0
    git push origin v0.170.0
    ```

    The workflow fails if the tag does not match the `package.json` version.

5. Wait for the Release workflow to finish, then review the generated release notes at
   https://github.com/jhare96/vscode-pull-request-azdo/releases and edit them to match
   `CHANGELOG.md` if needed.
