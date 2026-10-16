/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { spy } from 'sinon';
import { initializeOverview } from '../overview';

describe('Azure PR overview browser interactions', () => {
	const body = `<form data-comment><label>Comment<textarea data-draft="general" name="content"></textarea></label><button type="submit">Comment</button></form>
		<button data-action="file" data-path="/file.ts">File</button>
		<button data-action="resolve" data-thread="9" data-resolved="true">Resolve</button>`;
	let state: { drafts: Record<string, string> };
	let post: ReturnType<typeof spy>;
	let dispose: () => void;
	let frame: HTMLIFrameElement;
	let root: Document;
	let view: Window & typeof globalThis;

	beforeEach(() => {
		frame = document.createElement('iframe');
		document.body.appendChild(frame);
		root = frame.contentDocument!;
		view = root.defaultView!;
		root.body.innerHTML = `<p id="error" hidden></p><p id="progress" hidden></p><div id="overview">${body}</div>`;
		state = { drafts: { general: 'Saved draft' } };
		post = spy();
		dispose = initializeOverview(root, { postMessage: post, getState: () => state, setState: value => { state = value; } });
		assert.ok(post.calledWithExactly({ action: 'ready' }));
		post.resetHistory();
	});
	afterEach(() => {
		dispose();
		frame.remove();
	});

	it('restores and persists in-progress comments without publishing on input', () => {
		const textarea = root.querySelector('textarea')!;
		assert.strictEqual(textarea.value, 'Saved draft');
		textarea.value = 'Edited draft';
		textarea.dispatchEvent(new view.Event('input', { bubbles: true }));
		assert.strictEqual(state.drafts.general, 'Edited draft');
		assert.ok(post.notCalled);
	});

	it('submits comments once and preserves text on failures', () => {
		const form = root.querySelector('form')!;
		form.dispatchEvent(new view.Event('submit', { bubbles: true, cancelable: true }));
		form.dispatchEvent(new view.Event('submit', { bubbles: true, cancelable: true }));
		assert.ok(post.calledOnce);
		assert.strictEqual(root.querySelector('textarea')!.disabled, true);
		assert.deepStrictEqual(post.firstCall.args[0], { action: 'comment', content: 'Saved draft', threadId: undefined });
		view.dispatchEvent(new view.MessageEvent('message', { data: { type: 'error', message: 'HTTP 403' } }));
		assert.strictEqual(root.querySelector('textarea')!.value, 'Saved draft');
		assert.strictEqual(root.getElementById('error')!.textContent, 'HTTP 403');
		assert.strictEqual(root.querySelector('button')!.disabled, false);
		assert.strictEqual(root.querySelector('textarea')!.disabled, false);
	});

	it('clears only acknowledged drafts and preserves other input across HTML refreshes', () => {
		view.dispatchEvent(new view.MessageEvent('message', { data: { type: 'update', html: body } }));
		assert.strictEqual(root.querySelector('textarea')!.value, 'Saved draft');
		view.dispatchEvent(new view.MessageEvent('message', { data: { type: 'commentSaved', key: 'general' } }));
		assert.strictEqual(root.querySelector('textarea')!.value, '');
		assert.deepStrictEqual(state.drafts, {});
	});

	it('sends file and thread actions through the extension bridge', () => {
		root.querySelector<HTMLButtonElement>('[data-action="file"]')!.click();
		assert.ok(post.calledWithMatch({ action: 'file', path: '/file.ts' }));
		view.dispatchEvent(new view.MessageEvent('message', { data: { type: 'idle' } }));
		root.querySelector<HTMLButtonElement>('[data-action="resolve"]')!.click();
		assert.ok(post.calledWithMatch({ action: 'resolve', threadId: 9, resolved: true }));
	});
});
