/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AzureClient, PullRequest } from './client';

export function pullRequestStack(pullRequests: readonly PullRequest[], selected: number): PullRequest[] {
	const current = pullRequests.find(pr => pr.pullRequestId === selected);
	if (!current || current.status !== 'active' || current.forkSource) {
		throw new Error('Select an active, non-fork pull request to navigate its branch stack.');
	}
	const eligible = pullRequests.filter(pr => pr.status === 'active' && !pr.forkSource && pr.repository.id === current.repository.id);
	const stack: PullRequest[] = [current];
	const seen = new Set([current.pullRequestId]);
	for (const direction of ['parent', 'child'] as const) {
		let cursor = current;
		while (true) {
			const from = cursor;
			const candidates = eligible.filter(pr => pr.pullRequestId !== from.pullRequestId && (direction === 'parent'
				? pr.sourceRefName === from.targetRefName : pr.targetRefName === from.sourceRefName));
			if (candidates.length > 1) {
				throw new Error('The branch graph contains multiple possible stack members. Retarget the pull requests into a single chain.');
			}
			const next = candidates[0];
			if (!next) {
				break;
			}
			if (seen.has(next.pullRequestId)) {
				throw new Error('The pull request branch graph contains a cycle.');
			}
			seen.add(next.pullRequestId);
			if (direction === 'parent') {
				stack.unshift(next);
			} else {
				stack.push(next);
			}
			cursor = next;
		}
	}
	return stack;
}

export async function completeStack(client: AzureClient, stack: readonly PullRequest[], wait: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 1000))): Promise<void> {
	if (!stack.length) {
		throw new Error('The stack is empty.');
	}
	const ordered = pullRequestStack(stack, stack[0].pullRequestId);
	if (ordered.length !== stack.length || ordered.some((pr, index) => pr.pullRequestId !== stack[index].pullRequestId)) {
		throw new Error('The stack must be supplied in bottom-to-top branch order.');
	}
	const target = stack[0].targetRefName;
	for (const expected of stack) {
		let current = await client.pullRequest(expected.pullRequestId);
		if (current.status !== 'active' || current.sourceRefName !== expected.sourceRefName
			|| current.targetRefName !== expected.targetRefName || current.lastMergeSourceCommit.commitId !== expected.lastMergeSourceCommit.commitId) {
			throw new Error(`Pull request !${expected.pullRequestId} changed. Refresh the stack before continuing. Already completed members remain completed.`);
		}
		if (current.isDraft) {
			throw new Error(`Publish draft pull request !${current.pullRequestId} before completing the stack.`);
		}
		if (current.targetRefName !== target) {
			await client.updatePullRequest(current.pullRequestId, { targetRefName: target });
			current = await client.pullRequest(current.pullRequestId);
			if (current.targetRefName !== target || current.lastMergeSourceCommit?.commitId !== expected.lastMergeSourceCommit.commitId) {
				throw new Error(`Pull request !${current.pullRequestId} changed while retargeting. Refresh the stack.`);
			}
		}
		await client.completePullRequest(current, 'noFastForward', false);
		let completed = false;
		for (let attempt = 0; attempt < 120; attempt++) {
			current = await client.pullRequest(current.pullRequestId);
			if (current.status === 'completed') {
				completed = true;
				break;
			}
			if (current.status !== 'active' || ['conflicts', 'rejectedByPolicy', 'failure'].includes(current.mergeStatus ?? '')) {
				throw new Error(`Pull request !${current.pullRequestId} could not be completed (${current.mergeStatus ?? current.status}). Remaining members were not merged.`);
			}
			await wait();
		}
		if (!completed) {
			throw new Error(`Completion of pull request !${current.pullRequestId} is still pending. Refresh before retrying; remaining members were not merged.`);
		}
	}
}
