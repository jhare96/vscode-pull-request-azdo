/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { createSandbox, SinonSandbox } from 'sinon';
import * as vscode from 'vscode';
import { AzureClient } from '../../azure/client';
import { azureToolNames, registerAzureTools, ToolRepository } from '../../azure/tools';

describe('Azure DevOps language model tools', () => {
	let sandbox: SinonSandbox;
	let tools: Map<string, vscode.LanguageModelTool<unknown>>;
	let repositories: ToolRepository[];
	let client: AzureClient;
	const source = new vscode.CancellationTokenSource();

	beforeEach(() => {
		sandbox = createSandbox();
		tools = new Map();
		client = new AzureClient({ organizationUrl: 'https://dev.azure.com/org', project: 'Project', repository: 'Repo' }, async () => '');
		repositories = [{ client, branch: 'topic' }];
		sandbox.stub(vscode.lm, 'registerTool').callsFake((name, tool) => {
			tools.set(name, tool);
			return { dispose() { } };
		});
		registerAzureTools(() => repositories, async () => []);
	});
	afterEach(() => sandbox.restore());
	after(() => source.dispose());

	async function invoke(name: string, input: unknown) {
		return tools.get(`azure-devops_${name}`)!.invoke({ input, toolInvocationToken: undefined }, source.token);
	}

	it('registers the Azure counterparts of all repository chat tools', () => {
		assert.strictEqual(tools.size, azureToolNames.length);
		assert.ok([...tools.keys()].every(name => name.startsWith('azure-devops_')));
	});

	it('requires confirmation for writes but not repository reads', async () => {
		const create = await tools.get('azure-devops_create_pull_request')!.prepareInvocation!({ input: { title: 'Title' } }, source.token);
		const resolve = await tools.get('azure-devops_resolve_review_thread')!.prepareInvocation!({ input: { id: 42, threadId: 3 } }, source.token);
		const read = await tools.get('azure-devops_work_item_fetch')!.prepareInvocation!({ input: { id: 12 } }, source.token);
		assert.ok(create?.confirmationMessages);
		assert.ok(resolve?.confirmationMessages);
		assert.strictEqual(read?.confirmationMessages, undefined);
	});

	it('does not send credentials to a model-supplied, undiscovered organization', async () => {
		const read = sandbox.stub(client, 'workItem');
		await assert.rejects(async () => invoke('work_item_fetch', { organizationUrl: 'https://attacker.example', id: 12 }), /discovered/);
		assert.strictEqual(read.called, false);
	});

	it('requires explicit repository disambiguation for multi-root workspaces', async () => {
		repositories.push({ client: new AzureClient({ ...client.remote, repository: 'Other' }, async () => '') });
		await assert.rejects(async () => invoke('work_item_fetch', { id: 12 }), /Specify one/);
		const item = { id: 12, fields: { 'System.Title': 'Title', 'System.State': 'Active', 'System.WorkItemType': 'Task' } };
		sandbox.stub(client, 'workItem').resolves(item);
		sandbox.stub(client, 'workItemComments').resolves([]);
		const result = await invoke('work_item_fetch', { repository: 'Repo', id: 12 });
		const text = result?.content[0];
		assert.ok(text instanceof vscode.LanguageModelTextPart);
		assert.deepStrictEqual(JSON.parse(text.value), { workItem: item, comments: [] });
	});

	it('rejects invalid IDs before making a request', async () => {
		const read = sandbox.stub(client, 'workItem');
		for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
			await assert.rejects(async () => invoke('work_item_fetch', { id }), /positive/);
		}
		assert.strictEqual(read.called, false);
	});

	it('propagates API failures instead of returning successful-looking empty data', async () => {
		sandbox.stub(client, 'workItem').rejects(new Error('HTTP 403'));
		await assert.rejects(async () => invoke('work_item_fetch', { id: 12 }), /403/);
	});

	it('resolves the requested Azure thread without changing another pull request', async () => {
		const resolve = sandbox.stub(client, 'resolveThread').resolves({ id: 3, status: 'fixed', comments: [] });
		await invoke('resolve_review_thread', { id: 42, threadId: 3 });
		assert.deepStrictEqual(resolve.firstCall.args, [42, 3, true]);
	});

	it('rejects incomplete creation requests before changing the server', async () => {
		const create = sandbox.stub(client, 'createPullRequest');
		await assert.rejects(async () => invoke('create_pull_request', { title: 'Title', source: 'topic' }), /target branch/);
		assert.strictEqual(create.called, false);
	});
});
