# Azure DevOps Pull Requests for VS Code

Review Azure DevOps pull requests and manage Azure Boards work items from VS Code.
The Azure implementation is written in this repository, without copying another
Azure DevOps extension. It uses the Azure DevOps REST APIs and the existing VS Code
Git integration; it does not translate Azure requests into GitHub API requests.

## Getting started

1. Open a local Git repository with an Azure DevOps remote.
2. Open **Azure DevOps** in the activity bar.
3. Run **Azure DevOps: Sign In** and select a Microsoft account or a personal access token.
4. Click a pull request to open its HTML overview inside VS Code. Expand its tree
   entry to browse changed files, reviewers, commit history, statuses, and discussion.
   Use its **Pull Request Actions** menu for additional operations.

Azure DevOps Services HTTPS and SSH remotes are detected, including legacy
`organization.visualstudio.com` and `vs-ssh.visualstudio.com` remotes. Git
`url.*.insteadOf` aliases, multi-root workspaces, and multiple remotes are supported.
Git itself continues to use your existing Git credentials;
extension sign-in does not modify Git credentials or remote URLs.

Personal access tokens are validated before being saved in **VS Code Secret Storage**,
separately for each organization or server collection. They are never stored in
settings, Git configuration, or logs. Grant **Code (read & write)**,
**Work Items (read & write)**, and **Project and Team (read)** permissions for the full
workflow. Azure permissions and branch policies still apply; tokens do not grant
permissions your account does not have.

**Sign Out** forgets this extension's PAT and disables its automatic Microsoft sign-in
for the selected organization. It does not sign other extensions out of a shared
Microsoft account. Run **Sign In** to reconnect.

## Azure workflows

- Browse active pull requests, or include completed/abandoned pull requests.
- Create and publish draft PRs; edit titles and descriptions; abandon and reactivate PRs.
- Push the current branch and create a PR against a selected target branch.
- Review immutable, merge-base-to-source diffs without checking out the PR.
- Publish inline/file comments and replies; edit/delete comments; resolve/reopen threads.
  Comment positions are requested for the displayed iteration. Open the native
  HTML overview to read general and inline conversations, reply, edit/delete your
  comments, like comments, and resolve/reopen threads. The native Comments panel
  remains available through **Open Discussion in Comments Panel**.
- Start a private pending review, edit/delete its drafts, and submit comments with
  an optional review vote. Drafts survive reloads and failed submissions.
- Like and unlike comments using Azure DevOps' native comment likes.
- Apply plain Markdown suggestion blocks from source-side review comments to the
  checked-out source. Dirty or modified files and mismatched commits are rejected;
  edits remain undoable and are not committed automatically.
- Toggle files as viewed in the changes tree. Viewed state is local to the
  workspace and resets after source pushes.
- Submit Azure review votes, select reviewers from project teams, and remove reviewers.
- Manage PR labels and link or browse related Azure Boards work items.
- View commit statuses and branch-policy evaluations. Complete with merge, squash,
  rebase, or rebase-with-merge; optionally delete the source branch or set auto-complete.
- Check out a PR's server-generated merge commit for validation. This uses a detached
  HEAD and does not overwrite a local branch. Return using **Git: Checkout**. Check out
  the source branch separately to author changes.
- Create cross-fork PRs and check out a fork's source branch for authoring.
- Navigate unambiguous branch-based PR stacks and complete them bottom-to-top.
- Track local unread activity on authored PRs, review requests, and mentions.
- Browse work items with WIQL; read details/comments; create work items from selected
  text; edit titles, HTML descriptions, states, assignments, and tags; add comments.
- Start a work-item branch and prefill the Git commit input with `AB#<id>`.
- Hover over `AB#123`, `#123` (work item), or `!123` (PR) in workspace files and
  review comment inputs. Complete
  `#` work items, `!` PRs, and `@` identities from project teams; hover over mentioned
  users to see their identity.
- Create a work item from a `TODO` using an editor code action.
- Use registered title/description generation and local code-review providers,
  PR description templates, and the extension's public Git/repository API.
- Use Azure chat tools to fetch PRs, checks, discussions, work items, labels, and
  unread activity; search with WIQL; open/create PRs; and resolve threads. Tools
  cannot redirect authenticated requests outside discovered workspace repositories.
  Mutating chat tools require confirmation.
- Attach Azure PRs and Boards work items to chat when the VS Code chat-context API
  is available. Open review/overview tabs supply their native context. PR tools
  expose changed files and optionally immutable base/source contents for a selected
  changed-file path; unrelated file paths are rejected.
- Use Live Share Git integration and suggested project-team contacts when the
  Live Share extension is installed.

Comments publish immediately unless a pending review has been started. Pending
reviews are stored locally in workspace state, not on an Azure review-draft server.
Submission is incremental: acknowledged comments leave the queue, and hidden
comment markers prevent duplicate publication when retrying after an interrupted
submission. The vote is sent only after all comments succeed. Account changes
prevent submission; source changes require comment-only submission against the
original iteration, or discarding and restarting the review before voting.

Stack completion refreshes each PR, checks the reviewed source commits, retargets
the next PR to the bottom target, and waits for Azure to confirm each merge.
It uses merge commits, retains source branches, and stops on policy failures,
conflicts, or timeout rather than completing the remaining stack.

Notifications are a **local activity view**, not a fabricated Azure server inbox.
Read state belongs to the workspace; changes make a conversation unread again.
The visible view refreshes every minute. Azure supports like/unlike, not GitHub's
full emoji reaction repertoire.

Work item types and states are validated by the project's Azure Boards process.
Binary files produce an explicit message directing you to the browser.
API and authentication failures are shown in the tree or a notification and recorded
in the **Azure DevOps** output channel.

## Configuration

```json
{
	"azureDevOps.remotes": ["origin", "upstream"],
	"azureDevOps.pullRequestStatus": "active",
	"azureDevOps.queries": [
		{ "label": "Created by me", "author": "@me" },
		{ "label": "Waiting for my review", "reviewer": "@me", "waiting": true },
		{ "label": "Targeting main", "target": "refs/heads/main" }
	],
	"azureDevOps.workItemQuery": "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.AssignedTo] = @me ORDER BY [System.ChangedDate] DESC"
}
```

Query categories accept `label`, `author`, `reviewer`, `status`, `source`, `target`,
and `waiting`. Author/reviewer filters use identity IDs or `@me`; branch filters use
full refs. Status defaults to `active` and also accepts `completed`, `abandoned`,
or `all`. Set `azureDevOps.queries` to `[]` for a flat list controlled by
`azureDevOps.pullRequestStatus`.

For Azure DevOps Server, explicitly trust the **HTTPS collection URL** in user/machine
settings before signing in with a PAT:

```json
{
	"azureDevOps.serverCollections": ["https://server.example/tfs/DefaultCollection"]
}
```

Server deployments must support REST API 7.1. Server SSH remotes are mapped to a
trusted HTTPS collection on the same hostname and collection path; its HTTPS port
may differ from the SSH port. Arbitrary hosts, HTTP connections, and cross-host
authentication redirects are not accepted.

## Compatibility and migration boundaries

Azure DevOps is the default provider and does not activate the GitHub workflows.
The original GitHub implementation has not been deleted. To use it, enable VS Code's
built-in GitHub Authentication extension, set `"azureDevOps.provider": "github"`,
and reload the window. Its `githubPullRequests.*` and `githubIssues.*` settings remain
unchanged. Azure settings do not translate GitHub search queries.

The Azure path uses native VS Code trees/diffs and an extension-owned HTML PR
overview. Clicking a PR opens a reusable editor tab with its Markdown description,
changed files, discussion, reviewers/votes, checks/policies, labels, linked work
items, and review/completion controls. Completion and management controls reuse the
existing Azure workflows and their confirmation/policy safeguards. Unsent comment
text survives refreshes, and failed submissions leave it intact.

The overview is **not an embedded Azure DevOps website**: its layout is maintained
by the extension and does not automatically inherit Azure website changes.
**Open in Azure DevOps** opens the current official page in your browser.
Azure equivalents retain PR, review, issue/work-item, local Git, provider, and chat
workflows with the native differences described above. GitHub-hosted services such
as Codespaces, GitHub merge queues, and Copilot cloud-agent sessions have no Azure
DevOps API equivalent. They remain available only in GitHub compatibility mode;
switching providers does not make those hosted services operate against Azure.

## Development

Use the existing build and check commands:

```sh
npm ci
npm run compile
npm run compile:test
npx mocha 'out/src/test/azure/client.test.js' 'out/src/test/azure/remote.test.js'
npm run lint
npm run hygiene
```

Authentication and review-wiring tests run in the repository's VS Code extension-host test suite.
REST-client tests use injected HTTP responses and exercise product code without an
Azure account. A live Azure organization is still required to validate tenant
authentication, permissions, server compatibility, and end-to-end UI behavior.
