/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AzureClient } from './client';

export interface ToolRepository {
	client: AzureClient;
	branch?: string;
}

interface ToolInput {
	repository?: string;
	project?: string;
	organizationUrl?: string;
	id?: number;
	threadId?: number;
	query?: string;
	title?: string;
	description?: string;
	source?: string;
	target?: string;
	draft?: boolean;
	path?: string;
}

export const azureToolNames = [
	'active_pull_request', 'open_pull_request', 'pull_request_fetch', 'pull_request_checks',
	'create_pull_request', 'resolve_review_thread', 'work_item_fetch', 'labels_fetch', 'notifications_fetch', 'search',
] as const;

export function registerAzureTools(repositories: () => ToolRepository[], notifications: (repository: ToolRepository) => Promise<unknown>): vscode.Disposable[] {
	if (!vscode.lm?.registerTool) {
		return [];
	}
	return azureToolNames.map(name => vscode.lm.registerTool<ToolInput>(`azure-devops_${name}`, {
		prepareInvocation: options => ({
			invocationMessage: vscode.l10n.t('Azure DevOps: {0}', name),
			confirmationMessages: name === 'create_pull_request' || name === 'resolve_review_thread'
				? { title: vscode.l10n.t('Modify Azure DevOps'), message: new vscode.MarkdownString().appendText(JSON.stringify(options.input)) } : undefined,
		}),
		invoke: async (options, token) => {
			if (token.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			const input = options.input;
			const candidates = repositories().filter(repository =>
				(!input.repository || repository.client.remote.repository.toLowerCase() === input.repository.toLowerCase())
				&& (!input.project || repository.client.remote.project.toLowerCase() === input.project.toLowerCase())
				&& (!input.organizationUrl || repository.client.remote.organizationUrl.toLowerCase() === input.organizationUrl.replace(/\/$/, '').toLowerCase()));
			if (candidates.length !== 1) {
				throw new Error('Specify one discovered Azure DevOps repository, project, and organization. Arbitrary remote URLs are not accepted.');
			}
			const repository = candidates[0];
			const { client } = repository;
			const id = () => {
				if (!Number.isSafeInteger(input.id) || input.id! <= 0) {
					throw new Error('A positive work item or pull request ID is required.');
				}
				return input.id!;
			};
			let result: unknown;
			switch (name) {
				case 'active_pull_request':
					result = repository.branch ? await client.pullRequests('active', { 'searchCriteria.sourceRefName': `refs/heads/${repository.branch}` }) : [];
					break;
				case 'open_pull_request':
					if (!await vscode.env.openExternal(vscode.Uri.parse(client.pullRequestUrl(id())))) {
						throw new Error('VS Code could not open the pull request URL.');
					}
					result = { url: client.pullRequestUrl(id()) };
					break;
				case 'pull_request_fetch':
					result = await client.reviewDetails(id(), input.path);
					break;
				case 'pull_request_checks': {
					const pr = await client.pullRequest(id());
					result = { statuses: await client.statuses(id()), policies: await client.policies(pr) };
					break;
				}
				case 'create_pull_request':
					if (!input.title?.trim() || !input.source?.trim() || !input.target?.trim()) {
						throw new Error('Title, source branch, and target branch are required. Publish the source branch before creating a pull request.');
					}
					result = await client.createPullRequest(input.title, input.description ?? '',
						input.source.startsWith('refs/heads/') ? input.source : `refs/heads/${input.source}`,
						input.target.startsWith('refs/heads/') ? input.target : `refs/heads/${input.target}`, input.draft ?? false);
					break;
				case 'resolve_review_thread':
					if (!Number.isSafeInteger(input.threadId) || input.threadId! <= 0) {
						throw new Error('A positive thread ID is required.');
					}
					result = await client.resolveThread(id(), input.threadId!, true);
					break;
				case 'work_item_fetch':
					result = { workItem: await client.workItem(id()), comments: await client.workItemComments(id()) };
					break;
				case 'labels_fetch':
					result = await client.labels(id());
					break;
				case 'notifications_fetch':
					result = await notifications(repository);
					break;
				case 'search':
					if (!input.query?.trim()) {
						throw new Error('Supply a WIQL query to search Azure Boards work items.');
					}
					result = await client.workItems(input.query);
					break;
			}
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(result))]);
		},
	}));
}
