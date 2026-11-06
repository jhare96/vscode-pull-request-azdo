/*---------------------------------------------------------------------------------------------
 *  Copyright (c) jhare96. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import React from 'react';
import { act, cleanup, fireEvent, render, wait, waitForElement } from 'react-testing-library';
import { createSandbox, SinonSandbox } from 'sinon';
import PullRequestContext, { PRContext } from '../../common/context';
import { PullRequestBuilder } from '../../editorWebview/test/builder/pullRequest';
import { CheckoutButton } from '../app';

describe('Azure overview checkout', () => {
	let sandbox: SinonSandbox;

	beforeEach(() => {
		sandbox = createSandbox();
	});

	afterEach(() => {
		cleanup();
		sandbox.restore();
	});

	it('checks out in the current window from the main button and stays disabled until complete', async () => {
		const pr = new PullRequestBuilder().isCurrentlyCheckedOut(false).build();
		const context = new PRContext(pr);
		let finishCheckout: () => void;
		const checkout = sandbox.stub(context, 'checkout').returns(new Promise<void>(resolve => { finishCheckout = resolve; }));
		const postMessage = sandbox.stub(context, 'postMessage').resolves();
		const out = render(
			<PullRequestContext.Provider value={context}>
				<CheckoutButton pr={pr} />
			</PullRequestContext.Provider>,
		);
		const button = out.getByText('Checkout').closest('button')!;
		fireEvent.click(button);
		assert.ok(checkout.calledOnce);
		assert.ok(postMessage.notCalled);
		assert.strictEqual(button.getAttribute('aria-disabled'), 'true');
		fireEvent.click(button);
		assert.ok(checkout.calledOnce);
		act(() => { finishCheckout(); });
		await wait(() => assert.notStrictEqual(button.getAttribute('aria-disabled'), 'true'));
	});

	it('creates a worktree only when explicitly selected from the dropdown', async () => {
		const pr = new PullRequestBuilder().isCurrentlyCheckedOut(false).build();
		const context = new PRContext(pr);
		const checkout = sandbox.stub(context, 'checkout').resolves();
		const postMessage = sandbox.stub(context, 'postMessage').resolves();
		const out = render(
			<PullRequestContext.Provider value={context}>
				<CheckoutButton pr={pr} />
			</PullRequestContext.Provider>,
		);
		fireEvent.click(out.getByLabelText('More checkout options'));
		const worktree = await waitForElement(() => out.getByText('Checkout in new worktree'));
		fireEvent.click(worktree);
		await wait(() => assert.ok(postMessage.calledOnceWithExactly({ command: 'azdo.pr.checkout-worktree' })));
		assert.ok(checkout.notCalled);
	});

	it('returns to the default branch when the PR is already checked out', async () => {
		const pr = new PullRequestBuilder().isCurrentlyCheckedOut(true).doneCheckoutBranch('main').build();
		const context = new PRContext(pr);
		const exit = sandbox.stub(context, 'exitReviewMode').resolves();
		const checkout = sandbox.stub(context, 'checkout').resolves();
		const postMessage = sandbox.stub(context, 'postMessage').resolves();
		const out = render(
			<PullRequestContext.Provider value={context}>
				<CheckoutButton pr={pr} />
			</PullRequestContext.Provider>,
		);
		fireEvent.click(out.getByText("Checkout 'main'"));
		await wait(() => assert.ok(exit.calledOnce));
		assert.ok(checkout.notCalled);
		assert.ok(postMessage.notCalled);
	});
});
