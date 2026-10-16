/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createSandbox } from 'sinon';
import * as vscode from 'vscode';
import { AzurePullRequestOverview, OverviewData, overviewBody, overviewMarkdown } from '../../azure/overview';

export function overviewFixture(): OverviewData {
	return {
		url: 'https://dev.azure.com/example/Project/_git/Repo/pullrequest/42',
		pullRequest: {
			pullRequestId: 42, title: 'An Azure PR', description: '**Description** with `code`', status: 'active', isDraft: false,
			createdBy: { id: 'user', displayName: 'Author' }, sourceRefName: 'refs/heads/topic', targetRefName: 'refs/heads/main',
			reviewers: [{ id: 'reviewer', displayName: 'Reviewer', vote: 10 }],
			lastMergeSourceCommit: { commitId: 'source' }, lastMergeTargetCommit: { commitId: 'target' },
			repository: { id: 'repo', name: 'Repo', project: { id: 'project', name: 'Project' } },
		},
		threads: [{ id: 9, status: 'active', comments: [{ id: 1, content: 'A **review**', author: { id: 'user', displayName: 'Author' } }] }],
		iteration: { id: 3, sourceRefCommit: { commitId: 'source' }, targetRefCommit: { commitId: 'target' }, commonRefCommit: { commitId: 'base' } },
		changes: [{ changeTrackingId: 7, changeType: 'edit', item: { path: '/file.ts' } }], file: undefined,
		statuses: [{ id: 1, state: 'succeeded', context: { name: 'Build' } }],
		policies: [{ evaluationId: 'policy', status: 'approved', configuration: { type: { displayName: 'Required reviewers' }, isBlocking: true } }],
		labels: [{ id: 'label', name: 'Feature' }],
		workItems: [{ id: 12, fields: { 'System.Title': 'A task', 'System.State': 'Active', 'System.WorkItemType': 'Task' } }],
		viewer: 'user',
	};
}

describe('Azure DevOps HTML overview', () => {
	const sandbox = createSandbox();
	afterEach(() => sandbox.restore());

	it('renders native PR details, Markdown, discussions, checks, policies and work items', () => {
		const html = overviewBody(overviewFixture());
		for (const content of ['An Azure PR', '<strong>Description</strong>', '<code>code</code>', 'A <strong>review</strong>',
			'Reviewer', 'Approved', 'Build', 'Required reviewers', 'Feature', 'AB#12', '/file.ts', 'data-action="complete"']) {
			assert.ok(html.includes(content), content);
		}
	});

	it('escapes untrusted content and refuses executable links and embedded images', () => {
		const data = overviewFixture();
		data.pullRequest.title = '<img src=x onerror=alert(1)>';
		data.labels[0].name = '"><script>alert(1)</script>';
		const html = overviewBody(data);
		assert.ok(!html.includes('<img'));
		assert.ok(!html.includes('<script'));
		const markdown = overviewMarkdown('<script>alert(1)</script>\n\n[bad](javascript:alert(1)) ![tracking](https://tracker.example/x)\n\n[ok](https://example.com)');
		assert.ok(!markdown.includes('<script'));
		assert.ok(!markdown.includes('<img'));
		assert.ok(!markdown.includes('href="javascript:'));
		assert.ok(markdown.includes('href="https://example.com/"'));
		assert.ok(!overviewMarkdown('text\n\n<!-- azdo-review:nonce:-1 -->').includes('azdo-review'));
	});

	it('shows pending drafts and replaces direct voting with review submission controls', () => {
		const data = overviewFixture();
		data.pending = { nonce: 'nonce', author: 'user', commit: 'source', nextId: -3,
			comments: [{ id: -1, content: 'General draft' }, { id: -2, content: 'Reply draft', threadId: 9 }] };
		const html = overviewBody(data);
		assert.ok(html.includes('General draft') && html.includes('Reply draft'));
		assert.ok(html.includes('data-action="submitReview"'));
		assert.ok(!html.includes('data-action="review"'));
		assert.ok(html.includes('Save Pending Comment'));
	});

	function fixture() {
		const data = overviewFixture();
		const disposed = new vscode.EventEmitter<void>();
		let listener: (value: unknown) => void = () => { };
		const post = sandbox.stub().resolves(true);
		const panel: vscode.WebviewPanel = {
			viewType: 'azureDevOps.pullRequestOverview', title: '', options: {}, active: true, visible: true,
			viewColumn: vscode.ViewColumn.Active, onDidDispose: disposed.event, onDidChangeViewState: () => ({ dispose() { } }),
			reveal() { }, dispose: sandbox.spy(),
			webview: {
				html: '', options: {}, cspSource: 'vscode-webview:', asWebviewUri: uri => uri,
				postMessage: post, onDidReceiveMessage: handler => { listener = handler; return { dispose() { } }; },
			},
		};
		const callbacks = {
			load: sandbox.stub().resolves(data), action: sandbox.stub().resolves(), openFile: sandbox.stub().resolves(),
			comment: sandbox.stub().resolves(), changeThread: sandbox.stub().resolves(), changeComment: sandbox.stub().resolves(),
			changeDraft: sandbox.stub().resolves(),
			changed: sandbox.stub().resolves(), report: sandbox.stub(),
		};
		const overview = new AzurePullRequestOverview(panel, vscode.Uri.file('/extension'), callbacks);
		const receive = async (message: unknown) => {
			listener(message);
			await new Promise(resolve => setImmediate(resolve));
		};
		return { overview, panel, callbacks, post, receive };
	}

	it('loads a nonce-protected HTML page and updates it without replacing the document', async () => {
		const { overview, panel, callbacks, post } = fixture();
		await overview.refresh();
		assert.match(panel.webview.html, /default-src 'none'/);
		assert.match(panel.webview.html, /script-src 'nonce-[a-f0-9]+'/);
		assert.match(panel.webview.html, /webview-azure-pr\.js/);
		assert.ok(!panel.webview.html.includes('iframe'));
		const original = panel.webview.html;
		await overview.refresh();
		assert.strictEqual(panel.webview.html, original);
		assert.strictEqual(post.lastCall.args[0].type, 'update');
		assert.ok(callbacks.report.notCalled);
		overview.dispose();
	});

	it('routes only validated files, discussion IDs and fixed PR actions', async () => {
		const { overview, callbacks, receive } = fixture();
		await overview.refresh();
		await receive({ action: 'file', path: '/file.ts' });
		assert.ok(callbacks.openFile.calledWithExactly('/file.ts'));
		await receive({ action: 'comment', content: 'Reply', threadId: 9 });
		assert.ok(callbacks.comment.calledWithExactly('Reply', 9));
		await receive({ action: 'resolve', threadId: 9, resolved: true });
		assert.ok(callbacks.changeThread.calledWithExactly(9, true));
		await receive({ action: 'complete' });
		assert.ok(callbacks.action.calledWithExactly('complete'));
		await receive({ action: 'file', path: '/unrelated.ts' });
		await receive({ action: 'comment', content: 'Reply', threadId: '9' });
		await receive({ action: 'resolve', threadId: 999, resolved: true });
		await receive({ action: 'arbitrary.command', url: 'https://attacker.example' });
		assert.strictEqual(callbacks.report.callCount, 4);
		assert.ok(callbacks.comment.calledOnce && callbacks.openFile.calledOnce && callbacks.changeThread.calledOnce);
		overview.dispose();
	});

	it('preserves unsent drafts on failures and acknowledges comments only after successful publication', async () => {
		const { overview, callbacks, post, receive } = fixture();
		await overview.refresh();
		callbacks.comment.rejects(new Error('HTTP 403'));
		await receive({ action: 'comment', content: 'Keep me' });
		assert.ok(!post.args.some(([message]) => message.type === 'commentSaved'));
		assert.ok(post.args.some(([message]) => message.type === 'error' && message.message === 'HTTP 403'));
		callbacks.comment.resolves();
		await receive({ action: 'comment', content: 'Keep me' });
		assert.ok(post.args.some(([message]) => message.type === 'commentSaved' && message.key === 'general'));
		overview.dispose();
	});

	it('shows load failures and supports retry without a success-shaped empty overview', async () => {
		const { overview, panel, callbacks } = fixture();
		callbacks.load.rejects(new Error('HTTP 401'));
		await overview.refresh();
		assert.match(panel.webview.html, /Unable to load pull request/);
		assert.match(panel.webview.html, /HTTP 401/);
		callbacks.load.resolves(overviewFixture());
		await overview.refresh();
		assert.match(panel.webview.html, /An Azure PR/);
		overview.dispose();
	});

	it('resends current HTML after a hidden webview is recreated', async () => {
		const { overview, callbacks, post, receive } = fixture();
		await overview.refresh();
		const updated = overviewFixture();
		updated.pullRequest.title = 'Updated while hidden';
		callbacks.load.resolves(updated);
		await overview.refresh();
		post.resetHistory();
		await receive({ action: 'ready' });
		assert.strictEqual(post.firstCall.args[0].type, 'update');
		assert.match(post.firstCall.args[0].html, /Updated while hidden/);
		assert.ok(callbacks.changed.notCalled);
		overview.dispose();
	});

	it('does not replace newer data when an older concurrent refresh finishes last', async () => {
		const { overview, panel, callbacks } = fixture();
		let finish: (value: OverviewData) => void = () => { };
		callbacks.load.onFirstCall().returns(new Promise<OverviewData>(resolve => { finish = resolve; }));
		const old = overview.refresh();
		const updated = overviewFixture();
		updated.pullRequest.title = 'Newest title';
		callbacks.load.onSecondCall().resolves(updated);
		await overview.refresh();
		finish(overviewFixture());
		await old;
		assert.strictEqual(panel.title, '!42 Newest title');
		overview.dispose();
	});

	it('validates pending draft IDs and comment actions against the displayed PR', async () => {
		const { overview, callbacks, receive } = fixture();
		const data = overviewFixture();
		data.pending = { nonce: 'nonce', author: 'user', commit: 'source', nextId: -2, comments: [{ id: -1, content: 'Draft' }] };
		callbacks.load.resolves(data);
		await overview.refresh();
		await receive({ action: 'editDraft', commentId: -1 });
		assert.ok(callbacks.changeDraft.calledWithExactly(-1, false));
		await receive({ action: 'deleteDraft', commentId: -99 });
		assert.ok(callbacks.changeDraft.calledOnce);
		await receive({ action: 'like', threadId: 9, commentId: 1 });
		assert.ok(callbacks.changeComment.calledWithExactly(9, 1, 'like'));
		await receive({ action: 'editComment', threadId: 9, commentId: 1 });
		assert.ok(callbacks.changeComment.calledWithExactly(9, 1, 'edit'));
		assert.ok(callbacks.report.calledOnce);
		overview.dispose();
	});
});
