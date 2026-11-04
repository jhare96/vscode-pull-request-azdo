# Azure DevOps Pull Requests

Review and manage Azure DevOps pull requests in VS Code: browse pull requests, inspect
diffs, leave comments, submit reviews, create pull requests, and complete changes.

**Unofficial community-maintained extension.** This project is not affiliated with,
endorsed by, or supported by Microsoft or GitHub. Support is best-effort, with no
guaranteed response time.

### Disclaimer
This fork was ported agentically and planned maintenance will be supervised agent work.

## Installation

**Proposed-API compatibility:** Installing the VSIX alone is not sufficient. You
must explicitly enable the extension's proposed VS Code APIs and fully restart
VS Code. Use a compatible VS Code Insiders build if your stable build does not
allow those APIs; enabling the permission cannot make unavailable APIs available.

### Prerequisites

- Git.
- VS Code 1.141.0 or later, compatible with the extension's proposed APIs. Use a
  compatible VS Code Insiders build if your stable build does not allow those APIs.

### Install and enable proposed APIs

1. Download the `.vsix` asset from the
   [latest release](https://github.com/jhare96/vscode-pull-request-azdo/releases/latest).
2. In VS Code, run **Extensions: Install from VSIX…** from the Command Palette
   and select the downloaded file.
3. Run **Preferences: Configure Runtime Arguments** from the Command Palette and
   add the extension ID to the `enable-proposed-api` array in `argv.json`,
   preserving any existing entries:

   ```json
   {
     "enable-proposed-api": ["jhare96.vscode-pull-request-azdo"]
   }
   ```

4. Fully restart VS Code by closing all windows and quitting the application,
   then relaunching it. If VS Code reports that an API proposal is unavailable or
   not permitted, use a compatible Insiders build.
5. Open your Azure DevOps repository and sign in as described in
   [Connect to Azure DevOps](#connect-to-azure-devops).

Node.js and npm are not required to install a released VSIX.

Alternatively, install and launch from the command line:

```sh
code --install-extension /path/to/downloaded-extension.vsix --force
```

Close all VS Code windows and quit the application, then launch your Azure DevOps
repository with the API permission enabled:

```sh
code --enable-proposed-api=jhare96.vscode-pull-request-azdo /path/to/your/repository
```

These commands require `code` on your PATH. On macOS, run **Shell Command: Install
'code' command in PATH** from the Command Palette. For Insiders, replace `code`
with `code-insiders` in both commands. Use the `argv.json` setup above to keep the
permission enabled across normal launches.

### Update a local installation

Download a newer `.vsix` from the
[releases page](https://github.com/jhare96/vscode-pull-request-azdo/releases/latest)
and install it with **Extensions: Install from VSIX…**, or repeat the command-line
install command with the new file and `--force`. Keep the proposed-API permission
enabled and fully restart VS Code after updating. A newer release may require a
newer compatible VS Code or Insiders build.

## Connect to Azure DevOps

1. Open a folder whose Git remote is an Azure DevOps repository. Supported remote
   formats include:
   - `https://dev.azure.com/<org>/<project>/_git/<repo>`
   - Legacy `*.visualstudio.com` URLs.
   - `git@ssh.dev.azure.com:v3/<org>/<project>/<repo>`
2. Open the **Azure DevOps** view and choose **Sign in**.
   - **Azure DevOps Services:** use a Microsoft account or a personal access token.
   - **Azure DevOps Server:** use a personal access token.
   - PATs need **Code (read & write)** and **Project and Team (read)** permissions.
     Work Items permissions are not required.
3. For Azure DevOps Server, first add the collection URL to the user-level
   `azureDevOpsPullRequests.serverCollections` setting, for example:

   ```json
   {
     "azureDevOpsPullRequests.serverCollections": [
       "https://devops.example.com/tfs/DefaultCollection"
     ]
   }
   ```

   Workspace settings cannot grant this trust. Credentials are sent only to
   explicitly trusted server collections; Azure DevOps Services organizations do
   not require this setting.

Git SSH authentication is separate from authentication for the pull request APIs.
An SSH remote still requires Microsoft account or PAT sign-in for pull requests.
If several organizations are open, sign-in prompts you to select one.

PATs are stored in VS Code Secret Storage. If a Microsoft session cannot be renewed
silently, choose **Sign in** again. **Azure DevOps Pull Requests: Sign out of Azure
DevOps** removes the selected organization's saved PAT and prevents automatic session
reuse until you sign in again; it does not sign your Microsoft account out of VS Code.

## Features

- **Pull request tree:** Local Pull Request Branches, Waiting For My Review, Created
  By Me, and All Open, with paging.
- **Overview:** edit the title and description, view Markdown, discussions,
  reviewers, votes, labels, branch policies, and status checks. Change draft status,
  retarget or abandon a pull request, and copy or open its link. Failed checks or
  discussions show a section-level error with Retry.
- **Changes and checkout:** inspect file diffs and commits, mark files as viewed,
  check out branches, and return to the default branch with dirty-working-tree
  safeguards. Viewed-file state is stored locally per source blob.
- **Comments and reviews:** add, edit, or delete comments and replies, resolve or
  reactivate discussions, and keep private review drafts locally until submission.
  Approve maps to vote 10, Request Changes to -10, and comment-only submissions do
  not change your vote. Submission is resumable without duplicate comments and is
  blocked if the source changed since the review began.
- **Creation:** choose branches, create drafts, select reviewers and labels, use
  templates from `.azuredevops`, `.vsts`, `docs`, or the repository root, and
  configure auto-complete.
- **Completion:** merge, squash, or rebase against the reviewed source commit, or
  enable auto-complete. Completion requires Azure to report that merging is possible
  and blocking policies have passed. Remote source branches are deleted only if they
  still point to the reviewed commit.

### Custom pull request queries

Configure categories in `azureDevOpsPullRequests.queries`. Supported qualifiers are
`is:open|closed|merged`, `author:`, `review-requested:`, `base:`, `head:`, and the
current repository's `repo:`. Variables include `${user}`, `${owner}`, and
`${repository}`.

```json
{
  "azureDevOpsPullRequests.queries": [
    {
      "label": "Waiting For My Review",
      "query": "is:open review-requested:${user}"
    },
    {
      "label": "Created By Me",
      "query": "is:open author:${user}"
    }
  ]
}
```

Unsupported qualifiers show an error on the category rather than an empty result.

## Limitations

Work item browsing, linking, and automatic transitions on completion are not
supported. Other unavailable features include notifications, coding agents,
Codespaces, merge queues, pull request stacks, projects, milestones, assignees,
file uploads, reactions, attestation commits, reverting merged pull requests, and
creating pull requests from forks.

## Development

### Build from source

In addition to the [installation prerequisites](#prerequisites), building and
packaging require Node.js 24 LTS and npm. Internet access is required to install
dependencies and retrieve build and packaging tools.

Clone this repository and install its locked dependencies:

```sh
git clone https://github.com/jhare96/vscode-pull-request-azdo.git
cd vscode-pull-request-azdo
npm ci
```

Package the extension:

```sh
npm run package -- --out azure-devops-pull-requests.vsix
```

Packaging cleans stale build output, builds production bundles, and generates
third-party licence notices. The VSIX is written to the repository root. Install
it using **Extensions: Install from VSIX…** and enable proposed APIs as described
in [Installation](#installation), or use:

```sh
code --install-extension ./azure-devops-pull-requests.vsix --force
```

For Insiders, use `code-insiders` instead of `code`. To update a source-built
installation, pull the latest changes, run `npm ci`, rebuild the VSIX, and
reinstall it. Keep proposed APIs enabled and fully restart VS Code.

### Run and debug

After running `npm ci`, open this repository in VS Code and select **Launch
Extension** in Run and Debug, then press **F5**. The launch configuration builds the
extension and enables its proposed APIs in an Extension Development Host. Open an
Azure DevOps repository in that window to test it.

- `npm run compile` builds desktop, browser, and webview bundles.
- `npm run compile:test` type-checks and emits extension-host tests.
- `npm run test:scripts` runs build-script tests after compiling tests.
- `npm run test:webviews` runs webview tests.
- `npm run check:commands`, `npm run lint`, and `npm run hygiene` validate command
  contributions and repository conventions.
- `npm run package` creates a production VSIX, including the MIT licence and
  generated dependency notices. Dependencies are bundled rather than shipped as
  `node_modules`.

## Privacy and security

This extension does not send usage or error telemetry to Microsoft, GitHub, or the
maintainer.

Azure DevOps API requests send the data needed for the action you invoke, such as
comments and review votes, to the selected organization or trusted server collection.
Microsoft account sign-in is handled by VS Code's Microsoft authentication provider.
PATs are stored in VS Code Secret Storage; private review drafts and viewed-file
state are stored locally in extension storage. Diagnostic output is local; review
logs before sharing them.

VS Code, other extensions, and optional services you explicitly invoke have their
own privacy policies and telemetry settings.

A private vulnerability reporting channel is not yet configured. Read the
[security reporting policy](./SECURITY.md) before reporting a vulnerability; do not
post sensitive details publicly.

## Support

[Report bugs and request features in this repository](https://github.com/jhare96/vscode-pull-request-azdo/issues).
Include the extension and VS Code versions, reproduction steps, and relevant
diagnostic output with sensitive information removed.

## Licence and attribution

Released under the [MIT licence](./LICENSE). This project includes code from
[Microsoft's GitHub Pull Requests and Issues extension](https://github.com/microsoft/vscode-pull-request-github);
its copyright and licence notices are preserved. Independently authored additions
use the `jhare96` MIT header. Bundled third-party components retain their own licences
and notices, included in the VSIX.
