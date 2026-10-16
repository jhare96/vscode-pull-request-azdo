/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createSandbox } from 'sinon';
import { AzureClient, PullRequest } from '../../azure/client';
import { completeStack, pullRequestStack } from '../../azure/stack';

function pr(id: number, source: string, target: string): PullRequest {
	return {
		pullRequestId: id, title: String(id), status: 'active', isDraft: false, createdBy: { id: 'user', displayName: 'User' },
		reviewers: [], sourceRefName: `refs/heads/${source}`, targetRefName: `refs/heads/${target}`,
		lastMergeSourceCommit: { commitId: `source-${id}` }, lastMergeTargetCommit: { commitId: 'target' },
		repository: { id: 'repo', name: 'Repo', project: { id: 'project', name: 'Project' } },
	};
}

describe('Azure DevOps branch stacks', () => {
	const sandbox = createSandbox();
	afterEach(() => sandbox.restore());

	it('orders a branch chain from any selected member', () => {
		const members = [pr(3, 'three', 'two'), pr(1, 'one', 'main'), pr(2, 'two', 'one')];
		assert.deepStrictEqual(pullRequestStack(members, 2).map(pr => pr.pullRequestId), [1, 2, 3]);
	});

	it('rejects cycles and ambiguous branch graphs', () => {
		assert.throws(() => pullRequestStack([pr(1, 'one', 'two'), pr(2, 'two', 'one')], 1), /cycle/);
		assert.throws(() => pullRequestStack([pr(1, 'one', 'main'), pr(2, 'two', 'one'), pr(3, 'three', 'one')], 1), /multiple/);
	});

	it('does not connect branches across repositories, forks, or inactive PRs', () => {
		const fork = { ...pr(2, 'two', 'one'), forkSource: { repository: pr(2, 'two', 'one').repository } };
		const other = { ...pr(3, 'three', 'one'), repository: { ...pr(3, 'three', 'one').repository, id: 'other' } };
		const completed: PullRequest = { ...pr(4, 'four', 'one'), status: 'completed' };
		assert.strictEqual(pullRequestStack([pr(1, 'one', 'main'), fork, other, completed], 1).length, 1);
		assert.throws(() => pullRequestStack([fork], 2), /non-fork/);
	});

	it('waits for each merge before retargeting and completing the next member', async () => {
		const first = pr(1, 'one', 'main');
		const second = pr(2, 'two', 'one');
		const retargeted = { ...second, targetRefName: 'refs/heads/main' };
		const client = new AzureClient({ organizationUrl: 'https://dev.azure.com/org', project: 'Project', repository: 'Repo' }, async () => '');
		const current = sandbox.stub(client, 'pullRequest');
		current.onCall(0).resolves(first);
		current.onCall(1).resolves({ ...first, status: 'completed' });
		current.onCall(2).resolves(second);
		current.onCall(3).resolves(retargeted);
		current.onCall(4).resolves({ ...retargeted, status: 'completed' });
		const update = sandbox.stub(client, 'updatePullRequest').resolves(retargeted);
		const complete = sandbox.stub(client, 'completePullRequest').resolves(first);
		await completeStack(client, [first, second], async () => { });
		assert.deepStrictEqual(update.firstCall.args, [2, { targetRefName: 'refs/heads/main' }]);
		assert.deepStrictEqual(complete.args, [[first, 'noFastForward', false], [retargeted, 'noFastForward', false]]);
		assert.ok(update.firstCall.calledAfter(current.getCall(1)));
	});

	it('stops after a branch-policy failure and leaves later members untouched', async () => {
		const first = pr(1, 'one', 'main');
		const client = new AzureClient({ organizationUrl: 'https://dev.azure.com/org', project: 'Project', repository: 'Repo' }, async () => '');
		const current = sandbox.stub(client, 'pullRequest');
		current.onFirstCall().resolves(first);
		current.onSecondCall().resolves({ ...first, mergeStatus: 'rejectedByPolicy' });
		const complete = sandbox.stub(client, 'completePullRequest').resolves(first);
		const update = sandbox.stub(client, 'updatePullRequest');
		await assert.rejects(completeStack(client, [first, pr(2, 'two', 'one')], async () => { }), /rejectedByPolicy/);
		assert.strictEqual(complete.calledOnce, true);
		assert.strictEqual(update.called, false);
	});

	it('refuses to merge a source commit that changed since confirmation', async () => {
		const first = pr(1, 'one', 'main');
		const client = new AzureClient({ organizationUrl: 'https://dev.azure.com/org', project: 'Project', repository: 'Repo' }, async () => '');
		sandbox.stub(client, 'pullRequest').resolves({ ...first, lastMergeSourceCommit: { commitId: 'updated' } });
		const complete = sandbox.stub(client, 'completePullRequest');
		await assert.rejects(completeStack(client, [first], async () => { }), /changed/);
		assert.strictEqual(complete.called, false);
	});
});
