/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

interface OverviewApi {
	postMessage(message: unknown): void;
	getState(): { drafts?: Record<string, string> } | undefined;
	setState(state: { drafts: Record<string, string> }): void;
}

export function initializeOverview(root: Document, api: OverviewApi): () => void {
	const view = root.defaultView!;
	const drafts = { ...api.getState()?.drafts };
	const overview = root.getElementById('overview')!;
	const error = root.getElementById('error')!;
	const progress = root.getElementById('progress')!;
	let busy = false;
	const restore = () => {
		for (const textarea of root.querySelectorAll<HTMLTextAreaElement>('textarea[data-draft]')) {
			textarea.value = drafts[textarea.dataset.draft!] ?? '';
		}
	};
	const setBusy = (value: boolean) => {
		busy = value;
		progress.hidden = !value;
		overview.setAttribute('aria-busy', String(value));
		for (const control of overview.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>('button, textarea')) {
			control.disabled = value;
		}
	};
	const send = (message: unknown) => {
		if (!busy) {
			error.hidden = true;
			setBusy(true);
			api.postMessage(message);
		}
	};
	const onInput = (event: Event) => {
		const target = event.target;
		if (target instanceof view.HTMLTextAreaElement && target.dataset.draft) {
			drafts[target.dataset.draft] = target.value;
			api.setState({ drafts });
		}
	};
	const onClick = (event: Event) => {
		const target = event.target instanceof view.Element ? event.target : undefined;
		const link = target?.closest('a');
		if (link) {
			event.preventDefault();
			send({ action: 'link', url: link.href });
			return;
		}
		const button = target?.closest<HTMLButtonElement>('button[data-action]');
		if (button) {
			send({
				action: button.dataset.action, path: button.dataset.path,
				threadId: button.dataset.thread ? Number(button.dataset.thread) : undefined,
				commentId: button.dataset.comment ? Number(button.dataset.comment) : undefined,
				resolved: button.dataset.resolved === 'true',
			});
		}
	};
	const onSubmit = (event: Event) => {
		event.preventDefault();
		const form = event.target;
		if (form instanceof view.HTMLFormElement && form.matches('[data-comment]')) {
			const textarea = form.querySelector<HTMLTextAreaElement>('textarea')!;
			if (textarea.value.trim()) {
				send({ action: 'comment', content: textarea.value, threadId: form.dataset.thread ? Number(form.dataset.thread) : undefined });
			}
		}
	};
	const onMessage = (event: MessageEvent) => {
		const message = event.data;
		if (message.type === 'update' && typeof message.html === 'string') {
			overview.innerHTML = message.html;
			restore();
			setBusy(busy);
		} else if (message.type === 'error' && typeof message.message === 'string') {
			error.textContent = message.message;
			error.hidden = false;
			setBusy(false);
		} else if (message.type === 'commentSaved' && typeof message.key === 'string') {
			delete drafts[message.key];
			api.setState({ drafts });
			restore();
		} else if (message.type === 'idle') {
			setBusy(false);
		}
	};
	root.addEventListener('input', onInput);
	root.addEventListener('click', onClick);
	root.addEventListener('submit', onSubmit);
	view.addEventListener('message', onMessage);
	restore();
	api.postMessage({ action: 'ready' });
	return () => {
		root.removeEventListener('input', onInput);
		root.removeEventListener('click', onClick);
		root.removeEventListener('submit', onSubmit);
		view.removeEventListener('message', onMessage);
	};
}
