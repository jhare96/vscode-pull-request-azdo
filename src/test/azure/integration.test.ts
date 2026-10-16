/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createSandbox, SinonSandbox, SinonStub } from 'sinon';
import * as vscode from 'vscode';
import { IGit } from '../../api/api';
import { AzureClient, PullRequest, ReviewThread } from '../../azure/client';
import { AzureIntegration } from '../../azure/extension';
import Logger from '../../common/logger';
import { BuiltinGitProvider } from '../../gitProviders/builtinGit';
import { InMemoryMemento } from '../mocks/inMemoryMemento';
import { MockRepository } from '../mocks/mockRepository';

describe('Azure DevOps review integration', () => {
	let sandbox: SinonSandbox;
	let integration: AzureIntegration;
	let provider: vscode.TextDocumentContentProvider;
	let controller: vscode.CommentController;
	let commands: Map<string, (...args: unknown[]) => unknown>;
	let threads: vscode.CommentThread[];
	const disposable = { dispose() { } };
	const pr: PullRequest = {
		pullRequestId: 42, title: 'Example', status: 'active', isDraft: false, createdBy: { id: 'user', displayName: 'User' },
		sourceRefName: 'refs/heads/feature', targetRefName: 'refs/heads/main', reviewers: [],
		lastMergeSourceCommit: { commitId: 'source' }, lastMergeTargetCommit: { commitId: 'target' },
		repository: { id: 'repo', name: 'Repo', project: { id: 'project', name: 'Project' } },
	};
	let diff: { left: vscode.Uri; right: vscode.Uri } | undefined;
	let client: AzureClient;
	let showError: SinonStub;
	let fetchThreads: SinonStub;
	let currentUser: SinonStub;
	let state: InMemoryMemento;
	let trees: Map<string, vscode.TreeDataProvider<unknown>>;
	let contexts: Map<string, vscode.ChatAttachContextProvider>;
	let registerContext: SinonStub;

	function file(changeType = 'edit', originalPath?: string) {
		return {
			kind: 'file',
			change: { changeTrackingId: 7, changeType, item: { path: '/file.ts' }, originalPath },
			iteration: { id: 3, sourceRefCommit: { commitId: 'source' }, targetRefCommit: { commitId: 'target' }, commonRefCommit: { commitId: 'base' } },
			parent: { kind: 'pullRequest', pr, parent: { kind: 'repository', client, repository: new MockRepository() } },
		};
	}

	beforeEach(async () => {
		sandbox = createSandbox();
		commands = new Map();
		threads = [];
		diff = undefined;
		trees = new Map();
		contexts = new Map();
		controller = {
			id: 'azureDevOps', label: 'Azure DevOps', activeCommentThread: undefined, dispose() { },
			createCommentThread: (uri, range, comments) => {
				const thread: vscode.CommentThread = {
					uri, range, comments, canReply: true, collapsibleState: vscode.CommentThreadCollapsibleState.Expanded,
					dispose() { },
				};
				threads.push(thread);
				return thread;
			},
		};
		sandbox.stub(vscode.comments, 'createCommentController').returns(controller);
		sandbox.stub(BuiltinGitProvider, 'createProvider').resolves(undefined);
		sandbox.stub(vscode.extensions, 'getExtension').returns(undefined);
		sandbox.stub(vscode.lm, 'registerTool').returns(disposable);
		registerContext = sandbox.stub(vscode.chat, 'registerChatAttachContextProvider').callsFake((id, provider) => {
			contexts.set(id, provider);
			return disposable;
		});
		sandbox.stub(vscode.chat, 'registerChatTabContextProvider').returns(disposable);
		sandbox.stub(vscode.window, 'createTreeView').callsFake((_id, options) => {
			trees.set(_id, options.treeDataProvider);
			return disposable as vscode.TreeView<unknown>;
		});
		sandbox.stub(vscode.commands, 'registerCommand').callsFake((name, handler) => {
			assert.ok(!commands.has(name), `Duplicate command: ${name}`);
			commands.set(name, handler);
			return disposable;
		});
		sandbox.stub(vscode.commands, 'executeCommand').callsFake(async (command, left, right) => {
			if (command === 'vscode.diff') {
				diff = { left, right };
			}
			return undefined;
		});
		sandbox.stub(vscode.workspace, 'registerTextDocumentContentProvider').callsFake((_scheme, value) => {
			provider = value;
			return disposable;
		});
		sandbox.stub(vscode.languages, 'registerHoverProvider').returns(disposable);
		sandbox.stub(vscode.languages, 'registerCompletionItemProvider').returns(disposable);
		sandbox.stub(vscode.languages, 'registerCodeActionsProvider').returns(disposable);
		showError = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
		client = new AzureClient({ organizationUrl: 'https://dev.azure.com/example', project: 'Project', repository: 'Repo' }, async () => 'Bearer token');
		fetchThreads = sandbox.stub(client, 'threads').resolves([]);
		currentUser = sandbox.stub(client, 'currentUser').resolves(pr.createdBy);
		state = new InMemoryMemento();
		integration = new AzureIntegration({
			globalState: new InMemoryMemento(),
			workspaceState: state,
			extensionUri: vscode.Uri.file('/extension'),
			secrets: { get: async () => undefined, store: async () => { }, delete: async () => { }, onDidChange: () => disposable },
		});
		await integration.initialize();
	});

	afterEach(() => {
		integration?.dispose();
		sandbox.restore();
	});

	it('registers only Azure commands even without an open Git repository', () => {
		assert.strictEqual(commands.size, 20);
		assert.ok([...commands.keys()].every(command => command.startsWith('azureDevOps.')));
	});

	it('keeps Azure workflows available when the host refuses proposed chat context APIs', async () => {
		integration.dispose();
		commands.clear();
		registerContext.throws(new Error('Extension CANNOT use API proposal: chatContextProvider.'));
		const warning = sandbox.stub(Logger, 'warn');
		integration = new AzureIntegration({
			globalState: new InMemoryMemento(), workspaceState: state,
			secrets: { get: async () => undefined, store: async () => { }, delete: async () => { }, onDidChange: () => disposable },
		});
		await integration.initialize();
		assert.strictEqual(commands.size, 20);
		assert.ok(warning.calledWithMatch(/Chat context attachments require/, 'AzureDevOps'));
	});

	it('opens immutable merge-base/source diffs and loads tracked comments', async () => {
		const getFile = sandbox.stub(client, 'file').resolves('content');
		await commands.get('azureDevOps.openDiff')!(file());
		assert.ok(diff);
		await provider.provideTextDocumentContent(diff!.left, new vscode.CancellationTokenSource().token);
		await provider.provideTextDocumentContent(diff!.right, new vscode.CancellationTokenSource().token);
		assert.deepStrictEqual(getFile.args, [['/file.ts', 'base'], ['/file.ts', 'source']]);
		assert.deepStrictEqual(fetchThreads.firstCall.args, [42, 3]);
	});

	it('opens a reusable HTML overview on PR clicks and routes its file/comment controls through Azure', async () => {
		const value = file();
		sandbox.stub(client, 'reviewDetails').resolves({
			pullRequest: pr, threads: [], iteration: value.iteration, changes: [value.change], file: undefined,
		});
		sandbox.stub(client, 'statuses').resolves([]);
		sandbox.stub(client, 'labels').resolves([]);
		sandbox.stub(client, 'linkedWorkItems').resolves([]);
		sandbox.stub(client, 'policies').resolves([]);
		const publish = sandbox.stub(client, 'createThread').resolves({ id: 9, status: 'active', comments: [] });
		sandbox.stub(client, 'pullRequest').resolves(pr);
		let receive: (message: unknown) => void = () => { };
		const disposed = new vscode.EventEmitter<void>();
		const reveal = sandbox.spy();
		const post = sandbox.stub().resolves(true);
		const panel: vscode.WebviewPanel = {
			viewType: 'azureDevOps.pullRequestOverview', title: '', options: {}, active: true, visible: true,
			viewColumn: vscode.ViewColumn.Active, onDidDispose: disposed.event, onDidChangeViewState: () => disposable,
			reveal, dispose: () => disposed.fire(),
			webview: {
				html: '', options: {}, cspSource: 'vscode-webview:', asWebviewUri: uri => uri,
				postMessage: post, onDidReceiveMessage: listener => { receive = listener; return disposable; },
			},
		};
		const create = sandbox.stub(vscode.window, 'createWebviewPanel').returns(panel);
		const tree = trees.get('azureDevOps.pullRequests')!;
		const item = await tree.getTreeItem(value.parent);
		assert.strictEqual(item.command?.command, 'azureDevOps.openPullRequest');
		await commands.get(item.command!.command)!(...item.command!.arguments!);
		assert.match(panel.webview.html, /<h1>Example<\/h1>/);
		assert.match(panel.webview.html, /webview-azure-pr\.js/);
		assert.strictEqual(create.firstCall.args[2], vscode.ViewColumn.Active);
		assert.strictEqual(create.firstCall.args[3]?.enableScripts, true);
		await commands.get('azureDevOps.openPullRequest')!(value.parent);
		assert.ok(create.calledOnce && reveal.calledOnce);
		receive({ action: 'comment', content: 'From the overview' });
		await new Promise(resolve => setImmediate(resolve));
		assert.deepStrictEqual(publish.firstCall.args, [42, 'From the overview']);
		receive({ action: 'file', path: '/file.ts' });
		await new Promise(resolve => setImmediate(resolve));
		assert.ok(diff);
		const thread = controller.createCommentThread(diff!.right, new vscode.Range(0, 0, 0, 0), []);
		await commands.get('azureDevOps.startReview')!({ thread, text: 'Inline pending comment' });
		receive({ action: 'comment', content: 'General pending comment' });
		await new Promise(resolve => setImmediate(resolve));
		assert.ok(publish.calledOnce);
		assert.ok(JSON.stringify(state.get('azureDevOps.pendingReviews.v1')).includes('General pending comment'));
		assert.ok(post.args.some(([message]) => message.type === 'update' && message.html.includes('General pending comment')));
		assert.ok(showError.notCalled);
	});

	it('does not fetch a nonexistent base for additions or source for deletions', async () => {
		const getFile = sandbox.stub(client, 'file').resolves('content');
		await commands.get('azureDevOps.openDiff')!(file('add'));
		assert.strictEqual(await provider.provideTextDocumentContent(diff!.left, new vscode.CancellationTokenSource().token), '');
		await commands.get('azureDevOps.openDiff')!(file('delete'));
		assert.strictEqual(await provider.provideTextDocumentContent(diff!.right, new vscode.CancellationTokenSource().token), '');
		assert.strictEqual(getFile.called, false);
	});

	it('uses the original path for the left side of a renamed file', async () => {
		const getFile = sandbox.stub(client, 'file').resolves('content');
		await commands.get('azureDevOps.openDiff')!(file('rename, edit', '/old.ts'));
		await provider.provideTextDocumentContent(diff!.left, new vscode.CancellationTokenSource().token);
		assert.deepStrictEqual(getFile.firstCall.args, ['/old.ts', 'base']);
	});

	it('refuses unregistered review URIs instead of sending credentials to URI-controlled hosts', async () => {
		const getFile = sandbox.stub(client, 'file');
		await assert.rejects(async () => provider.provideTextDocumentContent(vscode.Uri.parse('azure-review://attacker/file.ts'), new vscode.CancellationTokenSource().token), /expired/);
		assert.strictEqual(getFile.called, false);
	});

	it('publishes new comments with one-based coordinates on the displayed side', async () => {
		await commands.get('azureDevOps.openDiff')!(file());
		const thread = controller.createCommentThread(diff!.right, new vscode.Range(2, 0, 4, 0), []);
		const created: ReviewThread = { id: 9, status: 'active', comments: [{ id: 1, content: 'Comment', author: pr.createdBy }] };
		const createThread = sandbox.stub(client, 'createThread').resolves(created);
		await commands.get('azureDevOps.reply')!({ thread, text: 'Comment' });
		assert.deepStrictEqual(createThread.firstCall.args, [
			42, 'Comment', { filePath: '/file.ts', rightFileStart: { line: 3, offset: 1 }, rightFileEnd: { line: 5, offset: 1 } }, 3, 7,
		]);
		assert.strictEqual(thread.comments.length, 1);
		assert.strictEqual(thread.contextValue, 'azureActive');
	});

	it('supports file-level comments without inventing a line-one anchor', async () => {
		await commands.get('azureDevOps.openDiff')!(file());
		const thread = controller.createCommentThread(diff!.right, undefined, []);
		const created: ReviewThread = { id: 9, status: 'active', comments: [{ id: 1, content: 'Whole file', author: pr.createdBy }] };
		const createThread = sandbox.stub(client, 'createThread').resolves(created);
		await commands.get('azureDevOps.reply')!({ thread, text: 'Whole file' });
		assert.deepStrictEqual(createThread.firstCall.args, [42, 'Whole file', { filePath: '/file.ts' }, 3, 7]);
		fetchThreads.resolves([{ ...created, threadContext: { filePath: '/file.ts' } }]);
		const previous = threads.length;
		await commands.get('azureDevOps.refresh')!();
		assert.strictEqual(threads.length, previous + 1);
		assert.strictEqual(threads.at(-1)?.range, undefined);
	});

	it('anchors tracked comments and treats closed Azure threads as resolved', async () => {
		fetchThreads.resolves([{
			id: 9, status: 'closed', comments: [{ id: 4, parentCommentId: 0, content: 'Root', author: pr.createdBy }],
			threadContext: { filePath: '/file.ts', rightFileStart: { line: 3, offset: 1 }, rightFileEnd: { line: 3, offset: 1 } },
		}]);
		await commands.get('azureDevOps.openDiff')!(file());
		assert.strictEqual(threads.length, 1);
		assert.strictEqual(threads[0].range?.start.line, 2);
		assert.strictEqual(threads[0].state, vscode.CommentThreadState.Resolved);
		assert.strictEqual(threads[0].uri.toString(), diff!.right.toString());
		const reply = sandbox.stub(client, 'reply').resolves({ id: 5, content: 'Reply', author: pr.createdBy });
		await commands.get('azureDevOps.reply')!({ thread: threads[0], text: 'Reply' });
		assert.deepStrictEqual(reply.firstCall.args, [42, 9, 'Reply', 4]);
		assert.strictEqual(threads[0].comments.length, 2);
	});

	it('surfaces comment failures without clearing the draft thread', async () => {
		await commands.get('azureDevOps.openDiff')!(file());
		const thread = controller.createCommentThread(diff!.right, new vscode.Range(0, 0, 0, 0), []);
		sandbox.stub(client, 'createThread').rejects(new Error('HTTP 403'));
		await commands.get('azureDevOps.reply')!({ thread, text: 'Keep this draft' });
		assert.strictEqual(thread.comments.length, 0);
		assert.ok(showError.calledWith('HTTP 403'));
	});

	it('keeps pending comments private and restores each exactly once with or without published threads', async () => {
		sandbox.stub(client, 'pullRequest').resolves(pr);
		const publish = sandbox.stub(client, 'createThread');
		await commands.get('azureDevOps.openDiff')!(file());
		const thread = controller.createCommentThread(diff!.right, new vscode.Range(0, 0, 0, 0), []);
		await commands.get('azureDevOps.startReview')!({ thread, text: 'Private comment' });
		assert.strictEqual(publish.called, false);
		assert.strictEqual(thread.comments[0].label, 'Pending');
		assert.ok(JSON.stringify(state.get('azureDevOps.pendingReviews.v1')).includes('Private comment'));
		fetchThreads.resolves([1, 2].map(id => ({
			id, status: 'active', comments: [{ id: 1, content: 'Published', author: pr.createdBy }],
			threadContext: { filePath: '/file.ts', rightFileStart: { line: 1, offset: 1 } },
		})));
		let previous = threads.length;
		await commands.get('azureDevOps.refresh')!();
		assert.strictEqual(threads.slice(previous).length, 3);
		assert.strictEqual(threads.slice(previous).filter(value => value.comments[0]?.label === 'Pending').length, 1);
		fetchThreads.resolves([]);
		previous = threads.length;
		await commands.get('azureDevOps.refresh')!();
		assert.strictEqual(threads.slice(previous).length, 1);
		assert.strictEqual(threads.at(-1)?.comments[0].label, 'Pending');
	});

	it('publishes pending comments before voting and clears the persisted queue afterward', async () => {
		sandbox.stub(client, 'pullRequest').resolves(pr);
		const publish = sandbox.stub(client, 'createThread').resolves({ id: 9, status: 'active', comments: [] });
		const vote = sandbox.stub(client, 'vote').resolves();
		const decision = { label: 'Approve', vote: 10 };
		sandbox.stub(vscode.window, 'showQuickPick').resolves(decision);
		const value = file();
		await commands.get('azureDevOps.openDiff')!(value);
		const thread = controller.createCommentThread(diff!.right, new vscode.Range(0, 0, 0, 0), []);
		await commands.get('azureDevOps.startReview')!({ thread, text: 'Private comment' });
		await commands.get('azureDevOps.submitReview')!(value.parent);
		assert.ok(publish.calledOnce);
		assert.match(publish.firstCall.args[1], /Private comment\n\n<!-- azdo-review:[\w-]+:-1 -->/);
		assert.deepStrictEqual(vote.firstCall.args, [42, 10, 'user']);
		assert.ok(vote.calledAfter(publish));
		assert.deepStrictEqual(state.get('azureDevOps.pendingReviews.v1'), {});
		assert.ok(showError.notCalled);
	});

	it('preserves pending comments and refuses to vote after source or account changes', async () => {
		const get = sandbox.stub(client, 'pullRequest').resolves(pr);
		const publish = sandbox.stub(client, 'createThread');
		const vote = sandbox.stub(client, 'vote');
		const decision = { label: 'Approve', vote: 10 };
		const selection = sandbox.stub(vscode.window, 'showQuickPick').resolves(decision);
		const value = file();
		await commands.get('azureDevOps.openDiff')!(value);
		const thread = controller.createCommentThread(diff!.right, new vscode.Range(0, 0, 0, 0), []);
		await commands.get('azureDevOps.startReview')!({ thread, text: 'Keep this draft' });
		get.resolves({ ...pr, lastMergeSourceCommit: { commitId: 'new-source' } });
		await commands.get('azureDevOps.submitReview')!(value.parent);
		assert.ok(showError.lastCall.args[0].includes('source branch changed'));
		get.resolves(pr);
		currentUser.resolves({ id: 'other', displayName: 'Other account' });
		const commentOnly = { label: 'Comment only', vote: undefined };
		selection.resolves(commentOnly);
		await commands.get('azureDevOps.submitReview')!(value.parent);
		assert.ok(showError.lastCall.args[0].includes('account'));
		assert.ok(publish.notCalled && vote.notCalled);
		assert.ok(JSON.stringify(state.get('azureDevOps.pendingReviews.v1')).includes('Keep this draft'));
	});

	it('does not start a review against a source commit newer than the displayed diff', async () => {
		sandbox.stub(client, 'pullRequest').resolves({ ...pr, lastMergeSourceCommit: { commitId: 'new-source' } });
		await commands.get('azureDevOps.openDiff')!(file());
		const thread = controller.createCommentThread(diff!.right, new vscode.Range(0, 0, 0, 0), []);
		await commands.get('azureDevOps.startReview')!({ thread, text: 'Old diff' });
		assert.ok(showError.lastCall.args[0].includes('source branch changed'));
		assert.strictEqual(state.get('azureDevOps.pendingReviews.v1'), undefined);
	});

	it('rechecks the source before voting if a push happens while comments are publishing', async () => {
		const get = sandbox.stub(client, 'pullRequest').resolves(pr);
		sandbox.stub(client, 'createThread').callsFake(async () => {
			get.resolves({ ...pr, lastMergeSourceCommit: { commitId: 'new-source' } });
			return { id: 9, status: 'active', comments: [] };
		});
		const vote = sandbox.stub(client, 'vote');
		const decision = { label: 'Approve', vote: 10 };
		sandbox.stub(vscode.window, 'showQuickPick').resolves(decision);
		const value = file();
		await commands.get('azureDevOps.openDiff')!(value);
		const thread = controller.createCommentThread(diff!.right, new vscode.Range(0, 0, 0, 0), []);
		await commands.get('azureDevOps.startReview')!({ thread, text: 'A comment' });
		await commands.get('azureDevOps.submitReview')!(value.parent);
		assert.ok(vote.notCalled);
		assert.ok(showError.lastCall.args[0].includes('during submission'));
		assert.ok(JSON.stringify(state.get('azureDevOps.pendingReviews.v1')).includes('"comments":[]'));
	});

	it('toggles the native like using the current viewer identity', async () => {
		fetchThreads.resolves([{
			id: 9, status: 'active', comments: [{ id: 4, content: 'Liked', author: pr.createdBy, usersLiked: [pr.createdBy] }],
			threadContext: { filePath: '/file.ts', rightFileStart: { line: 1, offset: 1 } },
		}]);
		const like = sandbox.stub(client, 'likeComment').resolves();
		await commands.get('azureDevOps.openDiff')!(file());
		const comment = threads[0].comments[0];
		assert.strictEqual(comment.reactions?.[0].authorHasReacted, true);
		await controller.reactionHandler!(comment, comment.reactions![0]);
		assert.deepStrictEqual(like.firstCall.args, [42, 9, 4, false]);
	});

	it('persists viewed files locally and resets their state after source pushes', async () => {
		const value = file();
		const tree = trees.get('azureDevOps.pullRequests')!;
		assert.strictEqual((await tree.getTreeItem(value)).description, 'edit');
		await commands.get('azureDevOps.toggleFileViewed')!(value);
		assert.strictEqual((await tree.getTreeItem(value)).description, 'Viewed: edit');
		await commands.get('azureDevOps.toggleFileViewed')!(value);
		assert.strictEqual((await tree.getTreeItem(value)).description, 'edit');
		await commands.get('azureDevOps.toggleFileViewed')!(value);
		value.iteration.sourceRefCommit.commitId = 'new-source';
		assert.strictEqual((await tree.getTreeItem(value)).description, 'edit');
	});

	it('applies suggestions only to an unchanged working file at the reviewed source commit', async () => {
		const value = file();
		const repository = value.parent.parent.repository;
		repository.state = { ...repository.state, HEAD: { ...repository.state.HEAD!, commit: 'source' } };
		const original = 'before\nmiddle\nafter';
		sandbox.stub(client, 'file').resolves(original);
		fetchThreads.resolves([{
			id: 9, status: 'active', comments: [{ id: 4, content: '```suggestion\nreplacement\n```', author: pr.createdBy }],
			threadContext: { filePath: '/file.ts', rightFileStart: { line: 2, offset: 1 }, rightFileEnd: { line: 2, offset: 7 } },
		}]);
		let dirty = false;
		let content = original;
		const uri = vscode.Uri.joinPath(repository.rootUri, 'file.ts');
		const working: vscode.TextDocument = {
			uri, get isDirty() { return dirty; }, getText: () => content, lineCount: 3,
			fileName: uri.fsPath, isUntitled: false, languageId: 'typescript', encoding: 'utf8', version: 1, isClosed: false,
			save: async () => true, offsetAt: () => 0, positionAt: () => new vscode.Range(0, 0, 0, 0).start,
			validateRange: range => range, validatePosition: position => position, getWordRangeAtPosition: () => undefined,
			eol: vscode.EndOfLine.LF, lineAt: () => ({
				lineNumber: 1, text: 'middle', range: new vscode.Range(1, 0, 1, 6),
				rangeIncludingLineBreak: new vscode.Range(1, 0, 2, 0), firstNonWhitespaceCharacterIndex: 0, isEmptyOrWhitespace: false,
			}),
		};
		sandbox.stub(vscode.workspace, 'openTextDocument').resolves(working);
		const apply = sandbox.stub(vscode.workspace, 'applyEdit').resolves(true);
		await commands.get('azureDevOps.openDiff')!(value);
		const comment = threads[0].comments[0];
		assert.strictEqual(comment.contextValue, 'azureSuggestion');
		await commands.get('azureDevOps.applySuggestion')!(comment);
		const edits = apply.firstCall.args[0].get(uri);
		assert.strictEqual(edits[0].newText, 'replacement');
		assert.strictEqual(edits[0].range.start.line, 1);
		assert.strictEqual(edits[0].range.end.character, 6);
		dirty = true;
		await commands.get('azureDevOps.applySuggestion')!(comment);
		assert.ok(showError.lastCall.args[0].includes('working file differs'));
		dirty = false;
		content = 'Local modification';
		await commands.get('azureDevOps.applySuggestion')!(comment);
		assert.ok(showError.lastCall.args[0].includes('working file differs'));
		repository.state = { ...repository.state, HEAD: { ...repository.state.HEAD!, commit: 'other' } };
		await commands.get('azureDevOps.applySuggestion')!(comment);
		assert.ok(showError.lastCall.args[0].includes('reviewed source commit'));
		assert.ok(apply.calledOnce);
	});

	function registerRepository(): { git: IGit; repository: MockRepository; registration: vscode.Disposable } {
		const repository = new MockRepository();
		repository.state = {
			...repository.state,
			HEAD: { ...repository.state.HEAD!, name: 'feature' },
			remotes: [{ name: 'origin', fetchUrl: 'https://dev.azure.com/example/Project/_git/Repo', isReadOnly: false }],
		};
		const git: IGit = { repositories: [repository], onDidOpenRepository: () => disposable, onDidCloseRepository: () => disposable };
		return { git, repository, registration: integration.registerGitProvider(git) };
	}

	it('exposes registered Git providers and Azure repository metadata through the extension API', async () => {
		sandbox.stub(AzureClient.prototype, 'repository').resolves({ ...pr.repository, defaultBranch: 'refs/heads/main' });
		const pullRequests = sandbox.stub(AzureClient.prototype, 'pullRequests').resolves([pr]);
		const { git, repository, registration } = registerRepository();
		assert.strictEqual(integration.getGitProvider(repository.rootUri), git);
		assert.strictEqual(integration.getGitProvider(vscode.Uri.file('/root/file.ts')), git);
		const description = await integration.getRepositoryDescription(repository.rootUri);
		assert.strictEqual(description?.owner, 'example/Project');
		assert.strictEqual(description?.defaultBranch, 'main');
		assert.strictEqual(description?.pullRequest?.number, 42);
		assert.deepStrictEqual(pullRequests.firstCall.args, ['active', { 'searchCriteria.sourceRefName': 'refs/heads/feature' }]);
		registration.dispose();
		assert.strictEqual(integration.getGitProvider(repository.rootUri), undefined);
	});

	it('tracks unread activity locally and makes changed conversations unread again', async () => {
		sandbox.stub(AzureClient.prototype, 'currentUser').resolves(pr.createdBy);
		sandbox.stub(AzureClient.prototype, 'pullRequests').resolves([pr]);
		const discussions = sandbox.stub(AzureClient.prototype, 'threads').resolves([]);
		registerRepository();
		const tree = trees.get('azureDevOps.notifications')!;
		const roots = await tree.getChildren();
		assert.ok(roots?.length);
		assert.strictEqual((await tree.getChildren(roots[0]))?.length, 1);
		await commands.get('azureDevOps.markNotificationsRead')!();
		assert.strictEqual((await tree.getChildren(roots[0]))?.length, 0);
		discussions.resolves([{ id: 9, status: 'active', comments: [{ id: 1, content: 'New activity', author: pr.createdBy }] }]);
		assert.strictEqual((await tree.getChildren(roots[0]))?.length, 1);
	});

	it('attaches native Azure PR context and rejects resolution after its repository closes', async () => {
		sandbox.stub(AzureClient.prototype, 'pullRequests').resolves([pr]);
		const details = { pullRequest: pr, threads: [], iteration: undefined, changes: [], file: undefined };
		const read = sandbox.stub(AzureClient.prototype, 'reviewDetails').resolves(details);
		const { registration } = registerRepository();
		const provider = contexts.get('azureDevOpsPr')!;
		const token = new vscode.CancellationTokenSource().token;
		const items = await provider.provideAttachChatContext(token);
		assert.strictEqual(items?.[0].label, '!42 Example');
		const resolved = await provider.resolveAttachChatContext(items![0], token);
		assert.ok(resolved && typeof resolved.value === 'string');
		assert.strictEqual(JSON.parse(resolved.value).pullRequest.pullRequestId, 42);
		registration.dispose();
		await assert.rejects(async () => provider.resolveAttachChatContext(items![0], token), /no longer open/);
		assert.ok(read.calledOnce);
	});

	it('attaches Azure Boards details and comments rather than GitHub issue data', async () => {
		const workItem = { id: 12, fields: { 'System.Title': 'Work', 'System.State': 'Active', 'System.WorkItemType': 'Task' } };
		sandbox.stub(AzureClient.prototype, 'workItems').resolves([workItem]);
		sandbox.stub(AzureClient.prototype, 'workItem').resolves(workItem);
		sandbox.stub(AzureClient.prototype, 'workItemComments').resolves([{ text: 'Discussion', createdBy: pr.createdBy }]);
		registerRepository();
		const provider = contexts.get('azureDevOpsWorkItem')!;
		const token = new vscode.CancellationTokenSource().token;
		const items = await provider.provideAttachChatContext(token);
		assert.strictEqual(items?.[0].label, 'AB#12 Work');
		const resolved = await provider.resolveAttachChatContext(items![0], token);
		assert.ok(resolved && typeof resolved.value === 'string');
		assert.strictEqual(JSON.parse(resolved.value).comments[0].text, 'Discussion');
	});
});
