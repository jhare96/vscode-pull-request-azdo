/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as marked from 'marked';
import * as vscode from 'vscode';
import { AzureClient, PolicyEvaluation, PullRequestLabel, PullRequestStatus, WorkItem } from './client';
import { PendingReview } from './review';

export type OverviewAction = 'actions' | 'complete' | 'autoComplete' | 'checkout' | 'edit' | 'reviewers' | 'labels' | 'workItems'
	| 'draft' | 'abandon' | 'reactivate' | 'cancelAutoComplete' | 'review' | 'startReview' | 'submitReview' | 'discardReview' | 'discussion';

export interface OverviewData extends Awaited<ReturnType<AzureClient['reviewDetails']>> {
	url: string;
	statuses: PullRequestStatus[];
	policies: PolicyEvaluation[];
	labels: PullRequestLabel[];
	workItems: WorkItem[];
	pending?: PendingReview;
	viewer: string;
}

export interface OverviewCallbacks {
	load(): Promise<OverviewData>;
	action(action: OverviewAction): Promise<void>;
	openFile(path: string): Promise<void>;
	comment(content: string, threadId?: number): Promise<void>;
	changeThread(id: number, resolved: boolean): Promise<void>;
	changeComment(threadId: number, id: number, action: 'edit' | 'delete' | 'like'): Promise<void>;
	changeDraft(id: number, remove: boolean): Promise<void>;
	changed(): Promise<void>;
	report(error: unknown): void;
}

function escape(value: string): string {
	return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[character]!);
}

export function overviewMarkdown(value: string): string {
	const renderer = new marked.Renderer();
	renderer.html = html => escape(html);
	renderer.image = (_href, _title, text) => escape(text);
	renderer.link = (href, _title, text) => {
		try {
			const url = new URL(href ?? '');
			return url.protocol === 'https:' && !url.username && !url.password
				? `<a href="${escape(url.toString())}">${text}</a>` : text;
		} catch {
			return text;
		}
	};
	return marked.parse(value.replace(/\n*<!-- azdo-review:[\w-]+:-\d+ -->/g, ''), { renderer, gfm: true });
}

export function overviewBody(data: OverviewData): string {
	const { pullRequest: pr } = data;
	const t = vscode.l10n.t;
	const button = (action: string, title: string, extra = '') => `<button type="button" data-action="${action}" ${extra}>${escape(title)}</button>`;
	const empty = `<p class="muted">${escape(t('None'))}</p>`;
	const vote = (value: number) => escape(value === 10 ? t('Approved') : value === 5 ? t('Approved with suggestions')
		: value === -5 ? t('Waiting for author') : value === -10 ? t('Rejected') : t('No vote'));
	const form = (threadId?: number) => `<form data-comment ${threadId === undefined ? '' : `data-thread="${threadId}"`}>
		<label>${escape(threadId === undefined ? t('Add a comment') : t('Reply'))}
		<textarea name="content" required rows="3" data-draft="${threadId ?? 'general'}" placeholder="${escape(t('Markdown supported'))}"></textarea></label>
		<button type="submit">${escape(data.pending ? t('Save Pending Comment') : t('Comment'))}</button></form>`;
	const draft = (comment: NonNullable<OverviewData['pending']>['comments'][number]) => `<div class="pending markdown">
		<strong>${escape(t('Pending'))} ${escape(comment.context?.filePath ?? '')}</strong>${overviewMarkdown(comment.content)}
		${button('editDraft', t('Edit'), `data-comment="${comment.id}"`)}${button('deleteDraft', t('Delete'), `data-comment="${comment.id}"`)}</div>`;
	const discussion = data.threads.filter(thread => !thread.isDeleted).map(thread => {
		const resolved = [2, 3, 4, 5, 'fixed', 'wontFix', 'closed', 'byDesign'].includes(thread.status);
		return `<article class="thread">
			<header><strong>${escape(thread.threadContext?.filePath ?? t('General discussion'))}</strong>
			<span class="badge">${escape(resolved ? t('Resolved') : t('Active'))}</span>
			${button('resolve', resolved ? t('Reopen') : t('Resolve'), `data-thread="${thread.id}" data-resolved="${!resolved}"`)}</header>
			${thread.comments.filter(comment => !comment.isDeleted && comment.content).map(comment => `<div class="comment">
				<strong>${escape(comment.author.displayName)}</strong>
				<div class="markdown">${overviewMarkdown(comment.content!)}</div>
				${button('like', t('Like ({0})', comment.usersLiked?.length ?? 0), `data-thread="${thread.id}" data-comment="${comment.id}" aria-pressed="${comment.usersLiked?.some(user => user.id === data.viewer) ?? false}"`)}
				${comment.author.id === data.viewer ? button('editComment', t('Edit'), `data-thread="${thread.id}" data-comment="${comment.id}"`)
					+ button('deleteComment', t('Delete'), `data-thread="${thread.id}" data-comment="${comment.id}"`) : ''}
			</div>`).join('')}
			${(data.pending?.comments ?? []).filter(comment => comment.threadId === thread.id).map(draft).join('')}
			${form(thread.id)}</article>`;
	}).join('');
	return `<header class="pr-header">
		<p class="muted">${escape(pr.repository.project.name)} / ${escape(pr.repository.name)} / !${pr.pullRequestId}</p>
		<h1>${escape(pr.title)}</h1>
		<p><span class="badge">${escape(pr.isDraft ? t('Draft') : pr.status)}</span> ${escape(pr.createdBy.displayName)}
		<code>${escape(pr.sourceRefName.replace('refs/heads/', ''))}</code> &rarr; <code>${escape(pr.targetRefName.replace('refs/heads/', ''))}</code></p>
		<nav aria-label="${escape(t('Pull request actions'))}">
			${button('refresh', t('Refresh'))}${button('browser', t('Open in Azure DevOps'))}${button('checkout', t('Checkout'))}
			${button('edit', t('Edit Title and Description'))}${button('actions', t('More Actions'))}
		</nav>
	</header>
	<div class="layout"><main>
		<section><h2>${escape(t('Description'))}</h2><div class="markdown">${pr.description ? overviewMarkdown(pr.description) : empty}</div></section>
		<section><h2>${escape(t('Files changed ({0})', data.changes.length))}</h2>
			${data.changes.filter(change => !change.item.isFolder).map(change => `<div class="file">${button('file', change.item.path, `data-path="${escape(change.item.path)}"`)} <span class="muted">${escape(change.changeType)}</span></div>`).join('') || empty}</section>
		<section><h2>${escape(t('Discussion'))}</h2>${discussion || empty}
			${(data.pending?.comments ?? []).filter(comment => comment.threadId === undefined).map(draft).join('')}
			${form()}</section>
	</main><aside>
		<section><h2>${escape(t('Review'))}</h2>
			${data.pending ? `<p>${escape(t('{0} pending comments', data.pending.comments.length))}</p>${button('submitReview', t('Submit Pending Review'))}${button('discardReview', t('Discard Pending Review'))}`
				: `${button('review', t('Submit Review'))}${button('startReview', t('Start Pending Review'))}`}</section>
		<section><h2>${escape(t('Reviewers'))}</h2>${pr.reviewers.map(reviewer => `<p>${escape(reviewer.displayName)}<br><span class="muted">${vote(reviewer.vote ?? 0)}</span></p>`).join('') || empty}${button('reviewers', t('Manage Reviewers'))}</section>
		<section><h2>${escape(t('Checks and Policies'))}</h2>
			${data.statuses.map(status => `<p><strong>${escape(status.context.name)}</strong>: ${escape(status.state)}<br>${escape(status.description ?? '')}</p>`).join('')}
			${data.policies.map(policy => `<p><strong>${escape(policy.configuration.type.displayName)}</strong>: ${escape(policy.status)} ${policy.configuration.isBlocking ? escape(t('(required)')) : ''}</p>`).join('')}
			${!data.statuses.length && !data.policies.length ? empty : ''}</section>
		<section><h2>${escape(t('Labels'))}</h2>${data.labels.map(label => `<span class="badge">${escape(label.name)}</span>`).join('') || empty}${button('labels', t('Manage Labels'))}</section>
		<section><h2>${escape(t('Linked Work Items'))}</h2>${data.workItems.map(item => `<p>AB#${item.id} ${escape(item.fields['System.Title'])}<br><span class="muted">${escape(item.fields['System.State'])}</span></p>`).join('') || empty}${button('workItems', t('Manage Work Items'))}</section>
		<section><h2>${escape(t('Completion'))}</h2>
			${pr.status === 'active' ? `${button('complete', t('Complete'))}${button('autoComplete', t('Set Auto-complete'))}
				${pr.autoCompleteSetBy ? button('cancelAutoComplete', t('Cancel Auto-complete')) : ''}
				${button('draft', pr.isDraft ? t('Publish') : t('Convert to Draft'))}${button('abandon', t('Abandon'))}`
				: pr.status === 'abandoned' ? button('reactivate', t('Reactivate')) : `<p>${escape(t('Completed'))}</p>`}</section>
		${button('discussion', t('Open Discussion in Comments Panel'))}
	</aside></div>`;
}

const actions: readonly OverviewAction[] = ['actions', 'complete', 'autoComplete', 'checkout', 'edit', 'reviewers', 'labels', 'workItems',
	'draft', 'abandon', 'reactivate', 'cancelAutoComplete', 'review', 'startReview', 'submitReview', 'discardReview', 'discussion'];

export class AzurePullRequestOverview implements vscode.Disposable {
	private readonly subscriptions: vscode.Disposable[] = [];
	private data: OverviewData | undefined;
	private disposed = false;
	private busy = false;
	private initialized = false;
	private revision = 0;

	constructor(readonly panel: vscode.WebviewPanel, private readonly extensionUri: vscode.Uri, private readonly callbacks: OverviewCallbacks) {
		this.subscriptions.push(panel.onDidDispose(() => this.dispose()), panel.webview.onDidReceiveMessage((message: unknown) => {
			void this.receive(message).catch(error => this.fail(error));
		}), panel.onDidChangeViewState(event => {
			if (event.webviewPanel.visible && !this.busy) {
				void this.refresh();
			}
		}));
	}

	dispose(): void {
		if (!this.disposed) {
			this.disposed = true;
			this.subscriptions.forEach(subscription => subscription.dispose());
			this.panel.dispose();
		}
	}

	async refresh(): Promise<void> {
		if (this.disposed) {
			return;
		}
		const revision = ++this.revision;
		try {
			const data = await this.callbacks.load();
			if (this.disposed || revision !== this.revision) {
				return;
			}
			this.data = data;
			this.panel.title = `!${data.pullRequest.pullRequestId} ${data.pullRequest.title}`;
			if (!this.initialized) {
				const nonce = crypto.randomUUID().replace(/-/g, '');
				const script = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview-azure-pr.js'));
				this.panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
					<meta name="viewport" content="width=device-width, initial-scale=1">
					<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"></head>
					<body><p id="error" role="alert" hidden></p><p id="progress" role="status" hidden>${escape(vscode.l10n.t('Working...'))}</p>
					<div id="overview">${overviewBody(data)}</div><script nonce="${nonce}" src="${escape(script.toString())}"></script></body></html>`;
				this.initialized = true;
			} else {
				await this.panel.webview.postMessage({ type: 'update', html: overviewBody(data) });
			}
		} catch (error) {
			if (!this.disposed && revision === this.revision) {
				this.fail(error);
			}
		}
	}

	private fail(error: unknown): void {
		this.callbacks.report(error);
		if (!this.disposed) {
			if (this.initialized) {
				void this.panel.webview.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
			} else {
				this.panel.webview.html = `<!DOCTYPE html><html><body><h1>${escape(vscode.l10n.t('Unable to load pull request'))}</h1>
					<p role="alert">${escape(error instanceof Error ? error.message : String(error))}</p>
					<p>${escape(vscode.l10n.t('Click the pull request again to retry.'))}</p></body></html>`;
			}
		}
	}

	private async receive(value: unknown): Promise<void> {
		if (this.disposed) {
			return;
		}
		if (!value || typeof value !== 'object') {
			throw new Error(vscode.l10n.t('Invalid Azure overview message.'));
		}
		const message = value as Record<string, unknown>;
		const data = this.data;
		if (!data || typeof message.action !== 'string') {
			throw new Error(vscode.l10n.t('Refresh the pull request before performing this action.'));
		}
		if (message.action === 'ready') {
			await this.panel.webview.postMessage({ type: 'update', html: overviewBody(data) });
			return;
		}
		if (this.busy) {
			return;
		}
		this.busy = true;
		try {
			const action = actions.find(action => action === message.action);
			if (action) {
				await this.callbacks.action(action);
			} else if (message.action === 'refresh') {
				await this.refresh();
				return;
			} else if (message.action === 'browser') {
				if (!await vscode.env.openExternal(vscode.Uri.parse(data.url))) {
					throw new Error(vscode.l10n.t('VS Code could not open the pull request URL.'));
				}
			} else if (message.action === 'link' && typeof message.url === 'string') {
				const url = new URL(message.url);
				if (url.protocol !== 'https:' || url.username || url.password || !await vscode.env.openExternal(vscode.Uri.parse(url.toString()))) {
					throw new Error(vscode.l10n.t('Only HTTPS links can be opened from the pull request overview.'));
				}
			} else if (message.action === 'file' && typeof message.path === 'string' && data.changes.some(change => change.item.path === message.path && !change.item.isFolder)) {
				await this.callbacks.openFile(message.path);
			} else if (message.action === 'comment' && typeof message.content === 'string' && message.content.trim()
				&& (message.threadId === undefined || data.threads.some(thread => !thread.isDeleted && thread.id === message.threadId))) {
				await this.callbacks.comment(message.content, typeof message.threadId === 'number' ? message.threadId : undefined);
				await this.panel.webview.postMessage({ type: 'commentSaved', key: String(message.threadId ?? 'general') });
			} else if (message.action === 'resolve' && typeof message.resolved === 'boolean'
				&& data.threads.some(thread => !thread.isDeleted && thread.id === message.threadId)) {
				await this.callbacks.changeThread(Number(message.threadId), message.resolved);
			} else if (['editComment', 'deleteComment', 'like'].includes(message.action)
				&& data.threads.some(thread => !thread.isDeleted && thread.id === message.threadId && thread.comments.some(comment => !comment.isDeleted && comment.id === message.commentId))) {
				await this.callbacks.changeComment(Number(message.threadId), Number(message.commentId),
					message.action === 'editComment' ? 'edit' : message.action === 'deleteComment' ? 'delete' : 'like');
			} else if (['editDraft', 'deleteDraft'].includes(message.action) && data.pending?.comments.some(comment => comment.id === message.commentId)) {
				await this.callbacks.changeDraft(Number(message.commentId), message.action === 'deleteDraft');
			} else {
				throw new Error(vscode.l10n.t('Invalid Azure overview action or item. Refresh the pull request.'));
			}
			await this.callbacks.changed();
			await this.refresh();
		} finally {
			this.busy = false;
			if (!this.disposed) {
				await this.panel.webview.postMessage({ type: 'idle' });
			}
		}
	}
}
