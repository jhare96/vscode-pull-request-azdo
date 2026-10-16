/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AzureAuthentication } from './authentication';
import { AzureClient, FileChange, Identity, PullRequest, PullRequestIteration, ReviewThread, WorkItem } from './client';
import { AzurePullRequestOverview, OverviewAction } from './overview';
import { AzureRemote, azureRepositoryUrl, parseAzureRemote } from './remote';
import { DraftComment, PendingReviews, suggestionText } from './review';
import { completeStack, pullRequestStack } from './stack';
import { registerAzureTools } from './tools';
import { API, IGit, Repository, RepositoryDescription, ReviewerCommentsProvider, TitleAndDescriptionProvider } from '../api/api';
import { resolveGitUrlAlias } from '../common/gitUrl';
import Logger from '../common/logger';
import { BuiltinGitProvider } from '../gitProviders/builtinGit';

interface RepositoryNode {
	kind: 'repository';
	repository: Repository;
	remoteName: string;
	client: AzureClient;
}

interface PullRequestNode {
	kind: 'pullRequest';
	parent: RepositoryNode;
	pr: PullRequest;
}

interface WorkItemNode {
	kind: 'workItem';
	parent: RepositoryNode;
	item: WorkItem;
}

interface FileNode {
	kind: 'file';
	parent: PullRequestNode;
	change: FileChange;
	iteration: PullRequestIteration;
}

interface DetailNode {
	kind: 'detail';
	label: string;
	description?: string;
	url?: string;
}

interface NotificationNode {
	kind: 'notification';
	parent: RepositoryNode;
	pr: PullRequest;
	key: string;
	fingerprint: string;
}

interface PullRequestQuery {
	label: string;
	author?: string;
	reviewer?: string;
	status?: PullRequest['status'] | 'all';
	source?: string;
	target?: string;
	waiting?: boolean;
}

interface QueryNode {
	kind: 'query';
	parent: RepositoryNode;
	query: PullRequestQuery;
}

type Node = RepositoryNode | PullRequestNode | WorkItemNode | FileNode | DetailNode | NotificationNode | QueryNode;
type AzureThread = vscode.CommentThread | vscode.CommentThread2;
interface DocumentContext {
	file: FileNode;
	side: 'left' | 'right';
	empty: boolean;
	commit: string;
	path: string;
}
interface ThreadBinding {
	pr: PullRequestNode;
	thread?: ReviewThread;
}
interface AzureComment extends vscode.Comment {
	id: number;
	thread: AzureThread;
}

interface AzureChatContext extends vscode.ChatContextItem {
	node: PullRequestNode | WorkItemNode;
}

export class AzureIntegration implements API, vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly changed = new vscode.EventEmitter<Node | undefined>();
	private readonly authentication: AzureAuthentication;
	private readonly pendingReviews: PendingReviews;
	private readonly documents = new Map<string, DocumentContext>();
	private readonly overviews = new Map<string, PullRequestNode>();
	private readonly overviewPanels = new Map<string, { overview: AzurePullRequestOverview; node: PullRequestNode }>();
	private readonly workItemDocuments = new Map<string, WorkItemNode>();
	private readonly bindings = new Map<AzureThread, ThreadBinding>();
	private readonly commentController = vscode.comments.createCommentController('azureDevOps', vscode.l10n.t('Azure DevOps'));
	private readonly repositorySubscriptions = new Map<Repository, vscode.Disposable>();
	private readonly gitConfigurations = new Map<Repository, { key: string; value: string }[]>();
	private readonly workItemCache = new Map<string, { time: number; items: WorkItem[] }>();
	private readonly userCache = new Map<string, { time: number; users: Identity[] }>();
	private readonly viewers = new Map<string, string>();
	private readonly providers = new Set<IGit>();
	private readonly titleProviders = new Map<string, TitleAndDescriptionProvider>();
	private readonly reviewerProviders = new Map<string, ReviewerCommentsProvider>();
	private readonly state: vscode.Memento;
	private git: BuiltinGitProvider | undefined;
	private nextDocument = 0;
	private disposed = false;

	constructor(private readonly context: Pick<vscode.ExtensionContext, 'globalState' | 'workspaceState' | 'secrets'> & Partial<Pick<vscode.ExtensionContext, 'extensionUri'>>) {
		this.authentication = new AzureAuthentication(context);
		this.pendingReviews = new PendingReviews(context.workspaceState);
		this.state = context.workspaceState;
		this.disposables.push(this.changed, this.commentController);
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		for (const { overview } of this.overviewPanels.values()) {
			overview.dispose();
		}
		for (const subscription of this.repositorySubscriptions.values()) {
			subscription.dispose();
		}
		for (const thread of this.bindings.keys()) {
			thread.dispose();
		}
		this.disposables.forEach(disposable => disposable.dispose());
	}

	async initialize(): Promise<void> {
		this.git = await BuiltinGitProvider.createProvider();
		if (this.git) {
			this.disposables.push(this.git, this.registerGitProvider(this.git));
		}
		for (const workItems of [false, true]) {
			const provider: vscode.TreeDataProvider<Node> = {
				onDidChangeTreeData: this.changed.event,
				getTreeItem: node => this.treeItem(node),
				getChildren: node => this.children(node, workItems),
			};
			this.disposables.push(vscode.window.createTreeView(workItems ? 'azureDevOps.workItems' : 'azureDevOps.pullRequests', { treeDataProvider: provider, showCollapseAll: true }));
		}
		const notifications = vscode.window.createTreeView('azureDevOps.notifications', {
			treeDataProvider: {
				onDidChangeTreeData: this.changed.event,
				getTreeItem: (node: Node) => this.treeItem(node),
				getChildren: (node?: Node) => this.notifications(node),
			},
		});
		this.disposables.push(notifications);
		const refreshTimer = setInterval(() => {
			if (notifications.visible) {
				this.changed.fire(undefined);
			}
		}, 60000);
		this.disposables.push({ dispose: () => clearInterval(refreshTimer) });
		this.disposables.push(vscode.workspace.registerTextDocumentContentProvider('azure-review', {
			provideTextDocumentContent: async uri => {
				const document = this.documents.get(uri.toString());
				if (!document) {
					throw new Error(vscode.l10n.t('This review document has expired. Reopen the file from the pull request.'));
				}
				return document.empty ? '' : document.file.parent.parent.client.file(document.path, document.commit);
			},
		}));
		this.commentController.commentingRangeProvider = {
			provideCommentingRanges: document => this.documents.has(document.uri.toString())
				? { ranges: [new vscode.Range(0, 0, Math.max(0, document.lineCount - 1), 0)], enableFileComments: true } : [],
		};
		this.commentController.options = { prompt: vscode.l10n.t('Publish a comment, or start a review to save it privately until submission.') };
		this.commentController.reactionHandler = this.handle(async (comment: vscode.Comment, reaction: vscode.CommentReaction) => {
			const azure: Partial<AzureComment> = comment;
			const binding = azure.thread && this.bindings.get(azure.thread);
			if (!binding?.thread || typeof azure.id !== 'number' || azure.id < 0) {
				throw new Error(vscode.l10n.t('Publish the comment before reacting.'));
			}
			await binding.pr.parent.client.likeComment(binding.pr.pr.pullRequestId, binding.thread.id, azure.id, !reaction.authorHasReacted);
			await this.reloadComments();
			await Promise.all([...this.overviewPanels.values()].map(({ overview }) => overview.refresh()));
		});
		this.disposables.push(
			vscode.commands.registerCommand('azureDevOps.refresh', this.handle(async () => {
				this.refreshRepositories();
				this.workItemCache.clear();
				this.userCache.clear();
				await this.reloadComments();
				await Promise.all([...this.overviewPanels.values()].map(({ overview }) => overview.refresh()));
				this.changed.fire(undefined);
			})),
			vscode.commands.registerCommand('azureDevOps.signIn', this.handle(async () => {
				const repository = await this.pickRepository();
				if (repository && await this.authentication.signIn(repository.client.remote)) {
					this.workItemCache.clear();
					this.userCache.clear();
					this.changed.fire(undefined);
				}
			})),
			vscode.commands.registerCommand('azureDevOps.signOut', this.handle(async () => {
				const repository = await this.pickRepository();
				if (repository) {
					await this.authentication.signOut(repository.client.remote);
					this.workItemCache.clear();
					this.userCache.clear();
					for (const [thread, binding] of this.bindings) {
						if (binding.pr.parent.client.remote.organizationUrl === repository.client.remote.organizationUrl) {
							thread.dispose();
							this.bindings.delete(thread);
						}
					}
					for (const { overview, node } of this.overviewPanels.values()) {
						if (node.parent.client.remote.organizationUrl === repository.client.remote.organizationUrl) {
							overview.dispose();
						}
					}
					this.changed.fire(undefined);
				}
			})),
			vscode.commands.registerCommand('azureDevOps.createPullRequest', this.handle(() => this.createPullRequest())),
			vscode.commands.registerCommand('azureDevOps.createWorkItem', this.handle((title?: string) => this.createWorkItem(title))),
			vscode.commands.registerCommand('azureDevOps.pullRequestActions', this.handle((node?: PullRequestNode) => this.pullRequestActions(node))),
			vscode.commands.registerCommand('azureDevOps.openPullRequest', this.handle(async (node?: PullRequestNode) => {
				node ??= await this.pickPullRequest();
				if (node) {
					await this.showOverview(node);
				}
			})),
			vscode.commands.registerCommand('azureDevOps.workItemActions', this.handle((node?: WorkItemNode) => this.workItemActions(node))),
			vscode.commands.registerCommand('azureDevOps.openDiff', this.handle((node: FileNode) => this.openDiff(node))),
			vscode.commands.registerCommand('azureDevOps.toggleFileViewed', this.handle(async (node: FileNode) => {
				const key = JSON.stringify([this.reviewKey(node.parent), node.change.item.path]);
				const viewed = { ...this.state.get<Record<string, string>>('azureDevOps.viewedFiles', {}) };
				if (viewed[key] === node.iteration.sourceRefCommit.commitId) {
					delete viewed[key];
				} else {
					viewed[key] = node.iteration.sourceRefCommit.commitId;
				}
				await this.state.update('azureDevOps.viewedFiles', viewed);
				this.changed.fire(undefined);
			})),
			vscode.commands.registerCommand('azureDevOps.applySuggestion', this.handle((comment: AzureComment) => this.applySuggestion(comment))),
			vscode.commands.registerCommand('azureDevOps.reply', this.handle((reply: vscode.CommentReply) => this.reply(reply))),
			vscode.commands.registerCommand('azureDevOps.startReview', this.handle((reply: vscode.CommentReply) => this.startReview(reply))),
			vscode.commands.registerCommand('azureDevOps.submitReview', this.handle((node?: PullRequestNode) => this.submitReview(node))),
			vscode.commands.registerCommand('azureDevOps.openNotification', this.handle(async (node: NotificationNode) => {
				const read = { ...this.state.get<Record<string, string>>('azureDevOps.readActivity', {}), [node.key]: node.fingerprint };
				await this.state.update('azureDevOps.readActivity', read);
				await this.showOverview({ kind: 'pullRequest', parent: node.parent, pr: node.pr });
				this.changed.fire(undefined);
			})),
			vscode.commands.registerCommand('azureDevOps.markNotificationsRead', this.handle(async () => {
				const read = { ...this.state.get<Record<string, string>>('azureDevOps.readActivity', {}) };
				for (const repository of this.repositories()) {
					for (const node of await this.notifications(repository)) {
						if (node.kind === 'detail') {
							throw new Error(node.label);
						}
						if (node.kind === 'notification') {
							read[node.key] = node.fingerprint;
						}
					}
				}
				await this.state.update('azureDevOps.readActivity', read);
				this.changed.fire(undefined);
			})),
			vscode.commands.registerCommand('azureDevOps.resolveThread', this.handle((thread: AzureThread) => this.resolveThread(thread, true))),
			vscode.commands.registerCommand('azureDevOps.reopenThread', this.handle((thread: AzureThread) => this.resolveThread(thread, false))),
			vscode.commands.registerCommand('azureDevOps.editComment', this.handle((comment: AzureComment) => this.editComment(comment))),
			vscode.commands.registerCommand('azureDevOps.deleteComment', this.handle((comment: AzureComment) => this.deleteComment(comment))),
		);
		this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('azureDevOps')) {
				this.refreshRepositories();
			}
			if (event.affectsConfiguration('azureDevOps.provider')) {
				void vscode.window.showInformationMessage(vscode.l10n.t('Reload the window to change pull request providers.'), vscode.l10n.t('Reload Window')).then(choice => {
					if (choice) {
						void vscode.commands.executeCommand('workbench.action.reloadWindow');
					}
				});
			}
		}), vscode.authentication.onDidChangeSessions(event => {
			if (event.provider.id === 'microsoft') {
				this.changed.fire(undefined);
			}
		}));
		this.disposables.push(vscode.workspace.onDidCloseTextDocument(document => {
			this.documents.delete(document.uri.toString());
			this.overviews.delete(document.uri.toString());
			this.workItemDocuments.delete(document.uri.toString());
			for (const [thread] of this.bindings) {
				if (thread.uri.toString() === document.uri.toString()) {
					thread.dispose();
					this.bindings.delete(thread);
				}
			}
		}));
		this.registerLanguageFeatures();
		try {
			this.registerChatContexts();
		} catch (error) {
			if (!(error instanceof Error) || !/CANNOT use API proposal:\s*chatContextProvider/.test(error.message)) {
				throw error;
			}
			Logger.warn('Chat context attachments require the chatContextProvider API proposal. Azure chat tools remain available.', 'AzureDevOps');
		}
		this.disposables.push(...registerAzureTools(
			() => this.repositories().map(node => ({ client: node.client, branch: node.repository.state.HEAD?.name })),
			async repository => {
				const node = this.repositories().find(node => JSON.stringify(node.client.remote) === JSON.stringify(repository.client.remote));
				if (!node) {
					throw new Error(vscode.l10n.t('The Azure DevOps repository is no longer open.'));
				}
				const result = await this.notifications(node);
				const failure = result.find(node => node.kind === 'detail');
				if (failure?.kind === 'detail') {
					throw new Error(failure.label);
				}
				return result.filter((node): node is NotificationNode => node.kind === 'notification').map(node => ({
					id: node.pr.pullRequestId, title: node.pr.title, url: node.parent.client.pullRequestUrl(node.pr.pullRequestId),
				}));
			},
		));
		if (vscode.extensions.getExtension('ms-vsliveshare.vsliveshare')) {
			const { LiveShareManager } = await import('../gitProviders/vsls');
			const manager = new LiveShareManager(this);
			this.disposables.push(manager);
			const api = await manager.initialize();
			if (api) {
				const notified = new vscode.EventEmitter<{ type: string; body: { contacts: { id: string; displayName: string; email: string }[]; exclusive: boolean } }>();
				this.disposables.push(notified);
				api.registerContactServiceProvider('azure-devops-pr', {
					onNotified: notified.event,
					requestAsync: async (type: string, _parameters: Object, token?: vscode.CancellationToken) => {
						if (type !== 'initialize') {
							throw new Error(vscode.l10n.t('Unsupported Live Share contact request: {0}', type));
						}
						const contacts = new Map<string, { id: string; displayName: string; email: string }>();
						for (const repository of this.repositories()) {
							for (const user of await this.users(repository)) {
								if (user.uniqueName?.includes('@')) {
									contacts.set(user.id, { id: user.id, displayName: user.displayName, email: user.uniqueName });
								}
							}
						}
						if (token?.isCancellationRequested) {
							throw new vscode.CancellationError();
						}
						notified.fire({ type: 'suggestedUsers', body: { contacts: [...contacts.values()], exclusive: true } });
						return {
							description: vscode.l10n.t('Azure DevOps pull request contacts'),
							capabilities: { supportsDispose: false, supportsInviteLink: false, supportsPresence: false, supportsContactPresenceRequest: false, supportsPublishPresence: false },
						};
					},
				});
			}
		}
	}

	registerGitProvider(provider: IGit): vscode.Disposable {
		this.providers.add(provider);
		const subscriptions = [provider.onDidOpenRepository(() => this.refreshRepositories()), provider.onDidCloseRepository(() => this.refreshRepositories())];
		this.refreshRepositories();
		const registration = { dispose: () => {
			this.providers.delete(provider);
			subscriptions.forEach(subscription => subscription.dispose());
			this.refreshRepositories();
		} };
		this.disposables.push(registration);
		return registration;
	}

	private registerChatContexts(): void {
		if (!vscode.chat?.registerChatAttachContextProvider || !vscode.chat.registerChatTabContextProvider) {
			return;
		}
		const item = (node: PullRequestNode | WorkItemNode): AzureChatContext => ({
			node,
			label: node.kind === 'pullRequest' ? `!${node.pr.pullRequestId} ${node.pr.title}` : `AB#${node.item.id} ${node.item.fields['System.Title']}`,
			iconPath: new vscode.ThemeIcon(node.kind === 'pullRequest' ? 'git-pull-request' : 'issues'),
			modelDescription: 'Azure DevOps context. Inspect immutable changed-file contents using azdo_pull_request_fetch with a path from its changes.',
			command: {
				command: node.kind === 'pullRequest' ? 'azureDevOps.openPullRequest' : 'azureDevOps.workItemActions',
				title: vscode.l10n.t('Open Azure DevOps Item'), arguments: [node],
			},
		});
		const resolve = async (context: AzureChatContext, token: vscode.CancellationToken): Promise<vscode.ChatContextItem> => {
			const node = context.node;
			if (token.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			if (!this.repositories().some(repository => repository.repository === node.parent.repository
				&& JSON.stringify(repository.client.remote) === JSON.stringify(node.parent.client.remote))) {
				throw new Error(vscode.l10n.t('The Azure DevOps repository is no longer open.'));
			}
			const value = node.kind === 'pullRequest'
				? await node.parent.client.reviewDetails(node.pr.pullRequestId)
				: { workItem: await node.parent.client.workItem(node.item.id), comments: await node.parent.client.workItemComments(node.item.id) };
			if (token.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			return { ...context, value: JSON.stringify(value) };
		};
		for (const workItems of [false, true]) {
			const provider: vscode.ChatAttachContextProvider<AzureChatContext> & vscode.ChatTabContextProvider<AzureChatContext> = {
				provideAttachChatContext: async token => {
					const items: AzureChatContext[] = [];
					for (const parent of this.repositories()) {
						if (token.isCancellationRequested) {
							throw new vscode.CancellationError();
						}
						if (workItems) {
							items.push(...(await this.workItems(parent)).map(value => item({ kind: 'workItem', parent, item: value })));
						} else {
							items.push(...(await parent.client.pullRequests()).map(pr => item({ kind: 'pullRequest', parent, pr })));
						}
					}
					return items;
				},
				resolveAttachChatContext: resolve,
				resolveChatTabContext: resolve,
				provideChatTabContext: options => {
					const input = options.tab.input;
					if (!workItems && input instanceof vscode.TabInputWebview && input.viewType.includes('azureDevOps.pullRequestOverview')) {
						const active = [...this.overviewPanels.values()].find(({ overview }) => overview.panel.active);
						return active ? item(active.node) : undefined;
					}
					const uri = input instanceof vscode.TabInputText ? input.uri : input instanceof vscode.TabInputTextDiff ? input.modified : undefined;
					if (!(uri instanceof vscode.Uri)) {
						return undefined;
					}
					const node = workItems ? this.workItemDocuments.get(uri.toString())
						: this.overviews.get(uri.toString()) ?? this.documents.get(uri.toString())?.file.parent;
					return node ? item(node) : undefined;
				},
			};
			const id = workItems ? 'azureDevOpsWorkItem' : 'azureDevOpsPr';
			this.disposables.push(vscode.chat.registerChatAttachContextProvider(id, provider));
			this.disposables.push(vscode.chat.registerChatTabContextProvider({ uri: { scheme: 'untitled' } }, id, provider));
			if (!workItems) {
				this.disposables.push(vscode.chat.registerChatTabContextProvider({ uri: { scheme: 'azure-review' } }, id, provider));
				this.disposables.push(vscode.chat.registerChatTabContextProvider({ uri: { scheme: 'webview-panel', pattern: '**/*azureDevOps.pullRequestOverview*' } }, id, provider));
			}
		}
	}

	getGitProvider(uri: vscode.Uri): IGit | undefined {
		return [...this.providers].find(provider => provider.repositories.some(repository => uri.toString() === repository.rootUri.toString() || uri.toString().startsWith(`${repository.rootUri.toString().replace(/\/$/, '')}/`)));
	}

	registerTitleAndDescriptionProvider(title: string, provider: TitleAndDescriptionProvider): vscode.Disposable {
		this.titleProviders.set(title, provider);
		return { dispose: () => {
			if (this.titleProviders.get(title) === provider) {
				this.titleProviders.delete(title);
			}
		} };
	}

	registerReviewerCommentsProvider(title: string, provider: ReviewerCommentsProvider): vscode.Disposable {
		this.reviewerProviders.set(title, provider);
		return { dispose: () => {
			if (this.reviewerProviders.get(title) === provider) {
				this.reviewerProviders.delete(title);
			}
		} };
	}

	async getRepositoryDescription(uri: vscode.Uri): Promise<RepositoryDescription | undefined> {
		const node = this.repositoryFor(uri);
		if (!node) {
			return undefined;
		}
		const metadata = await node.client.repository();
		const branch = node.repository.state.HEAD?.name;
		const pr = branch ? (await node.client.pullRequests('active', { 'searchCriteria.sourceRefName': `refs/heads/${branch}` }))[0] : undefined;
		return {
			owner: `${node.client.remote.organizationUrl.split('/').pop()}/${node.client.remote.project}`,
			repositoryName: node.client.remote.repository, defaultBranch: metadata.defaultBranch?.replace('refs/heads/', '') ?? '',
			pullRequest: pr && { id: pr.pullRequestId, number: pr.pullRequestId, title: pr.title, url: node.client.pullRequestUrl(pr.pullRequestId) },
		};
	}

	private async notifications(node?: Node): Promise<Node[]> {
		try {
			if (!node) {
				return this.repositories();
			}
			if (node.kind !== 'repository') {
				return [];
			}
			const { client } = node;
			const viewer = await client.currentUser();
			const read = this.state.get<Record<string, string>>('azureDevOps.readActivity', {});
			const result: NotificationNode[] = [];
			for (const pr of await client.pullRequests('all')) {
				const threads = await client.threads(pr.pullRequestId);
				const involved = pr.createdBy.id === viewer.id || pr.reviewers.some(reviewer => reviewer.id === viewer.id)
					|| threads.some(thread => thread.comments.some(comment => comment.content?.includes(`@<${viewer.id}>`)));
				if (!involved) {
					continue;
				}
				const fingerprint = JSON.stringify([pr.status, pr.lastMergeSourceCommit.commitId, pr.reviewers.map(reviewer => [reviewer.id, reviewer.vote]),
					threads.map(thread => [thread.id, thread.status, thread.comments.map(comment => [comment.id, comment.content, comment.isDeleted])])]);
				const key = this.reviewKey({ kind: 'pullRequest', parent: node, pr });
				if (read[key] !== fingerprint) {
					result.push({ kind: 'notification', parent: node, pr, key, fingerprint });
				}
			}
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			Logger.error(message, 'AzureDevOps');
			return [{ kind: 'detail', label: message }];
		}
	}

	private repositoryFor(uri: vscode.Uri): RepositoryNode | undefined {
		return this.repositories().filter(node => uri.toString() === node.repository.rootUri.toString()
			|| uri.toString().startsWith(`${node.repository.rootUri.toString().replace(/\/$/, '')}/`))
			.sort((left, right) => right.repository.rootUri.path.length - left.repository.rootUri.path.length)[0];
	}

	private repositoryForDocument(document: vscode.TextDocument): RepositoryNode | undefined {
		if (document.uri.scheme !== 'vscode-comment') {
			return this.repositoryFor(document.uri);
		}
		const active = vscode.window.activeTextEditor?.document.uri;
		if (active) {
			const review = this.documents.get(active.toString())?.file.parent ?? this.overviews.get(active.toString());
			const repository = review?.parent ?? this.repositoryFor(active);
			if (repository) {
				return repository;
			}
		}
		const repositories = this.repositories();
		return repositories.length === 1 ? repositories[0] : undefined;
	}

	private async workItems(repository: RepositoryNode): Promise<WorkItem[]> {
		const key = `${repository.client.remote.organizationUrl}/${repository.client.remote.project}`;
		const cached = this.workItemCache.get(key);
		if (cached && Date.now() - cached.time < 30000) {
			return cached.items;
		}
		const query = vscode.workspace.getConfiguration('azureDevOps', repository.repository.rootUri).get<string>('workItemQuery', 'SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project ORDER BY [System.ChangedDate] DESC');
		const items = await repository.client.workItems(query);
		this.workItemCache.set(key, { time: Date.now(), items });
		return items;
	}

	private async users(repository: RepositoryNode): Promise<Identity[]> {
		const key = `${repository.client.remote.organizationUrl}/${repository.client.remote.project}`;
		const cached = this.userCache.get(key);
		if (cached && Date.now() - cached.time < 30000) {
			return cached.users;
		}
		const users = await repository.client.users();
		this.userCache.set(key, { time: Date.now(), users });
		return users;
	}

	private registerLanguageFeatures(): void {
		this.disposables.push(vscode.languages.registerHoverProvider([{ scheme: 'file' }, { scheme: 'vscode-comment' }], {
			provideHover: async (document, position, token) => {
				const range = document.getWordRangeAtPosition(position, /(?:AB#|#|!)[1-9]\d*|@<[\w-]+>|@[\w.-]+/);
				const repository = this.repositoryForDocument(document);
				if (!range || !repository || token.isCancellationRequested) {
					return undefined;
				}
				try {
					const reference = document.getText(range);
					if (reference.startsWith('@')) {
						const name = reference.replace(/^@<?|>$/g, '').toLowerCase();
						const user = (await this.users(repository)).find(user => user.id.toLowerCase() === name || user.uniqueName?.toLowerCase() === name || user.displayName.toLowerCase() === name);
						if (!user || token.isCancellationRequested) {
							return undefined;
						}
						return new vscode.Hover(new vscode.MarkdownString().appendText(`${user.displayName}\n${user.uniqueName ?? ''}`), range);
					}
					const id = Number(reference.replace(/^(?:AB#|#|!)/, ''));
					const pr = reference.startsWith('!');
					const title = pr ? (await repository.client.pullRequest(id)).title : (await repository.client.workItem(id)).fields['System.Title'];
					if (token.isCancellationRequested) {
						return undefined;
					}
					const markdown = new vscode.MarkdownString();
					markdown.appendText(title);
					markdown.appendMarkdown(`\n\n[${vscode.l10n.t('Open in Azure DevOps')}](${pr ? repository.client.pullRequestUrl(id) : repository.client.workItemUrl(id)})`);
					return new vscode.Hover(markdown, range);
				} catch (error) {
					Logger.error(error instanceof Error ? error.message : String(error), 'AzureDevOps');
					return undefined;
				}
			},
		}));
		this.disposables.push(vscode.languages.registerCompletionItemProvider([{ scheme: 'file' }, { scheme: 'vscode-comment' }], {
			provideCompletionItems: async (document, position, token) => {
				const repository = this.repositoryForDocument(document);
				const prefix = /(?<trigger>#|!|@)(?<text>[\w-]*)$/.exec(document.lineAt(position.line).text.slice(0, position.character));
				if (!repository || !prefix?.groups || token.isCancellationRequested) {
					return [];
				}
				try {
					const range = new vscode.Range(position.line, position.character - prefix.groups.text.length, position.line, position.character);
					if (prefix.groups.trigger === '@') {
						const users = await this.users(repository);
						return token.isCancellationRequested ? [] : users.map(user => {
							const item = new vscode.CompletionItem(user.displayName, vscode.CompletionItemKind.User);
							item.insertText = `<${user.id}>`;
							item.range = range;
							item.detail = user.uniqueName;
							return item;
						});
					}
					const references = prefix.groups.trigger === '!'
						? (await repository.client.pullRequests()).map(pr => ({ id: pr.pullRequestId, title: pr.title }))
						: (await this.workItems(repository)).map(item => ({ id: item.id, title: item.fields['System.Title'] }));
					return token.isCancellationRequested ? [] : references.map(reference => {
						const item = new vscode.CompletionItem(`${reference.id}: ${reference.title}`, vscode.CompletionItemKind.Reference);
						item.insertText = String(reference.id);
						item.range = range;
						return item;
					});
				} catch (error) {
					Logger.error(error instanceof Error ? error.message : String(error), 'AzureDevOps');
					return [];
				}
			},
		}, '#', '!', '@'));
		this.disposables.push(vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, {
			provideCodeActions: (document, range) => {
				if (!this.repositoryFor(document.uri)) {
					return [];
				}
				const todo = /\bTODO\b[:\s]*(?<title>.*)/.exec(document.lineAt(range.start.line).text);
				if (!todo?.groups?.title.trim()) {
					return [];
				}
				const action = new vscode.CodeAction(vscode.l10n.t('Create Azure DevOps work item'), vscode.CodeActionKind.QuickFix);
				action.command = { command: 'azureDevOps.createWorkItem', title: action.title, arguments: [todo.groups.title.trim()] };
				return [action];
			},
		}));
	}

	private handle<T extends unknown[]>(handler: (...args: T) => unknown): (...args: T) => Promise<void> {
		return async (...args: T) => {
			try {
				await handler(...args);
			} catch (error) {
				this.report(error);
			}
		};
	}

	private report(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		Logger.error(message, 'AzureDevOps');
		void vscode.window.showErrorMessage(message);
	}

	private refreshRepositories(): void {
		if (this.disposed) {
			return;
		}
		this.workItemCache.clear();
		this.userCache.clear();
		for (const [repository, subscription] of this.repositorySubscriptions) {
			if (![...this.providers].some(provider => provider.repositories.includes(repository))) {
				subscription.dispose();
				this.repositorySubscriptions.delete(repository);
				this.gitConfigurations.delete(repository);
			}
		}
		for (const repository of [...this.providers].flatMap(provider => provider.repositories)) {
			if (!this.repositorySubscriptions.has(repository)) {
				this.repositorySubscriptions.set(repository, repository.state.onDidChange(() => this.changed.fire(undefined)));
			}
			void repository.getConfigs().then(configs => {
				if (!this.disposed && this.repositorySubscriptions.has(repository)) {
					this.gitConfigurations.set(repository, configs);
					this.changed.fire(undefined);
				}
			}, error => {
				this.gitConfigurations.delete(repository);
				if (!this.disposed && this.repositorySubscriptions.has(repository)) {
					this.report(error);
				}
			});
		}
		this.changed.fire(undefined);
	}

	private repositories(): RepositoryNode[] {
		const nodes: RepositoryNode[] = [];
		for (const repository of [...this.providers].flatMap(provider => provider.repositories)) {
			const configuration = vscode.workspace.getConfiguration('azureDevOps', repository.rootUri);
			const remotes = configuration.get<string[]>('remotes', ['origin', 'upstream']);
			const collections = configuration.get<string[]>('serverCollections', []);
			const seen = new Set<string>();
			for (const remote of repository.state.remotes) {
				if (!remotes.includes(remote.name)) {
					continue;
				}
				const azure = parseAzureRemote(resolveGitUrlAlias(remote.fetchUrl ?? remote.pushUrl ?? '', this.gitConfigurations.get(repository) ?? []), collections);
				if (azure) {
					const key = JSON.stringify(azure);
					if (!seen.has(key)) {
						seen.add(key);
						nodes.push({
							kind: 'repository', repository, remoteName: remote.name,
							client: new AzureClient(azure, () => this.authentication.authorization(azure)),
						});
					}
				}
			}
		}
		return nodes;
	}

	private async pickRepository(): Promise<RepositoryNode | undefined> {
		const repositories = this.repositories();
		if (!repositories.length) {
			throw new Error(vscode.l10n.t('Open a Git repository with an Azure DevOps remote. Check azureDevOps.remotes and azureDevOps.serverCollections.'));
		}
		if (repositories.length === 1) {
			return repositories[0];
		}
		const selected = await vscode.window.showQuickPick(repositories.map(node => ({
			label: `${node.client.remote.project}/${node.client.remote.repository}`,
			description: `${node.remoteName} - ${node.repository.rootUri.fsPath}`,
			node,
		})), { title: vscode.l10n.t('Select an Azure DevOps repository') });
		return selected?.node;
	}

	private async children(node: Node | undefined, workItems: boolean): Promise<Node[]> {
		try {
			if (!node) {
				return this.repositories();
			}
			if (node.kind === 'repository') {
				if (workItems) {
					return (await this.workItems(node)).map(item => ({ kind: 'workItem', parent: node, item }));
				}
				const queries = vscode.workspace.getConfiguration('azureDevOps', node.repository.rootUri).get<PullRequestQuery[]>('queries', []);
				if (queries.length) {
					return queries.map(query => ({ kind: 'query', parent: node, query }));
				}
				const status = vscode.workspace.getConfiguration('azureDevOps', node.repository.rootUri).get<'active' | 'all'>('pullRequestStatus', 'active');
				return (await node.client.pullRequests(status)).map(pr => ({ kind: 'pullRequest', parent: node, pr }));
			}
			if (node.kind === 'query') {
				const { query, parent } = node;
				const viewer = query.author === '@me' || query.reviewer === '@me' || query.waiting ? await parent.client.currentUser() : undefined;
				const reviewer = query.reviewer === '@me' ? viewer?.id : query.reviewer;
				const prs = await parent.client.pullRequests(query.status ?? 'active', {
					'searchCriteria.creatorId': query.author === '@me' ? viewer?.id : query.author,
					'searchCriteria.reviewerId': reviewer,
					'searchCriteria.sourceRefName': query.source,
					'searchCriteria.targetRefName': query.target,
				});
				return prs.filter(pr => !query.waiting || pr.reviewers.some(user => user.id === (reviewer ?? viewer?.id) && !user.vote))
					.map(pr => ({ kind: 'pullRequest', parent, pr }));
			}
			if (node.kind === 'pullRequest') {
				const { client } = node.parent;
				const id = node.pr.pullRequestId;
				const [pr, iterations, threads, statuses, commits] = await Promise.all([
					client.pullRequest(id), client.iterations(id), client.threads(id), client.statuses(id), client.commits(id),
				]);
				node.pr = pr;
				const iteration = iterations[iterations.length - 1];
				const changes = iteration ? await client.changes(id, iteration.id) : [];
				return [
					{ kind: 'detail', label: `${pr.sourceRefName.replace('refs/heads/', '')} -> ${pr.targetRefName.replace('refs/heads/', '')}` },
					...changes.filter(change => !change.item.isFolder).map((change): FileNode => ({ kind: 'file', parent: node, change, iteration })),
					...pr.reviewers.map((reviewer): DetailNode => ({ kind: 'detail', label: reviewer.displayName, description: this.voteLabel(reviewer.vote ?? 0) })),
					...statuses.map((status): DetailNode => ({ kind: 'detail', label: status.context.name, description: `${status.state}: ${status.description ?? ''}`, url: status.targetUrl })),
					...commits.map((commit): DetailNode => ({ kind: 'detail', label: `${commit.commitId.slice(0, 8)} ${commit.comment ?? ''}` })),
					...threads.filter(thread => !thread.isDeleted).map((thread): DetailNode => ({
						kind: 'detail',
						label: thread.comments.filter(comment => !comment.isDeleted).map(comment => `${comment.author.displayName}: ${comment.content ?? ''}`).join(' | '),
						description: thread.threadContext?.filePath,
					})),
				];
			}
			return [];
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			Logger.error(message, 'AzureDevOps');
			return [{ kind: 'detail', label: message }];
		}
	}

	private treeItem(node: Node): vscode.TreeItem {
		if (node.kind === 'query') {
			const item = new vscode.TreeItem(node.query.label, vscode.TreeItemCollapsibleState.Collapsed);
			item.iconPath = new vscode.ThemeIcon('filter');
			return item;
		}
		if (node.kind === 'notification') {
			const item = new vscode.TreeItem(`!${node.pr.pullRequestId} ${node.pr.title}`);
			item.iconPath = new vscode.ThemeIcon('bell-dot');
			item.description = node.pr.status;
			item.command = { command: 'azureDevOps.openNotification', title: vscode.l10n.t('Open Notification'), arguments: [node] };
			return item;
		}
		if (node.kind === 'repository') {
			const item = new vscode.TreeItem(`${node.client.remote.project}/${node.client.remote.repository}`, vscode.TreeItemCollapsibleState.Expanded);
			item.description = node.remoteName;
			item.tooltip = node.repository.rootUri.fsPath;
			item.iconPath = new vscode.ThemeIcon('repo');
			return item;
		}
		if (node.kind === 'pullRequest') {
			const item = new vscode.TreeItem(`!${node.pr.pullRequestId} ${node.pr.title}`, vscode.TreeItemCollapsibleState.Collapsed);
			item.description = node.pr.isDraft ? vscode.l10n.t('Draft') : node.pr.status;
			item.tooltip = node.pr.description;
			item.iconPath = new vscode.ThemeIcon(node.pr.status === 'completed' ? 'git-merge' : node.pr.isDraft ? 'git-pull-request-draft' : 'git-pull-request');
			item.contextValue = 'azurePullRequest';
			item.command = { command: 'azureDevOps.openPullRequest', title: vscode.l10n.t('Open Pull Request'), arguments: [node] };
			return item;
		}
		if (node.kind === 'workItem') {
			const item = new vscode.TreeItem(`#${node.item.id} ${node.item.fields['System.Title']}`);
			item.description = node.item.fields['System.State'];
			item.iconPath = new vscode.ThemeIcon('issues');
			item.command = { command: 'azureDevOps.workItemActions', title: vscode.l10n.t('Work Item Actions'), arguments: [node] };
			return item;
		}
		if (node.kind === 'file') {
			const item = new vscode.TreeItem(node.change.item.path);
			const key = JSON.stringify([this.reviewKey(node.parent), node.change.item.path]);
			const viewed = this.state.get<Record<string, string>>('azureDevOps.viewedFiles', {})[key] === node.iteration.sourceRefCommit.commitId;
			item.description = viewed ? vscode.l10n.t('Viewed: {0}', node.change.changeType) : node.change.changeType;
			item.iconPath = new vscode.ThemeIcon(viewed ? 'pass-filled' : 'file');
			item.contextValue = 'azureFile';
			item.command = { command: 'azureDevOps.openDiff', title: vscode.l10n.t('Open Changes'), arguments: [node] };
			return item;
		}
		const item = new vscode.TreeItem(node.label);
		item.description = node.description;
		if (node.url && /^https:\/\//i.test(node.url)) {
			item.command = { command: 'vscode.open', title: vscode.l10n.t('Open in Browser'), arguments: [vscode.Uri.parse(node.url)] };
		}
		return item;
	}

	private async pickPullRequest(): Promise<PullRequestNode | undefined> {
		const parent = await this.pickRepository();
		if (!parent) {
			return undefined;
		}
		const prs = await parent.client.pullRequests('all');
		const selected = await vscode.window.showQuickPick(prs.map(pr => ({ label: `!${pr.pullRequestId} ${pr.title}`, description: pr.status, pr })), { title: vscode.l10n.t('Select a pull request') });
		return selected ? { kind: 'pullRequest', parent, pr: selected.pr } : undefined;
	}

	private async createPullRequest(): Promise<void> {
		const parent = await this.pickRepository();
		if (!parent) {
			return;
		}
		const branch = parent.repository.state.HEAD?.name;
		if (!branch) {
			throw new Error(vscode.l10n.t('Check out a branch before creating a pull request.'));
		}
		const sourceMetadata = await parent.client.repository();
		let destination = parent;
		if (sourceMetadata.parentRepository) {
			const selected = await vscode.window.showQuickPick([
				{ label: vscode.l10n.t('Parent repository: {0}', sourceMetadata.parentRepository.name), fork: true },
				{ label: vscode.l10n.t('Current fork'), fork: false },
			], { title: vscode.l10n.t('Pull request destination') });
			if (!selected) {
				return;
			}
			if (selected.fork) {
				const remote = { ...parent.client.remote, project: sourceMetadata.parentRepository.project.name, repository: sourceMetadata.parentRepository.name };
				destination = { ...parent, client: new AzureClient(remote, () => this.authentication.authorization(remote)) };
			}
		}
		const metadata = destination === parent ? sourceMetadata : await destination.client.repository();
		const target = await vscode.window.showInputBox({ title: vscode.l10n.t('Target branch'), value: metadata.defaultBranch?.replace('refs/heads/', '') ?? 'main', validateInput: value => value.trim() ? undefined : vscode.l10n.t('Enter a branch.') });
		if (!target) {
			return;
		}
		if (target.replace('refs/heads/', '') === branch && destination === parent) {
			throw new Error(vscode.l10n.t('The source and target branches must differ.'));
		}
		const templates = await vscode.workspace.findFiles(new vscode.RelativePattern(parent.repository.rootUri,
			'{pull_request_template.md,.azuredevops/pull_request_template.md,docs/pull_request_template.md,.github/pull_request_template.md}'), undefined, 1);
		const template = templates[0] ? new TextDecoder().decode(await vscode.workspace.fs.readFile(templates[0])) : '';
		let defaults = { title: branch, description: template };
		if (this.titleProviders.size) {
			const selected = await vscode.window.showQuickPick([
				{ label: vscode.l10n.t('Write manually'), provider: undefined },
				...[...this.titleProviders].map(([title, provider]) => ({ label: title, provider })),
			], { title: vscode.l10n.t('Pull request title and description') });
			if (!selected) {
				return;
			}
			if (selected.provider) {
				const token = new vscode.CancellationTokenSource();
				try {
					const generated = await selected.provider.provideTitleAndDescription({ ...await this.generationContext(destination, target), template, compareBranch: branch }, token.token);
					if (!generated?.title.trim()) {
						throw new Error(vscode.l10n.t('The title provider did not return a title.'));
					}
					defaults = { title: generated.title, description: generated.description ?? template };
				} finally {
					token.dispose();
				}
			}
		}
		const title = await vscode.window.showInputBox({ title: vscode.l10n.t('Pull request title'), value: defaults.title, validateInput: value => value.trim() ? undefined : vscode.l10n.t('Enter a title.') });
		if (!title) {
			return;
		}
		const description = await this.editMarkdown(vscode.l10n.t('Pull request description'), defaults.description);
		if (description === undefined) {
			return;
		}
		const mode = await vscode.window.showQuickPick([vscode.l10n.t('Create'), vscode.l10n.t('Create Draft')], { title: vscode.l10n.t('Create pull request') });
		if (!mode) {
			return;
		}
		const push = await vscode.window.showWarningMessage(vscode.l10n.t('Push branch {0} to {1} and create a pull request?', branch, parent.remoteName), { modal: true }, vscode.l10n.t('Push and Create'));
		if (!push) {
			return;
		}
		await parent.repository.push(parent.remoteName, branch, true);
		const pr = await destination.client.createPullRequest(title, description, `refs/heads/${branch}`, target.startsWith('refs/heads/') ? target : `refs/heads/${target}`, mode === vscode.l10n.t('Create Draft'),
			destination === parent ? undefined : { repository: { id: sourceMetadata.id, project: { id: sourceMetadata.project.id } } });
		this.changed.fire(undefined);
		await this.pullRequestActions({ kind: 'pullRequest', parent: destination, pr });
	}

	private async editMarkdown(title: string, content: string): Promise<string | undefined> {
		const document = await vscode.workspace.openTextDocument({ language: 'markdown', content });
		await vscode.window.showTextDocument(document);
		const use = vscode.l10n.t('Use Description');
		const choice = await vscode.window.showInformationMessage(vscode.l10n.t('{0}: edit the opened Markdown document, then choose Use Description.', title), use, vscode.l10n.t('Cancel'));
		return choice === use ? document.getText() : undefined;
	}

	private async generationContext(parent: RepositoryNode, target: string): Promise<{ commitMessages: string[]; patches: { patch: string; fileUri: string; previousFileUri?: string }[] }> {
		const head = parent.repository.state.HEAD?.commit;
		if (!head) {
			throw new Error(vscode.l10n.t('Check out a committed source branch first.'));
		}
		const remote = await this.gitRemote(parent, parent.client.remote);
		await parent.repository.fetch(remote, target.startsWith('refs/heads/') ? target : `refs/heads/${target}`);
		const base = await parent.repository.getMergeBase('FETCH_HEAD', head);
		if (!base) {
			throw new Error(vscode.l10n.t('The branches do not have a common ancestor.'));
		}
		const [commits, changes] = await Promise.all([parent.repository.log({ range: `${base}..${head}`, maxEntries: 100 }), parent.repository.diffBetween(base, head)]);
		const patches = await Promise.all(changes.map(async change => ({
			patch: await parent.repository.diffBetween(base, head, change.uri.fsPath), fileUri: change.uri.toString(),
			previousFileUri: change.renameUri?.toString(),
		})));
		return { commitMessages: commits.map(commit => commit.message), patches };
	}
	private async gitRemote(parent: RepositoryNode, remote: AzureRemote): Promise<string> {
		const collections = vscode.workspace.getConfiguration('azureDevOps', parent.repository.rootUri).get<string[]>('serverCollections', []);
		const existing = parent.repository.state.remotes.find(candidate => {
			const parsed = parseAzureRemote(resolveGitUrlAlias(candidate.fetchUrl ?? '', this.gitConfigurations.get(parent.repository) ?? []), collections);
			return parsed && parsed.organizationUrl.toLowerCase() === remote.organizationUrl.toLowerCase()
				&& parsed.project.toLowerCase() === remote.project.toLowerCase() && parsed.repository.toLowerCase() === remote.repository.toLowerCase();
		});
		if (existing) {
			return existing.name;
		}
		const name = await vscode.window.showInputBox({
			title: vscode.l10n.t('Add a Git remote for this repository'),
			prompt: azureRepositoryUrl(remote),
			value: 'azure-review',
			validateInput: value => !/^[\w.-]+$/.test(value) || parent.repository.state.remotes.some(remote => remote.name === value)
				? vscode.l10n.t('Enter a new, unique remote name.') : undefined,
		});
		if (!name) {
			throw new Error(vscode.l10n.t('Checkout canceled: no matching Git remote.'));
		}
		await parent.repository.addRemote(name, azureRepositoryUrl(remote));
		return name;
	}

	private voteLabel(vote: number): string {
		switch (vote) {
			case 10: return vscode.l10n.t('Approve');
			case 5: return vscode.l10n.t('Approve with suggestions');
			case -5: return vscode.l10n.t('Wait for author');
			case -10: return vscode.l10n.t('Reject');
			default: return vscode.l10n.t('No vote');
		}
	}

	private async pullRequestActions(node?: PullRequestNode, actionLabel?: string): Promise<void> {
		node ??= await this.pickPullRequest();
		if (!node) {
			return;
		}
		const { client, repository } = node.parent;
		const pr = await client.pullRequest(node.pr.pullRequestId);
		node.pr = pr;
		const actions: { label: string; run: () => Promise<unknown> }[] = [
			{ label: vscode.l10n.t('View Overview and Discussion'), run: () => this.showOverview(node) },
			{ label: vscode.l10n.t('Open Discussion in Comments Panel'), run: () => this.showDiscussion(node) },
			{ label: vscode.l10n.t('Open in Browser'), run: async () => vscode.env.openExternal(vscode.Uri.parse(client.pullRequestUrl(pr.pullRequestId))) },
			{ label: vscode.l10n.t('Checkout'), run: async () => {
				if (![pr.repository.name.toLowerCase(), pr.repository.id.toLowerCase()].includes(client.remote.repository.toLowerCase())) {
					throw new Error(vscode.l10n.t('The pull request repository does not match the selected remote.'));
				}
				const remote = await this.gitRemote(node.parent, { ...client.remote, repository: pr.repository.name });
				await repository.fetch(remote, `refs/pull/${pr.pullRequestId}/merge`);
				await repository.checkout('FETCH_HEAD');
				await vscode.window.showInformationMessage(vscode.l10n.t('Checked out the pull request merge commit (detached HEAD). Use Git: Checkout to return to your branch. For authoring, check out the source branch {0}.', pr.sourceRefName.replace('refs/heads/', '')));
				Logger.appendLine(`Checked out pull request ${pr.pullRequestId} merge commit.`, 'AzureDevOps');
			} },
			{ label: vscode.l10n.t('Checkout Source Branch for Authoring'), run: async () => {
				const source = pr.forkSource?.repository ?? pr.repository;
				const sourceRef = pr.forkSource?.name ?? pr.sourceRefName;
				const remote = await this.gitRemote(node.parent, { ...client.remote, project: source.project.name, repository: source.name });
				const branch = await vscode.window.showInputBox({ title: vscode.l10n.t('Local review branch'), value: `azure-pr/${pr.pullRequestId}` });
				if (!branch) {
					return;
				}
				await repository.fetch(remote, sourceRef);
				await repository.createBranch(branch, true, 'FETCH_HEAD');
				await repository.setBranchUpstream(branch, `${remote}/${sourceRef.replace('refs/heads/', '')}`);
			} },
			{ label: vscode.l10n.t('View Branch Stack'), run: async () => {
				const stack = pullRequestStack(await client.pullRequests(), pr.pullRequestId);
				const selected = await vscode.window.showQuickPick(stack.map(member => ({ label: `!${member.pullRequestId} ${member.title}`, description: `${member.sourceRefName} -> ${member.targetRefName}`, member })), { title: vscode.l10n.t('Pull request stack (bottom to top)') });
				if (selected) {
					await this.pullRequestActions({ kind: 'pullRequest', parent: node.parent, pr: selected.member });
				}
			} },
			{ label: vscode.l10n.t('Complete Branch Stack'), run: async () => {
				const stack = pullRequestStack(await client.pullRequests(), pr.pullRequestId);
				if (await vscode.window.showWarningMessage(vscode.l10n.t('Complete {0} using merge commits, bottom to top? Policies remain enforced; branches are retained. A failure stops the remaining merges.', stack.map(pr => `!${pr.pullRequestId}`).join(', ')), { modal: true }, vscode.l10n.t('Complete Stack'))) {
					await completeStack(client, stack);
				}
			} },
			{ label: vscode.l10n.t('Change Target Branch'), run: async () => {
				const target = await vscode.window.showInputBox({ title: vscode.l10n.t('Target branch'), value: pr.targetRefName.replace('refs/heads/', '') });
				if (target?.trim()) {
					await client.updatePullRequest(pr.pullRequestId, { targetRefName: target.startsWith('refs/heads/') ? target : `refs/heads/${target}` });
				}
			} },
			{ label: vscode.l10n.t('Edit Title and Description'), run: async () => {
				const title = await vscode.window.showInputBox({ title: vscode.l10n.t('Title'), value: pr.title });
				if (!title?.trim()) {
					return;
				}
				const description = await this.editMarkdown(vscode.l10n.t('Description'), pr.description ?? '');
				if (description !== undefined) {
					await client.updatePullRequest(pr.pullRequestId, { title, description });
				}
			} },
			{ label: vscode.l10n.t('Request Extension Code Review'), run: async () => {
				if (repository.state.HEAD?.commit !== pr.lastMergeSourceCommit.commitId) {
					throw new Error(vscode.l10n.t('Check out the pull request source branch before requesting an extension code review.'));
				}
				if (!this.reviewerProviders.size) {
					throw new Error(vscode.l10n.t('No code review provider is registered. Enable an extension that provides code review.'));
				}
				const selected = await vscode.window.showQuickPick([...this.reviewerProviders].map(([title, provider]) => ({ label: title, provider })));
				if (!selected) {
					return;
				}
				const token = new vscode.CancellationTokenSource();
				try {
					const context = await this.generationContext(node.parent, pr.targetRefName);
					const result = await selected.provider.provideReviewerComments({ ...context, repositoryRoot: repository.rootUri.fsPath }, token.token);
					if (!result.succeeded) {
						throw new Error(vscode.l10n.t('The code review provider reported a failure.'));
					}
					if (result.disposable) {
						this.disposables.push(result.disposable);
					}
				} finally {
					token.dispose();
				}
			} },
			{ label: vscode.l10n.t('Comment'), run: async () => {
				const content = await vscode.window.showInputBox({ title: vscode.l10n.t('Pull request comment') });
				if (content?.trim()) {
					if (this.pendingReviews.get(this.reviewKey(node))) {
						await this.pendingReviews.add(this.reviewKey(node), { content });
					} else {
						await client.createThread(pr.pullRequestId, content);
					}
					await this.reloadComments();
				}
			} },
			{ label: vscode.l10n.t('Review'), run: async () => {
				if (this.pendingReviews.get(this.reviewKey(node))) {
					await this.submitReview(node);
					return;
				}
				const vote = await vscode.window.showQuickPick([10, 5, 0, -5, -10].map(value => ({ label: this.voteLabel(value), value })), { title: vscode.l10n.t('Submit review') });
				if (vote) {
					await client.vote(pr.pullRequestId, vote.value);
				}
			} },
			{ label: vscode.l10n.t('Start Pending Review'), run: async () => {
				const author = await client.currentUser();
				await this.pendingReviews.start(this.reviewKey(node), author.id, pr.lastMergeSourceCommit.commitId);
				await vscode.window.showInformationMessage(vscode.l10n.t('Review started. New comments are saved privately until you submit the review.'));
			} },
			{ label: vscode.l10n.t('Submit Pending Review'), run: () => this.submitReview(node) },
			{ label: vscode.l10n.t('Discard Pending Review'), run: async () => {
				if (await vscode.window.showWarningMessage(vscode.l10n.t('Discard all unpublished comments for this pull request?'), { modal: true }, vscode.l10n.t('Discard'))) {
					await this.pendingReviews.discard(this.reviewKey(node));
					await this.reloadComments();
				}
			} },
			{ label: vscode.l10n.t('Manage Reviewers'), run: async () => {
				const reviewer = await vscode.window.showQuickPick([
					{ label: vscode.l10n.t('Add reviewer'), id: '' },
					...pr.reviewers.map(value => ({ label: vscode.l10n.t('Remove {0}', value.displayName), id: value.id })),
				]);
				if (!reviewer) {
					return;
				}
				if (reviewer.id) {
					await client.removeReviewer(pr.pullRequestId, reviewer.id);
				} else {
					const users = await this.users(node.parent);
					const user = await vscode.window.showQuickPick(users.map(user => ({ label: user.displayName, description: user.uniqueName, user })), { title: vscode.l10n.t('Add reviewer') });
					if (user) {
						await client.vote(pr.pullRequestId, 0, user.user.id);
					}
				}
			} },
			{ label: vscode.l10n.t('Manage Labels'), run: async () => {
				const labels = await client.labels(pr.pullRequestId);
				const action = await vscode.window.showQuickPick([
					{ label: vscode.l10n.t('Add label'), id: '' },
					...labels.map(label => ({ label: vscode.l10n.t('Remove {0}', label.name), id: label.id })),
				]);
				if (!action) {
					return;
				}
				if (action.id) {
					await client.removeLabel(pr.pullRequestId, action.id);
				} else {
					const name = await vscode.window.showInputBox({ title: vscode.l10n.t('Label') });
					if (name?.trim()) {
						await client.addLabel(pr.pullRequestId, name.trim());
					}
				}
			} },
			{ label: vscode.l10n.t('Linked Work Items'), run: async () => {
				const items = await client.linkedWorkItems(pr.pullRequestId);
				const selected = await vscode.window.showQuickPick([
					{ label: vscode.l10n.t('Link a work item'), id: 0 },
					...items.map(item => ({ label: `#${item.id} ${item.fields['System.Title']}`, id: item.id })),
				]);
				if (!selected) {
					return;
				}
				if (selected.id) {
					await this.workItemActions({ kind: 'workItem', parent: node.parent, item: await client.workItem(selected.id) });
				} else {
					const id = await vscode.window.showInputBox({ title: vscode.l10n.t('Work item ID'), validateInput: value => /^[1-9]\d*$/.test(value) ? undefined : vscode.l10n.t('Enter a positive work item ID.') });
					if (id) {
						await client.linkWorkItem(pr, Number(id));
					}
				}
			} },
			{ label: vscode.l10n.t('View Branch Policies'), run: async () => {
				const policies = await client.policies(pr);
				const content = policies.map(policy => `${policy.configuration.type.displayName}: ${policy.status}${policy.configuration.isBlocking ? ' (required)' : ''}`).join('\n');
				await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: content || vscode.l10n.t('No branch policies.'), language: 'plaintext' }));
			} },
		];
		if (pr.status === 'active') {
			actions.push(
				{ label: pr.isDraft ? vscode.l10n.t('Publish') : vscode.l10n.t('Convert to Draft'), run: () => client.updatePullRequest(pr.pullRequestId, { isDraft: !pr.isDraft }) },
				{ label: vscode.l10n.t('Complete'), run: () => this.complete(node, false) },
				{ label: vscode.l10n.t('Set Auto-complete'), run: () => this.complete(node, true) },
				{ label: vscode.l10n.t('Abandon'), run: async () => {
					if (await vscode.window.showWarningMessage(vscode.l10n.t('Abandon pull request !{0}?', pr.pullRequestId), { modal: true }, vscode.l10n.t('Abandon'))) {
						await client.updatePullRequest(pr.pullRequestId, { status: 'abandoned' });
					}
				} },
			);
			if (pr.autoCompleteSetBy) {
				actions.push({ label: vscode.l10n.t('Cancel Auto-complete'), run: () => client.updatePullRequest(pr.pullRequestId, { autoCompleteSetBy: null }) });
			}
		} else if (pr.status === 'abandoned') {
			actions.push({ label: vscode.l10n.t('Reactivate'), run: () => client.updatePullRequest(pr.pullRequestId, { status: 'active' }) });
		}
		const action = actionLabel ? actions.find(action => action.label === actionLabel)
			: await vscode.window.showQuickPick(actions, { title: `!${pr.pullRequestId} ${pr.title}` });
		if (actionLabel && !action) {
			throw new Error(vscode.l10n.t('This action is no longer available. Refresh the pull request.'));
		}
		if (action) {
			await action.run();
			this.changed.fire(undefined);
		}
	}

	private async complete(node: PullRequestNode, autoComplete: boolean): Promise<void> {
		const strategy = await vscode.window.showQuickPick([
			{ label: vscode.l10n.t('Merge (no fast-forward)'), value: 'noFastForward' },
			{ label: vscode.l10n.t('Squash'), value: 'squash' },
			{ label: vscode.l10n.t('Rebase and fast-forward'), value: 'rebase' },
			{ label: vscode.l10n.t('Rebase with merge commit'), value: 'rebaseMerge' },
		], { title: vscode.l10n.t('Merge strategy') });
		if (!strategy) {
			return;
		}
		const deletion = await vscode.window.showQuickPick([
			{ label: vscode.l10n.t('Keep source branch'), value: false },
			{ label: vscode.l10n.t('Delete source branch'), value: true },
		]);
		if (!deletion) {
			return;
		}
		const confirm = await vscode.window.showWarningMessage(vscode.l10n.t('Complete pull request !{0}{1}? Branch policies remain enforced.', node.pr.pullRequestId, autoComplete ? vscode.l10n.t(' automatically when policies pass') : ''), { modal: true }, vscode.l10n.t('Confirm'));
		if (confirm) {
			await node.parent.client.completePullRequest(await node.parent.client.pullRequest(node.pr.pullRequestId), strategy.value, deletion.value, autoComplete);
		}
	}

	private document(file: FileNode, side: 'left' | 'right'): vscode.Uri {
		const change = file.change;
		const empty = side === 'left' ? /(^|, )add($|,)/i.test(change.changeType) : /(^|, )delete($|,)/i.test(change.changeType);
		const path = side === 'left' ? change.originalPath ?? change.item.path : change.item.path;
		const uri = vscode.Uri.from({ scheme: 'azure-review', authority: String(++this.nextDocument), path, query: side });
		this.documents.set(uri.toString(), {
			file, side, path, empty,
			commit: side === 'left' ? file.iteration.commonRefCommit.commitId : file.iteration.sourceRefCommit.commitId,
		});
		return uri;
	}

	private async showOverview(node: PullRequestNode): Promise<void> {
		const key = this.reviewKey(node);
		const existing = this.overviewPanels.get(key);
		if (existing) {
			existing.overview.panel.reveal(vscode.ViewColumn.Active);
			await existing.overview.refresh();
			return;
		}
		const extensionUri = this.context.extensionUri;
		if (!extensionUri) {
			throw new Error(vscode.l10n.t('The extension installation location is unavailable.'));
		}
		const panel = vscode.window.createWebviewPanel('azureDevOps.pullRequestOverview', `!${node.pr.pullRequestId} ${node.pr.title}`,
			vscode.ViewColumn.Active, {
				enableScripts: true,
				localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
			});
		const { client } = node.parent;
		const overview = new AzurePullRequestOverview(panel, extensionUri, {
			load: async () => {
				const [details, statuses, labels, workItems, viewer] = await Promise.all([
					client.reviewDetails(node.pr.pullRequestId), client.statuses(node.pr.pullRequestId), client.labels(node.pr.pullRequestId),
					client.linkedWorkItems(node.pr.pullRequestId), client.currentUser(),
				]);
				node.pr = details.pullRequest;
				return { ...details, statuses, labels, workItems, policies: await client.policies(details.pullRequest),
					viewer: viewer.id, pending: this.pendingReviews.get(key), url: client.pullRequestUrl(node.pr.pullRequestId) };
			},
			action: async action => {
				const labels: Record<Exclude<OverviewAction, 'actions' | 'draft'>, string> = {
					complete: vscode.l10n.t('Complete'), autoComplete: vscode.l10n.t('Set Auto-complete'), checkout: vscode.l10n.t('Checkout'),
					edit: vscode.l10n.t('Edit Title and Description'), reviewers: vscode.l10n.t('Manage Reviewers'), labels: vscode.l10n.t('Manage Labels'),
					workItems: vscode.l10n.t('Linked Work Items'), abandon: vscode.l10n.t('Abandon'), reactivate: vscode.l10n.t('Reactivate'),
					cancelAutoComplete: vscode.l10n.t('Cancel Auto-complete'), review: vscode.l10n.t('Review'),
					startReview: vscode.l10n.t('Start Pending Review'), submitReview: vscode.l10n.t('Submit Pending Review'),
					discardReview: vscode.l10n.t('Discard Pending Review'), discussion: vscode.l10n.t('Open Discussion in Comments Panel'),
				};
				await this.pullRequestActions(node, action === 'actions' ? undefined : action === 'draft'
					? node.pr.isDraft ? vscode.l10n.t('Publish') : vscode.l10n.t('Convert to Draft') : labels[action]);
			},
			openFile: async path => {
				const details = await client.reviewDetails(node.pr.pullRequestId);
				const change = details.changes.find(change => change.item.path === path && !change.item.isFolder);
				if (!change || !details.iteration) {
					throw new Error(vscode.l10n.t('The changed file is no longer available. Refresh the pull request.'));
				}
				node.pr = details.pullRequest;
				await this.openDiff({ kind: 'file', parent: node, change, iteration: details.iteration });
			},
			comment: async (content, threadId) => {
				const thread = threadId === undefined ? undefined : (await client.threads(node.pr.pullRequestId)).find(thread => thread.id === threadId && !thread.isDeleted);
				if (threadId !== undefined && !thread) {
					throw new Error(vscode.l10n.t('The discussion no longer exists. Refresh the pull request.'));
				}
				const parentCommentId = thread?.comments.find(comment => !comment.parentCommentId)?.id;
				const pending = this.pendingReviews.get(key);
				if (pending) {
					if ((await client.currentUser()).id !== pending.author) {
						throw new Error(vscode.l10n.t('The pending review belongs to another account.'));
					}
					await this.pendingReviews.add(key, { content, threadId, parentCommentId });
				} else if (thread) {
					await client.reply(node.pr.pullRequestId, thread.id, content, parentCommentId);
				} else {
					await client.createThread(node.pr.pullRequestId, content);
				}
			},
			changeThread: async (id, resolved) => { await client.resolveThread(node.pr.pullRequestId, id, resolved); },
			changeComment: async (threadId, id, action) => {
				const thread = (await client.threads(node.pr.pullRequestId)).find(thread => thread.id === threadId && !thread.isDeleted);
				const comment = thread?.comments.find(comment => comment.id === id && !comment.isDeleted);
				const viewer = await client.currentUser();
				if (!comment || (action !== 'like' && viewer.id !== comment.author.id)) {
					throw new Error(vscode.l10n.t('This comment is unavailable or belongs to another user.'));
				}
				if (action === 'like') {
					await client.likeComment(node.pr.pullRequestId, threadId, id, !comment.usersLiked?.some(user => user.id === viewer.id));
				} else if (action === 'edit') {
					const content = await vscode.window.showInputBox({ title: vscode.l10n.t('Edit comment'), value: comment.content });
					if (content?.trim()) {
						await client.updateComment(node.pr.pullRequestId, threadId, id, content);
					}
				} else if (await vscode.window.showWarningMessage(vscode.l10n.t('Delete this comment?'), { modal: true }, vscode.l10n.t('Delete'))) {
					await client.deleteComment(node.pr.pullRequestId, threadId, id);
				}
			},
			changeDraft: async (id, remove) => {
				const pending = this.pendingReviews.get(key);
				const draft = pending?.comments.find(comment => comment.id === id);
				if (!draft || (await client.currentUser()).id !== pending?.author) {
					throw new Error(vscode.l10n.t('The pending comment is unavailable or belongs to another account.'));
				}
				if (remove) {
					await this.pendingReviews.edit(key, id);
				} else {
					const content = await vscode.window.showInputBox({ title: vscode.l10n.t('Edit pending comment'), value: draft.content });
					if (content?.trim()) {
						await this.pendingReviews.edit(key, id, content);
					}
				}
			},
			changed: async () => {
				await this.reloadComments();
				this.changed.fire(undefined);
			},
			report: error => this.report(error),
		});
		this.overviewPanels.set(key, { overview, node });
		this.disposables.push(panel.onDidDispose(() => {
			this.overviewPanels.delete(key);
		}));
		await overview.refresh();
	}

	private async showDiscussion(node: PullRequestNode): Promise<void> {
		const { client } = node.parent;
		const [pr, statuses, labels] = await Promise.all([client.pullRequest(node.pr.pullRequestId), client.statuses(node.pr.pullRequestId), client.labels(node.pr.pullRequestId)]);
		node.pr = pr;
		const content = [
			`# !${pr.pullRequestId} ${pr.title}`,
			`${pr.status}${pr.isDraft ? ' (draft)' : ''} | ${pr.sourceRefName} -> ${pr.targetRefName}`,
			`[${vscode.l10n.t('Open in Azure DevOps')}](${client.pullRequestUrl(pr.pullRequestId)})`,
			pr.description ?? '',
			`## ${vscode.l10n.t('Reviewers')}`,
			...pr.reviewers.map(reviewer => `- ${reviewer.displayName}: ${this.voteLabel(reviewer.vote ?? 0)}`),
			`## ${vscode.l10n.t('Labels')}`, labels.map(label => label.name).join(', '),
			`## ${vscode.l10n.t('Checks')}`, ...statuses.map(status => `- ${status.context.name}: ${status.state} ${status.description ?? ''}`),
			vscode.l10n.t('Use the Comments panel to reply, edit, resolve, and react to discussion. Use Pull Request Actions to manage this pull request.'),
		].join('\n\n');
		const document = await vscode.workspace.openTextDocument({ content, language: 'markdown' });
		this.overviews.set(document.uri.toString(), node);
		await vscode.window.showTextDocument(document);
		await this.loadOverviewComments(node, document.uri);
	}

	private async loadOverviewComments(pr: PullRequestNode, uri: vscode.Uri): Promise<void> {
		const [values, viewer] = await Promise.all([pr.parent.client.threads(pr.pr.pullRequestId), pr.parent.client.currentUser()]);
		this.viewers.set(pr.parent.client.remote.organizationUrl, viewer.id);
		for (const [thread] of this.bindings) {
			if (thread.uri.toString() === uri.toString()) {
				thread.dispose();
				this.bindings.delete(thread);
			}
		}
		for (const value of values.filter(thread => !thread.isDeleted)) {
			const thread = this.commentController.createCommentThread(uri, undefined, []);
			this.setThread(thread, value, pr);
			if (value.threadContext?.filePath) {
				thread.label = value.threadContext.filePath;
			}
		}
		for (const draft of this.pendingReviews.get(this.reviewKey(pr))?.comments ?? []) {
			if (!draft.context && draft.threadId === undefined) {
				this.showDraft(this.commentController.createCommentThread(uri, undefined, []), pr, draft);
			}
		}
	}

	private async openDiff(file: FileNode): Promise<void> {
		const left = this.document(file, 'left');
		const right = this.document(file, 'right');
		await vscode.commands.executeCommand('vscode.diff', left, right, `!${file.parent.pr.pullRequestId} ${file.change.item.path}`);
		await this.loadComments(file.parent, left, right);
	}

	private setThread(thread: AzureThread, value: ReviewThread, pr: PullRequestNode): void {
		this.bindings.set(thread, { pr, thread: value });
		thread.label = vscode.l10n.t('Azure DevOps');
		thread.contextValue = [2, 3, 4, 5, 'fixed', 'wontFix', 'closed', 'byDesign'].includes(value.status) ? 'azureResolved' : 'azureActive';
		thread.state = thread.contextValue === 'azureResolved' ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
		thread.collapsibleState = thread.state === vscode.CommentThreadState.Resolved ? vscode.CommentThreadCollapsibleState.Collapsed : vscode.CommentThreadCollapsibleState.Expanded;
		thread.comments = value.comments.filter(comment => !comment.isDeleted && comment.content).map((comment): AzureComment => ({
			id: comment.id, thread, body: new vscode.MarkdownString(comment.content!.replace(/\n*<!-- azdo-review:[\w-]+:-\d+ -->/g, '')), mode: vscode.CommentMode.Preview,
			author: { name: comment.author.displayName }, contextValue: /^```suggestion[ \t]*\r?$/m.test(comment.content!) ? 'azureSuggestion' : 'azureComment',
			reactions: [{
				label: vscode.l10n.t('Like'),
				iconPath: vscode.Uri.parse(`data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><text x="0" y="12" fill="#808080" font-size="12">+1</text></svg>')}`),
				count: comment.usersLiked?.length ?? 0,
				authorHasReacted: comment.usersLiked?.some(user => user.id === this.viewers.get(pr.parent.client.remote.organizationUrl)) ?? false,
			}],
		}));
		for (const draft of this.pendingReviews.get(this.reviewKey(pr))?.comments ?? []) {
			if (draft.threadId === value.id) {
				this.showDraft(thread, pr, draft);
			}
		}
	}

	private reviewKey(pr: PullRequestNode): string {
		return JSON.stringify([pr.parent.client.remote, pr.pr.pullRequestId]);
	}

	private showDraft(thread: AzureThread, pr: PullRequestNode, draft: DraftComment): void {
		if (!this.bindings.has(thread)) {
			this.bindings.set(thread, { pr });
		}
		if (!this.bindings.get(thread)?.thread) {
			thread.canReply = false;
		}
		const comment: AzureComment = {
			id: draft.id, thread, body: new vscode.MarkdownString(draft.content), mode: vscode.CommentMode.Preview,
			author: { name: vscode.l10n.t('You') }, label: vscode.l10n.t('Pending'), contextValue: 'azureDraft',
		};
		thread.comments = [...thread.comments, comment];
		thread.label = vscode.l10n.t('Pending review');
	}

	private async startReview(reply: vscode.CommentReply): Promise<void> {
		if (!reply.text.trim()) {
			throw new Error(vscode.l10n.t('Enter a comment.'));
		}
		const pr = this.bindings.get(reply.thread)?.pr ?? this.documents.get(reply.thread.uri.toString())?.file.parent;
		if (!pr) {
			throw new Error(vscode.l10n.t('Reopen the review before commenting.'));
		}
		const current = await pr.parent.client.pullRequest(pr.pr.pullRequestId);
		const displayedCommit = this.documents.get(reply.thread.uri.toString())?.file.iteration.sourceRefCommit.commitId ?? pr.pr.lastMergeSourceCommit.commitId;
		if (displayedCommit !== current.lastMergeSourceCommit.commitId) {
			throw new Error(vscode.l10n.t('The source branch changed. Reopen the current pull request before starting a review.'));
		}
		const author = await pr.parent.client.currentUser();
		await this.pendingReviews.start(this.reviewKey(pr), author.id, current.lastMergeSourceCommit.commitId);
		await this.reply(reply);
	}

	private async submitReview(node?: PullRequestNode): Promise<void> {
		node ??= await this.pickPullRequest();
		if (!node) {
			return;
		}
		const key = this.reviewKey(node);
		if (!this.pendingReviews.get(key)) {
			throw new Error(vscode.l10n.t('There is no pending review for this pull request.'));
		}
		const decision = await vscode.window.showQuickPick([
			{ label: vscode.l10n.t('Comment only'), vote: undefined },
			...[10, 5, 0, -5, -10].map(vote => ({ label: this.voteLabel(vote), vote })),
		], { title: vscode.l10n.t('Submit pending review') });
		if (!decision) {
			return;
		}
		const { client } = node.parent;
		const current = await client.pullRequest(node.pr.pullRequestId);
		const author = await client.currentUser();
		const pending = this.pendingReviews.get(key)!;
		if (decision.vote !== undefined && pending.commit !== current.lastMergeSourceCommit.commitId) {
			throw new Error(vscode.l10n.t('The source branch changed. Submit comments only, or discard and restart the review before voting.'));
		}
		const existing = await client.threads(current.pullRequestId);
		await this.pendingReviews.submit(key, author.id, pending.commit, async (draft, marker) => {
			if (existing.some(thread => thread.comments.some(comment => comment.author.id === author.id && comment.content?.includes(marker)))) {
				return;
			}
			const content = `${draft.content}\n\n${marker}`;
			if (draft.threadId !== undefined) {
				await client.reply(current.pullRequestId, draft.threadId, content, draft.parentCommentId);
			} else {
				await client.createThread(current.pullRequestId, content, draft.context, draft.iteration, draft.changeTrackingId);
			}
		}, async () => {
			if (decision.vote !== undefined) {
				const latest = await client.pullRequest(current.pullRequestId);
				if (latest.lastMergeSourceCommit.commitId !== pending.commit || (await client.currentUser()).id !== author.id) {
					throw new Error(vscode.l10n.t('The source branch or account changed during submission. Published comments were saved, but no vote was sent.'));
				}
				await client.vote(current.pullRequestId, decision.vote, author.id);
			}
		});
		await this.reloadComments();
		this.changed.fire(undefined);
	}

	private async loadComments(pr: PullRequestNode, left: vscode.Uri, right: vscode.Uri): Promise<void> {
		const document = this.documents.get(right.toString());
		if (!document) {
			throw new Error(vscode.l10n.t('Reopen the review before loading comments.'));
		}
		const [values, viewer] = await Promise.all([
			pr.parent.client.threads(pr.pr.pullRequestId, document.file.iteration.id),
			pr.parent.client.currentUser(),
		]);
		this.viewers.set(pr.parent.client.remote.organizationUrl, viewer.id);
		for (const [thread] of this.bindings) {
			if (thread.uri.toString() === left.toString() || thread.uri.toString() === right.toString()) {
				thread.dispose();
				this.bindings.delete(thread);
			}
		}
		for (const value of values) {
			const context = value.threadContext;
			if (value.isDeleted || !context || context.filePath !== document.file.change.item.path) {
				continue;
			}
			const position = context.rightFileStart ?? context.leftFileStart;
			const end = context.rightFileEnd ?? context.leftFileEnd ?? position;
			if (position && end) {
				const range = new vscode.Range(Math.max(0, position.line - 1), 0, Math.max(0, end.line - 1), 0);
				const thread = this.commentController.createCommentThread(context.rightFileStart ? right : left, range, []);
				this.setThread(thread, value, pr);
			} else {
				this.setThread(this.commentController.createCommentThread(right, undefined, []), value, pr);
			}
		}
		for (const draft of this.pendingReviews.get(this.reviewKey(pr))?.comments ?? []) {
			if (draft.threadId === undefined && draft.context?.filePath === document.file.change.item.path && draft.iteration === document.file.iteration.id) {
				const start = draft.context.rightFileStart ?? draft.context.leftFileStart;
				const end = draft.context.rightFileEnd ?? draft.context.leftFileEnd ?? start;
				if (start && end) {
					const thread = this.commentController.createCommentThread(draft.context.rightFileStart ? right : left, new vscode.Range(start.line - 1, 0, end.line - 1, 0), []);
					this.showDraft(thread, pr, draft);
				} else {
					this.showDraft(this.commentController.createCommentThread(right, undefined, []), pr, draft);
				}
			}
		}
	}

	private async reloadComments(): Promise<void> {
		for (const [uri, pr] of this.overviews) {
			await this.loadOverviewComments(pr, vscode.Uri.parse(uri));
		}
		const loaded = new Set<string>();
		for (const [key, document] of this.documents) {
			if (document.side !== 'right') {
				continue;
			}
			const right = vscode.Uri.parse(key);
			const left = [...this.documents].find(([, other]) => other.side === 'left' && other.file === document.file);
			if (left && !loaded.has(key)) {
				loaded.add(key);
				await this.loadComments(document.file.parent, vscode.Uri.parse(left[0]), right);
			}
		}
	}

	private async reply(reply: vscode.CommentReply): Promise<void> {
		if (!reply.text.trim()) {
			throw new Error(vscode.l10n.t('Enter a comment.'));
		}
		const binding = this.bindings.get(reply.thread);
		const document = this.documents.get(reply.thread.uri.toString());
		const pr = binding?.pr ?? document?.file.parent;
		const pending = pr && this.pendingReviews.get(this.reviewKey(pr));
		if (pr && pending) {
			if (!binding?.thread && (!document || reply.thread.comments.length)) {
				throw new Error(vscode.l10n.t('Submit the pending thread before replying to it.'));
			}
			if (document && document.file.iteration.sourceRefCommit.commitId !== pending.commit) {
				throw new Error(vscode.l10n.t('This file is from a different source commit than the pending review. Reopen the reviewed iteration.'));
			}
			const start = { line: (reply.thread.range?.start.line ?? 0) + 1, offset: 1 };
			const end = { line: (reply.thread.range?.end.line ?? 0) + 1, offset: 1 };
			const draft = await this.pendingReviews.add(this.reviewKey(pr), {
				content: reply.text, threadId: binding?.thread?.id,
				parentCommentId: binding?.thread?.comments.find(comment => !comment.parentCommentId)?.id,
				context: binding?.thread ? undefined : {
					filePath: document!.file.change.item.path,
					...(reply.thread.range ? document!.side === 'right' ? { rightFileStart: start, rightFileEnd: end } : { leftFileStart: start, leftFileEnd: end } : {}),
				},
				iteration: document?.file.iteration.id, changeTrackingId: document?.file.change.changeTrackingId,
			});
			this.showDraft(reply.thread, pr, draft);
			return;
		}
		if (binding?.thread) {
			const parent = binding.thread.comments.find(comment => !comment.parentCommentId)?.id ?? 1;
			const result = await binding.pr.parent.client.reply(binding.pr.pr.pullRequestId, binding.thread.id, reply.text, parent);
			this.setThread(reply.thread, { ...binding.thread, comments: [...binding.thread.comments, result] }, binding.pr);
		} else {
			const document = this.documents.get(reply.thread.uri.toString());
			if (!document) {
				throw new Error(vscode.l10n.t('Reopen the review before commenting.'));
			}
			const pr = document.file.parent;
			const start = { line: (reply.thread.range?.start.line ?? 0) + 1, offset: 1 };
			const end = { line: (reply.thread.range?.end.line ?? 0) + 1, offset: 1 };
			const thread = await pr.parent.client.createThread(pr.pr.pullRequestId, reply.text, {
				filePath: document.file.change.item.path,
				...(reply.thread.range ? document.side === 'right' ? { rightFileStart: start, rightFileEnd: end } : { leftFileStart: start, leftFileEnd: end } : {}),
			}, document.file.iteration.id, document.file.change.changeTrackingId);
			this.setThread(reply.thread, thread, pr);
		}
	}

	private async resolveThread(thread: AzureThread, resolved: boolean): Promise<void> {
		const binding = this.bindings.get(thread);
		if (!binding?.thread) {
			throw new Error(vscode.l10n.t('Publish the comment before changing its resolution.'));
		}
		this.setThread(thread, await binding.pr.parent.client.resolveThread(binding.pr.pr.pullRequestId, binding.thread.id, resolved), binding.pr);
	}

	private async applySuggestion(comment: AzureComment): Promise<void> {
		const document = this.documents.get(comment.thread.uri.toString());
		const binding = this.bindings.get(comment.thread);
		const context = binding?.thread?.threadContext;
		if (!document || document.side !== 'right' || !context?.rightFileStart) {
			throw new Error(vscode.l10n.t('Open the suggestion on the source side of its pull request diff first.'));
		}
		const repository = document.file.parent.parent.repository;
		if (repository.state.HEAD?.commit !== document.commit) {
			throw new Error(vscode.l10n.t('Check out the reviewed source commit before applying a suggestion.'));
		}
		if (document.path.split(/[\\/]/).some(segment => segment === '..' || segment === '.')) {
			throw new Error(vscode.l10n.t('The suggestion has an invalid file path.'));
		}
		const replacement = suggestionText(typeof comment.body === 'string' ? comment.body : comment.body.value);
		const original = await document.file.parent.parent.client.file(document.path, document.commit);
		const working = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(repository.rootUri, document.path));
		if (working.isDirty || working.getText().replace(/\r\n/g, '\n') !== original.replace(/\r\n/g, '\n')) {
			throw new Error(vscode.l10n.t('The working file differs from the reviewed source. Keep or discard local changes before applying the suggestion.'));
		}
		const start = context.rightFileStart.line - 1;
		const end = (context.rightFileEnd ?? context.rightFileStart).line - 1;
		if (start < 0 || end < start || end >= working.lineCount) {
			throw new Error(vscode.l10n.t('The suggestion range no longer matches the source file.'));
		}
		const edit = new vscode.WorkspaceEdit();
		edit.replace(working.uri, new vscode.Range(start, 0, end, working.lineAt(end).text.length),
			replacement.replace(/\r?\n/g, working.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n'));
		if (!await vscode.workspace.applyEdit(edit)) {
			throw new Error(vscode.l10n.t('VS Code could not apply the suggestion. No commit was created.'));
		}
	}

	private async editComment(comment: AzureComment): Promise<void> {
		const binding = this.bindings.get(comment.thread);
		if (binding && comment.id < 0) {
			const content = await vscode.window.showInputBox({ title: vscode.l10n.t('Edit pending comment'), value: typeof comment.body === 'string' ? comment.body : comment.body.value });
			if (content?.trim()) {
				await this.pendingReviews.edit(this.reviewKey(binding.pr), comment.id, content);
				comment.thread.comments = comment.thread.comments.map(value => value === comment ? { ...comment, body: new vscode.MarkdownString(content) } : value);
			}
			return;
		}
		if (!binding?.thread) {
			throw new Error(vscode.l10n.t('Reopen the review before editing.'));
		}
		const content = await vscode.window.showInputBox({ title: vscode.l10n.t('Edit comment'), value: typeof comment.body === 'string' ? comment.body : comment.body.value });
		if (content?.trim()) {
			const updated = await binding.pr.parent.client.updateComment(binding.pr.pr.pullRequestId, binding.thread.id, comment.id, content);
			this.setThread(comment.thread, { ...binding.thread, comments: binding.thread.comments.map(value => value.id === comment.id ? updated : value) }, binding.pr);
		}
	}

	private async deleteComment(comment: AzureComment): Promise<void> {
		const binding = this.bindings.get(comment.thread);
		if (binding && comment.id < 0) {
			await this.pendingReviews.edit(this.reviewKey(binding.pr), comment.id);
			comment.thread.comments = comment.thread.comments.filter(value => value !== comment);
			if (!comment.thread.comments.length) {
				comment.thread.dispose();
				this.bindings.delete(comment.thread);
			}
			return;
		}
		if (!binding?.thread) {
			throw new Error(vscode.l10n.t('Reopen the review before deleting.'));
		}
		if (await vscode.window.showWarningMessage(vscode.l10n.t('Delete this comment?'), { modal: true }, vscode.l10n.t('Delete'))) {
			await binding.pr.parent.client.deleteComment(binding.pr.pr.pullRequestId, binding.thread.id, comment.id);
			this.setThread(comment.thread, { ...binding.thread, comments: binding.thread.comments.filter(value => value.id !== comment.id) }, binding.pr);
		}
	}

	private async createWorkItem(initialTitle?: string): Promise<void> {
		const parent = await this.pickRepository();
		if (!parent) {
			return;
		}
		const type = await vscode.window.showInputBox({ title: vscode.l10n.t('Work item type'), value: 'Issue', prompt: vscode.l10n.t('Use a type supported by your project process, such as Issue, Bug, Task, or User Story.') });
		if (!type?.trim()) {
			return;
		}
		const title = await vscode.window.showInputBox({ title: vscode.l10n.t('Work item title'), value: initialTitle ?? vscode.window.activeTextEditor?.document.getText(vscode.window.activeTextEditor.selection) });
		if (!title?.trim()) {
			return;
		}
		const item = await parent.client.saveWorkItem({ 'System.Title': title }, type);
		this.workItemCache.clear();
		this.changed.fire(undefined);
		await this.workItemActions({ kind: 'workItem', parent, item });
	}

	private async workItemActions(node?: WorkItemNode): Promise<void> {
		if (!node) {
			const parent = await this.pickRepository();
			if (!parent) {
				return;
			}
			const id = await vscode.window.showInputBox({ title: vscode.l10n.t('Work item ID'), validateInput: value => /^[1-9]\d*$/.test(value) ? undefined : vscode.l10n.t('Enter a positive work item ID.') });
			if (!id) {
				return;
			}
			node = { kind: 'workItem', parent, item: await parent.client.workItem(Number(id)) };
		}
		const { client, repository } = node.parent;
		const item = await client.workItem(node.item.id);
		const action = await vscode.window.showQuickPick([
			{ label: vscode.l10n.t('View Details and Comments'), id: 'details' },
			{ label: vscode.l10n.t('Open in Browser'), id: 'open' },
			{ label: vscode.l10n.t('Start Working on Work Item'), id: 'branch' },
			{ label: vscode.l10n.t('Edit Title'), id: 'System.Title' },
			{ label: vscode.l10n.t('Edit State'), id: 'System.State' },
			{ label: vscode.l10n.t('Edit Description (HTML)'), id: 'System.Description' },
			{ label: vscode.l10n.t('Assign to User (email)'), id: 'System.AssignedTo' },
			{ label: vscode.l10n.t('Edit Tags'), id: 'System.Tags' },
			{ label: vscode.l10n.t('Comment'), id: 'comment' },
		], { title: `#${item.id} ${item.fields['System.Title']}` });
		if (!action) {
			return;
		}
		if (action.id === 'details') {
			const comments = await client.workItemComments(item.id);
			const content = [
				`# ${item.id} ${item.fields['System.Title']}`,
				`${item.fields['System.WorkItemType']} - ${item.fields['System.State']}`,
				item.fields['System.Description'] ?? '',
				...comments.map(comment => `${comment.createdBy.displayName}:\n${comment.text}`),
			].join('\n\n');
			const document = await vscode.workspace.openTextDocument({ content, language: 'markdown' });
			this.workItemDocuments.set(document.uri.toString(), node);
			await vscode.window.showTextDocument(document);
		} else if (action.id === 'open') {
			await vscode.env.openExternal(vscode.Uri.parse(client.workItemUrl(item.id)));
		} else if (action.id === 'branch') {
			const branch = await vscode.window.showInputBox({ title: vscode.l10n.t('New branch name'), value: `work-item/${item.id}` });
			if (branch) {
				await repository.createBranch(branch, true);
				repository.inputBox.value = `AB#${item.id} `;
			}
		} else {
			const value = await vscode.window.showInputBox({ title: action.label, value: action.id === 'System.Title' ? item.fields['System.Title'] : action.id === 'System.State' ? item.fields['System.State'] : action.id === 'System.Tags' ? item.fields['System.Tags'] : action.id === 'System.Description' ? item.fields['System.Description'] : undefined });
			if (value !== undefined) {
				if (action.id === 'comment') {
					if (!value.trim()) {
						throw new Error(vscode.l10n.t('Enter a comment.'));
					}
					await client.workItemComment(item.id, value);
				} else {
					await client.saveWorkItem({ [action.id]: value }, undefined, item.id);
				}
			}
		}
		this.workItemCache.clear();
		this.changed.fire(undefined);
	}
}

export async function activateAzure(context: vscode.ExtensionContext): Promise<AzureIntegration> {
	const integration = new AzureIntegration(context);
	context.subscriptions.push(integration, Logger);
	await integration.initialize();
	return integration;
}
